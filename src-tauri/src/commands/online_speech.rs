use super::*;

#[tauri::command]
pub fn get_mobile_translation_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_online::TranslationSettings, PlatformError> {
    let database = state.database()?;
    mobile_online::settings(&app, &database)
}

#[tauri::command]
pub fn save_mobile_translation_preferences(
    state: tauri::State<'_, PlatformState>,
    preferences: TranslationPreferences,
) -> Result<TranslationPreferences, PlatformError> {
    let database = state.database()?;
    mobile_online::save_preferences(&database, preferences)
}

#[tauri::command]
pub fn save_mobile_translation_api_key(
    app: tauri::AppHandle,
    provider_id: String,
    model_id: String,
    value: String,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    mobile_online::save_candidate_key(&app, &provider_id, &model_id, &value)
}

#[tauri::command]
pub fn delete_mobile_translation_api_key(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<(), PlatformError> {
    mobile_online::delete_key(&app, &provider_id)
}

#[tauri::command]
pub fn test_mobile_translation_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    let preferences = {
        let database = state.database()?;
        mobile_online::get_preferences(&database)?
    };
    mobile_online::test_connection(&app, &preferences)
}

#[tauri::command]
pub async fn translate_mobile_article(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    article_id: String,
    force: Option<bool>,
) -> Result<mobile_online::TranslationResult, PlatformError> {
    state.online_runtime().begin_translation(&article_id)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    state
        .online_runtime()
        .set_translation_request(&article_id, &request_id)?;
    let result = (|| {
        let preferences = {
            let database = state.database()?;
            mobile_online::get_preferences(&database)?
        };
        let key = mobile_online::translation_key(&app, &preferences)?;
        mobile_online::translate_article(
            &app,
            &state,
            &article_id,
            &request_id,
            &key,
            &preferences,
            force.unwrap_or(false),
        )
    })();
    state.online_runtime().finish_translation(&article_id);
    if let Err(error) = &result {
        let status = if error.code == "networkCancelled" {
            "cancelled"
        } else {
            "error"
        };
        mobile_online::emit_progress(&app, &article_id, 0, 0, status, Some(error.message));
    }
    result
}

#[tauri::command]
pub fn cancel_mobile_translation(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    article_id: String,
) -> Result<(), PlatformError> {
    if let Some(request_id) = state.online_runtime().translation_request(&article_id)? {
        mobile_online::cancel_network(&app, &request_id);
    }
    Ok(())
}

#[tauri::command]
pub fn get_mobile_speech_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
) -> Result<serde_json::Value, PlatformError> {
    let database = state.database()?;
    mobile_speech::settings(&app, &database)
}

#[tauri::command]
pub fn save_mobile_speech_preferences(
    state: tauri::State<'_, PlatformState>,
    preferences: SpeechPreferences,
) -> Result<SpeechPreferences, PlatformError> {
    let database = state.database()?;
    mobile_speech::save_preferences(&database, preferences)
}

#[tauri::command]
pub fn save_mobile_speech_api_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    provider_id: String,
    value: String,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    mobile_speech::save_candidate_key(&app, &state.paths, &provider_id, &value)
}

#[tauri::command]
pub fn delete_mobile_speech_api_key(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<(), PlatformError> {
    mobile_speech::delete_key(&app, &provider_id)
}

#[tauri::command]
pub fn test_mobile_speech_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    provider_id: String,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    mobile_speech::test_connection(&app, &state.paths, &provider_id)
}

#[tauri::command]
pub fn play_mobile_speech(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request: SpeechPlayRequest,
) -> Result<(), PlatformError> {
    mobile_speech::play(&app, &state.paths, &request)
}

#[tauri::command]
pub async fn pause_mobile_speech(app: tauri::AppHandle) -> Result<(), PlatformError> {
    tauri::async_runtime::spawn_blocking(move || mobile_speech::pause(&app))
        .await
        .map_err(|_| PlatformError::storage_unavailable())?
}

#[tauri::command]
pub async fn resume_mobile_speech(app: tauri::AppHandle) -> Result<(), PlatformError> {
    tauri::async_runtime::spawn_blocking(move || mobile_speech::resume(&app))
        .await
        .map_err(|_| PlatformError::storage_unavailable())?
}

#[tauri::command]
pub async fn stop_mobile_speech(app: tauri::AppHandle) -> Result<(), PlatformError> {
    tauri::async_runtime::spawn_blocking(move || mobile_speech::stop(&app))
        .await
        .map_err(|_| PlatformError::storage_unavailable())?
}

#[tauri::command]
pub async fn start_mobile_speech_queue(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request: crate::mobile_speech_queue::QueueRequest,
) -> Result<(), PlatformError> {
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::mobile_speech_queue::start(app, paths, request)
    })
    .await
    .map_err(|_| PlatformError::storage_unavailable())?
}
#[tauri::command]
pub async fn get_mobile_speech_queue_state(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, PlatformError> {
    tauri::async_runtime::spawn_blocking(move || crate::mobile_speech_queue::state(&app))
        .await
        .map_err(|_| PlatformError::storage_unavailable())?
}
#[tauri::command]
pub async fn seek_mobile_speech_queue(
    app: tauri::AppHandle,
    index: usize,
) -> Result<(), PlatformError> {
    tauri::async_runtime::spawn_blocking(move || crate::mobile_speech_queue::seek(&app, index))
        .await
        .map_err(|_| PlatformError::storage_unavailable())?
}
