use super::*;

#[tauri::command]
pub async fn begin_epub_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request_id: String,
) -> Result<BeginImportResult, PlatformError> {
    let (session_id, destination) = state.imports()?.prepare_destination(&request_id)?;
    let selection = match select_epub_on_platform(&app, &request_id, &destination) {
        Ok(selection) => selection,
        Err(error) => {
            if let Some(root) = destination.parent() {
                let _ = fs::remove_dir_all(root);
            }
            return Err(error);
        }
    };
    if selection.cancelled {
        if let Some(root) = destination.parent() {
            let _ = fs::remove_dir_all(root);
        }
        return Ok(BeginImportResult::Cancelled);
    }
    let display_name = selection
        .display_name
        .unwrap_or_else(|| "publication.epub".into());
    let (hash, bytes, entries) = {
        let mut imports = state.imports()?;
        let session = imports.register(
            session_id.clone(),
            request_id,
            display_name.clone(),
            destination,
        )?;
        (
            session.content_hash.clone(),
            session.bytes,
            session.entries(),
        )
    };
    Ok(BeginImportResult::Ready {
        session_id,
        display_name,
        bytes,
        content_hash: hash,
        entries,
    })
}

#[tauri::command]
pub fn read_epub_text_entry(
    state: tauri::State<'_, PlatformState>,
    session_id: String,
    archive_path: String,
) -> Result<String, PlatformError> {
    state
        .imports()?
        .session(&session_id)?
        .read_text(&archive_path)
}

#[tauri::command]
pub fn commit_epub_import(
    state: tauri::State<'_, PlatformState>,
    session_id: String,
    parsed_plan: ParsedPublicationPlan,
) -> Result<mobile_reading::ImportResult, PlatformError> {
    commit_epub_session(&state, session_id, parsed_plan)
}

fn commit_epub_session(
    state: &PlatformState,
    session_id: String,
    mut parsed_plan: ParsedPublicationPlan,
) -> Result<mobile_reading::ImportResult, PlatformError> {
    let session = state.imports()?.take_for_commit(&session_id)?;
    let result = (|| {
        let existing = {
            let database = state.database()?;
            mobile_reading::find_publication_by_hash(&database, &session.content_hash)?
        };
        if let Some(publication_id) = existing {
            if publication_id != parsed_plan.id {
                return Err(PlatformError::new(
                    "importConflict",
                    "刊物身份不一致。",
                    false,
                ));
            }
            session.extract_assets(&mut parsed_plan)?;
            crate::publication_repair::copy_missing_assets(
                &session.root.join("assets"),
                &state
                    .paths
                    .data
                    .join("library")
                    .join(&publication_id)
                    .join("assets"),
                &parsed_plan.asset_paths,
            )?;
            let database = state.database()?;
            let repaired = crate::publication_repair::repair(&database, &parsed_plan)?;
            return Ok(mobile_reading::ImportResult {
                publication: mobile_reading::get_publication(&database, &publication_id)?,
                duplicate: true,
                repaired,
            });
        }
        let library_root = state.paths.data.join("library");
        fs::create_dir_all(&library_root).map_err(|_| PlatformError::storage_unavailable())?;
        let final_root = library_root.join(&parsed_plan.id);
        if final_root.exists() {
            return Err(PlatformError::new(
                "importConflict",
                "刊物身份已存在但内容不同。",
                false,
            ));
        }
        session.extract_assets(&mut parsed_plan)?;
        fs::remove_file(&session.source).map_err(|_| PlatformError::storage_unavailable())?;
        let published = std::cell::Cell::new(false);
        let commit = {
            let mut database = state.database()?;
            mobile_reading::commit_publication(&mut database, &parsed_plan, "epub", || {
                fs::rename(&session.root, &final_root)
                    .map_err(|_| PlatformError::storage_unavailable())?;
                published.set(true);
                Ok(())
            })
        };
        if let Err(error) = commit {
            if published.get() {
                let _ = fs::remove_dir_all(&final_root);
            }
            return Err(error);
        }
        let publication = {
            let database = state.database()?;
            mobile_reading::get_publication(&database, &parsed_plan.id)?
        };
        Ok(mobile_reading::ImportResult {
            publication,
            duplicate: false,
            repaired: false,
        })
    })();
    epub_import::cleanup_session(&session);
    state.imports()?.finish_commit(&session_id);
    result
}

#[tauri::command]
pub fn cancel_epub_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request_or_session_id: String,
) -> Result<(), PlatformError> {
    #[cfg(target_os = "android")]
    {
        use fpr_platform_plugin::FoundationExt;
        let _ = app.foundation().cancel_epub_import(&request_or_session_id);
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    state.imports()?.cancel(&request_or_session_id)
}

#[tauri::command]
pub fn list_mobile_publications(
    state: tauri::State<'_, PlatformState>,
) -> Result<Vec<mobile_reading::PublicationSummary>, PlatformError> {
    let database = state.database()?;
    mobile_reading::list_publications(&database)
}

#[tauri::command]
pub fn get_mobile_library_state(
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_reading::LibraryState, PlatformError> {
    let database = state.database()?;
    mobile_reading::get_library_state(&database)
}

#[tauri::command]
pub fn save_mobile_library_preferences(
    state: tauri::State<'_, PlatformState>,
    preferences: mobile_reading::LibraryPreferences,
) -> Result<mobile_reading::LibraryState, PlatformError> {
    let database = state.database()?;
    mobile_reading::save_library_preferences(&database, preferences)
}

#[tauri::command]
pub fn create_mobile_library_category(
    state: tauri::State<'_, PlatformState>,
    name: String,
) -> Result<mobile_reading::LibraryState, PlatformError> {
    let database = state.database()?;
    mobile_reading::create_category(&database, &name)
}

#[tauri::command]
pub fn rename_mobile_library_category(
    state: tauri::State<'_, PlatformState>,
    category_id: String,
    name: String,
) -> Result<mobile_reading::LibraryState, PlatformError> {
    let database = state.database()?;
    mobile_reading::rename_category(&database, &category_id, &name)
}

#[tauri::command]
pub fn delete_mobile_library_category(
    state: tauri::State<'_, PlatformState>,
    category_id: String,
) -> Result<mobile_reading::LibraryState, PlatformError> {
    let database = state.database()?;
    mobile_reading::delete_category(&database, &category_id)
}

#[tauri::command]
pub fn rename_mobile_publication(
    state: tauri::State<'_, PlatformState>,
    publication_id: String,
    title: String,
) -> Result<mobile_reading::LibraryState, PlatformError> {
    let database = state.database()?;
    mobile_reading::rename_publication(&database, &publication_id, &title)
}

#[tauri::command]
pub fn assign_mobile_publications(
    state: tauri::State<'_, PlatformState>,
    publication_ids: Vec<String>,
    category_id: Option<String>,
) -> Result<mobile_reading::LibraryState, PlatformError> {
    let database = state.database()?;
    mobile_reading::assign_publications(&database, publication_ids, category_id)
}

#[tauri::command]
pub fn delete_mobile_publications(
    state: tauri::State<'_, PlatformState>,
    publication_ids: Vec<String>,
) -> Result<mobile_reading::LibraryState, PlatformError> {
    let library_root = state.paths.data.join("library");
    let mut database = state.database()?;
    mobile_reading::delete_publications(&mut database, &library_root, publication_ids)
}

#[tauri::command]
pub fn get_mobile_publication(
    state: tauri::State<'_, PlatformState>,
    publication_id: String,
) -> Result<mobile_reading::PublicationDetail, PlatformError> {
    let database = state.database()?;
    mobile_reading::get_publication(&database, &publication_id)
}

#[tauri::command]
pub fn get_mobile_article(
    state: tauri::State<'_, PlatformState>,
    article_id: String,
) -> Result<mobile_reading::ArticleDetail, PlatformError> {
    let database = state.database()?;
    mobile_reading::get_article(&database, &article_id)
}

#[tauri::command]
pub fn save_mobile_reading_position(
    state: tauri::State<'_, PlatformState>,
    publication_id: String,
    article_id: String,
    position: ReadingPosition,
) -> Result<(), PlatformError> {
    let database = state.database()?;
    mobile_reading::save_position(&database, &publication_id, &article_id, position)
}

#[tauri::command]
pub fn get_mobile_reader_preferences(
    state: tauri::State<'_, PlatformState>,
) -> Result<ReaderPreferences, PlatformError> {
    let database = state.database()?;
    mobile_reading::get_preferences(&database)
}

#[tauri::command]
pub fn save_mobile_reader_preferences(
    state: tauri::State<'_, PlatformState>,
    preferences: ReaderPreferences,
) -> Result<ReaderPreferences, PlatformError> {
    let database = state.database()?;
    mobile_reading::save_preferences(&database, preferences)
}

#[tauri::command]
pub fn reader_search_articles(
    state: tauri::State<'_, PlatformState>,
    query: serde_json::Value,
) -> Result<serde_json::Value, PlatformError> {
    crate::reader_records::search(&*state.database()?, &query)
}
#[tauri::command]
pub fn reader_get_data(
    state: tauri::State<'_, PlatformState>,
    article_id: String,
) -> Result<serde_json::Value, PlatformError> {
    crate::reader_records::get(&*state.database()?, &article_id)
}
#[tauri::command]
pub fn reader_change_data(
    state: tauri::State<'_, PlatformState>,
    article_id: String,
    change: serde_json::Value,
) -> Result<serde_json::Value, PlatformError> {
    crate::reader_records::change(&*state.database()?, &article_id, &change)
}
