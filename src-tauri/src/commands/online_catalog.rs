use super::*;
use crate::online_catalog::{self, OnlineCatalog};
use tauri::Manager;

#[tauri::command]
pub async fn get_online_catalog(
    state: tauri::State<'_, PlatformState>,
    refresh: bool,
) -> Result<OnlineCatalog, PlatformError> {
    let _guard = state.catalog_runtime().catalog_lock.lock().await;
    online_catalog::load_catalog(&state.paths, refresh).await
}

#[tauri::command]
pub async fn begin_online_epub_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request_id: String,
    issue_id: String,
) -> Result<BeginImportResult, PlatformError> {
    if !online_catalog::valid_sha(&issue_id) {
        return Err(online_catalog::invalid());
    }
    let token = state.catalog_runtime().begin(&request_id)?;
    let mut temporary = None;
    let result = async {
        let catalog = online_catalog::cancellable(&token, async {
            let _guard = state.catalog_runtime().catalog_lock.lock().await;
            online_catalog::load_catalog(&state.paths, false).await
        }).await?;
        let issue = catalog.issues.iter().find(|i| i.id == issue_id).ok_or_else(online_catalog::invalid)?;
        {
            let db = state.database()?;
            let publications = mobile_reading::list_publications(&db)?;
            if let Some(local) = online_catalog::local_issue(&publications, &issue.date) {
                return Ok(BeginImportResult::Duplicate { result: Box::new(mobile_reading::ImportResult {
                    publication: mobile_reading::get_publication(&db, &local.id)?, duplicate:true, repaired:false,
                }) });
            }
        }
        let (session_id, destination) = state.imports()?.prepare_destination(&request_id)?;
        temporary = destination.parent().map(Path::to_path_buf);
        online_catalog::cancellable(&token, online_catalog::download(&catalog, issue, &destination, |completed,total| {
            let _ = app.emit("online-import-progress", serde_json::json!({"requestId":request_id,"stage":"downloading","completed":completed,"total":total,"message":format!("正在下载 {}",issue.date)}));
        })).await?;
        let handle = app.clone();
        let request = request_id.clone();
        let display_name = format!("TheEconomist.{}.epub", issue.date.replace('-', "."));
        let cancelled = token.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = handle.state::<PlatformState>();
            let mut imports = state.imports()?;
            let session = imports.register(session_id.clone(), request, display_name.clone(), destination)?;
            let result = BeginImportResult::Ready { session_id:session_id.clone(), display_name, bytes:session.bytes, content_hash:session.content_hash.clone(), entries:session.entries() };
            if cancelled.load(Ordering::Acquire) { imports.cancel(&session_id)?; return Ok(BeginImportResult::Cancelled); }
            Ok(result)
        }).await.map_err(|_| PlatformError::storage_unavailable())?
    }.await;
    state.catalog_runtime().finish();
    if !matches!(result, Ok(BeginImportResult::Ready { .. })) {
        if let Some(root) = temporary {
            let _ = fs::remove_dir_all(root);
        }
    }
    result
}
