use super::*;

// Local connection configuration, deliberately excluded from portable/sync allowlists.
const CONFIG_KEY: &str = "local.translation.models";
#[derive(Default, Serialize, Deserialize)]
pub(super) struct ModelConfig {
    pub models: Vec<TranslationPreferences>,
    pub selected: Option<TranslationPreferences>,
}

pub(super) fn require_model_id(value: &str) -> Result<&str, PlatformError> {
    let id = value.trim();
    if id.is_empty()
        || id.len() > 100
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"._:/-".contains(&ch))
    {
        return Err(PlatformError::new(
            "invalidInput",
            "模型名称须为 1–100 个字母、数字或 . _ : / -",
            false,
        ));
    }
    Ok(id)
}

pub(super) fn read(database: &AndroidDatabase) -> Result<ModelConfig, PlatformError> {
    let value: Option<String> = database
        .connection()
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [CONFIG_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    Ok(value
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default())
}

fn write(database: &AndroidDatabase, config: &ModelConfig) -> Result<(), PlatformError> {
    database.connection().execute(
        "INSERT INTO settings(key,value,updated_at,device_id) VALUES(?1,?2,?3,?4) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id",
        params![CONFIG_KEY, serde_json::to_string(config).map_err(|_| PlatformError::storage_unavailable())?, Utc::now().to_rfc3339(), database.device_id()],
    ).map_err(|_| PlatformError::storage_unavailable())?;
    Ok(())
}

pub(super) fn save(
    database: &AndroidDatabase,
    mut value: TranslationPreferences,
) -> Result<TranslationPreferences, PlatformError> {
    value.model_id = require_model_id(&value.model_id)?.into();
    let (provider, _) = resolve(&value)?;
    let custom = !provider
        .models
        .iter()
        .any(|model| model.id == value.model_id);
    let mut config = read(database)?;
    if custom && !config.models.contains(&value) {
        if config.models.len() >= 100 {
            return Err(PlatformError::new(
                "invalidInput",
                "最多保存 100 个自定义模型，请先删除不用的模型",
                false,
            ));
        }
        config.models.push(value.clone());
    }
    config.selected = custom.then_some(value.clone());
    database
        .connection()
        .execute_batch("SAVEPOINT translation_preferences")
        .map_err(|_| PlatformError::storage_unavailable())?;
    let result = (|| {
        write(database, &config)?;
        if !custom {
            database.connection().execute(
                "INSERT INTO settings(key,value,updated_at,device_id) VALUES('translation.preferences',?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id",
                params![serde_json::to_string(&value).map_err(|_| PlatformError::storage_unavailable())?, Utc::now().to_rfc3339(), database.device_id()],
            ).map_err(|_| PlatformError::storage_unavailable())?;
        }
        database
            .connection()
            .execute_batch("RELEASE translation_preferences")
            .map_err(|_| PlatformError::storage_unavailable())?;
        Ok(value)
    })();
    if result.is_err() {
        let _ = database
            .connection()
            .execute_batch("ROLLBACK TO translation_preferences; RELEASE translation_preferences");
    }
    result
}

pub fn delete_model(
    database: &AndroidDatabase,
    mut value: TranslationPreferences,
) -> Result<(), PlatformError> {
    value.model_id = require_model_id(&value.model_id)?.into();
    resolve(&value)?;
    let mut config = read(database)?;
    config.models.retain(|item| *item != value);
    if config.selected.as_ref() == Some(&value) {
        config.selected = None;
    }
    write(database, &config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform_paths::PlatformPaths;

    #[test]
    fn persists_local_models_without_overwriting_portable_preferences() {
        let root = tempfile::tempdir().unwrap();
        let paths = PlatformPaths::new(
            root.path().join("data"),
            root.path().join("cache"),
            root.path().join("logs"),
        );
        let db = AndroidDatabase::open(&paths, "test").unwrap();
        let built_in = TranslationPreferences {
            provider_id: "moonshot".into(),
            model_id: "kimi-k2.6".into(),
        };
        save(&db, built_in.clone()).unwrap();
        let custom = TranslationPreferences {
            provider_id: "openai".into(),
            model_id: "custom/model:1".into(),
        };
        save(&db, custom.clone()).unwrap();
        save(&db, custom.clone()).unwrap();
        assert_eq!(read(&db).unwrap().models.len(), 1);
        drop(db);
        let db = AndroidDatabase::open(&paths, "test").unwrap();
        assert_eq!(get_preferences(&db).unwrap(), custom);
        let saved: String = db
            .connection()
            .query_row(
                "SELECT value FROM settings WHERE key='translation.preferences'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<TranslationPreferences>(&saved).unwrap(),
            built_in
        );
        let (_, model) = resolve(&custom).unwrap();
        assert_eq!(model.completion_field, "max_completion_tokens");
        assert_eq!(model.max_blocks, 6);
        delete_model(&db, custom).unwrap();
        assert_eq!(get_preferences(&db).unwrap(), built_in);
        for id in ["", "a b", "a\nb", "中文", "../model"] {
            assert!(require_model_id(id).is_err());
        }
        assert_eq!(
            require_model_id(" custom/model:1 ").unwrap(),
            "custom/model:1"
        );
    }
}
