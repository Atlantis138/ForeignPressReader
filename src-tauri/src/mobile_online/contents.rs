use super::*;
use crate::mobile_reading::PublicationDetail;
use std::{collections::BTreeMap, fs, path::Path};

pub type Translations = BTreeMap<String, String>;
pub const DIRECTORY: &str = "contents-translations";
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

fn segments(publication: &PublicationDetail) -> Vec<SourceSegment> {
    let mut result = Vec::new();
    let mut add = |id: String, kind: &str, text: &str| {
        if !text.trim().is_empty() {
            result.push(SourceSegment {
                id,
                kind: kind.into(),
                text: text.into(),
                source_hash: String::new(),
            });
        }
    };
    for section in &publication.sections {
        add(section.id.clone(), "heading", &section.title);
    }
    for article in publication.unsectioned_articles.iter().chain(
        publication
            .sections
            .iter()
            .flat_map(|section| &section.articles),
    ) {
        add(article.id.clone(), "title", &article.title);
        if let Some(rubric) = &article.rubric {
            add(format!("{}:rubric", article.id), "rubric", rubric);
        }
    }
    result
}

fn cache_key(
    id: &str,
    title: &str,
    preferences: &TranslationPreferences,
    segments: &[SourceSegment],
) -> String {
    sha256(
        &json!([
            1,
            id,
            title,
            preferences.provider_id,
            preferences.model_id,
            TRANSLATION_PROMPT_VERSION,
            segments
                .iter()
                .map(|segment| json!([segment.id, segment.kind, segment.text]))
                .collect::<Vec<_>>()
        ])
        .to_string(),
    )
}

fn read(directory: &Path, key: &str) -> Translations {
    let file = directory.join(format!("{key}.json"));
    if fs::metadata(&file)
        .map(|metadata| metadata.len() > MAX_ENTRY_BYTES)
        .unwrap_or(true)
    {
        return Translations::new();
    }
    fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Translations>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, text)| !text.trim().is_empty())
        .collect()
}

fn write(directory: &Path, key: &str, translations: &Translations) -> Result<(), PlatformError> {
    let bytes =
        serde_json::to_vec(translations).map_err(|_| PlatformError::storage_unavailable())?;
    if bytes.len() as u64 > MAX_ENTRY_BYTES {
        return Err(PlatformError::new(
            "cacheTooLarge",
            "目录译文超过缓存大小限制。",
            false,
        ));
    }
    let file = directory.join(format!("{key}.json"));
    crate::atomic_file::atomic_replace(&file, &bytes)?;
    let mut entries = fs::read_dir(directory)
        .map_err(|_| PlatformError::storage_unavailable())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .map(|metadata| (entry.path(), metadata))
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|(_, metadata)| metadata.modified().ok());
    let mut total: u64 = entries.iter().map(|(_, metadata)| metadata.len()).sum();
    for (path, metadata) in entries {
        if total <= MAX_BYTES {
            break;
        }
        if path == file {
            continue;
        }
        fs::remove_file(path).map_err(|_| PlatformError::storage_unavailable())?;
        total = total.saturating_sub(metadata.len());
    }
    Ok(())
}

pub fn get(state: &PlatformState, id: &str) -> Result<Translations, PlatformError> {
    let database = state.database()?;
    let publication = crate::mobile_reading::get_publication(&database, id)?;
    let preferences = get_preferences(&database)?;
    let key = cache_key(
        id,
        &publication.summary.title,
        &preferences,
        &segments(&publication),
    );
    Ok(read(&state.paths.cache.join(DIRECTORY), &key))
}

pub fn translate(
    app: &AppHandle,
    state: &PlatformState,
    id: &str,
    request_id: &str,
    force: bool,
) -> Result<Translations, PlatformError> {
    let (publication, preferences) = {
        let database = state.database()?;
        (
            crate::mobile_reading::get_publication(&database, id)?,
            get_preferences(&database)?,
        )
    };
    let all = segments(&publication);
    let cache_key = cache_key(id, &publication.summary.title, &preferences, &all);
    let directory = state.paths.cache.join(DIRECTORY);
    let mut result = read(&directory, &cache_key);
    let missing = all
        .iter()
        .filter(|segment| force || !result.contains_key(&segment.id))
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        let key = translation_key(app, &preferences)?;
        TranslationTask {
            app,
            state,
            id,
            request_id,
            key: &key,
            preferences: &preferences,
            title: &publication.summary.title,
            section: Some("刊物目录"),
            total: all.len(),
        }
        .run(missing, |source, text| {
            // Serialize with AI-cache clear and publication removal; a cancelled request cannot resurrect cache.
            let database = state.database()?;
            state.online_runtime().check_translation(id, request_id)?;
            let exists: bool = database
                .connection()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM publications WHERE id=?1)",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|_| PlatformError::database_corrupt())?;
            if !exists {
                return Err(PlatformError::new(
                    "publicationNotFound",
                    "未找到该刊物。",
                    false,
                ));
            }
            result.insert(source.id.clone(), text.into());
            write(&directory, &cache_key, &result)
        })?;
    }
    state.online_runtime().check_translation(id, request_id)?;
    emit_progress(app, id, all.len(), all.len(), "completed", None);
    Ok(result)
}

pub fn clear(directory: &Path) -> Result<(), PlatformError> {
    match fs::remove_dir_all(directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(PlatformError::storage_unavailable()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_windows_identity_and_restores_partial_disk_cache() {
        let vector: Value =
            serde_json::from_str(include_str!("../../../test-vectors/contents-cache-v1.json"))
                .unwrap();
        let preferences: TranslationPreferences =
            serde_json::from_value(vector["preferences"].clone()).unwrap();
        let source = vector["segments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| SourceSegment {
                id: item[0].as_str().unwrap().into(),
                kind: item[1].as_str().unwrap().into(),
                text: item[2].as_str().unwrap().into(),
                source_hash: String::new(),
            })
            .collect::<Vec<_>>();
        let key = cache_key(
            vector["publication"]["id"].as_str().unwrap(),
            vector["publication"]["title"].as_str().unwrap(),
            &preferences,
            &source,
        );
        assert_eq!(key, vector["key"].as_str().unwrap());
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join(DIRECTORY);
        let partial = Translations::from([("section_world".into(), "世界".into())]);
        write(&directory, &key, &partial).unwrap();
        assert_eq!(read(&directory, &key), partial);
        let different = cache_key("changed", "Weekly", &preferences, &source);
        assert!(read(&directory, &different).is_empty());
        for index in 0..12 {
            write(&directory, &format!("{index:064x}"), &partial).unwrap();
        }
        assert_eq!(read(&directory, &key), partial);
        fs::write(directory.join(format!("{key}.json")), b"{broken").unwrap();
        assert!(read(&directory, &key).is_empty());
        write(&directory, &key, &partial).unwrap();
        clear(&directory).unwrap();
        assert!(read(&directory, &key).is_empty());
    }
}
