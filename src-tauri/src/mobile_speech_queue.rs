use crate::{
    mobile_speech::{self, SpeechPlayRequest},
    platform_error::PlatformError,
    platform_paths::PlatformPaths,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueItem {
    id: String,
    block_id: String,
    text: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueRequest {
    provider_id: String,
    model_id: String,
    voice_id: String,
    locale: String,
    rate: f64,
    source_id: String,
    title: String,
    items: Vec<QueueItem>,
    start_index: usize,
}
fn unavailable() -> PlatformError {
    PlatformError::new("speechUnavailable", "后台朗读不可用，请重试。", true)
}

#[cfg(target_os = "android")]
fn native(app: &AppHandle, command: &str, value: Value) -> Result<Value, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .speech_queue_command(command, value)
        .map_err(|_| unavailable())
}
#[cfg(not(target_os = "android"))]
fn native(_app: &AppHandle, _command: &str, _value: Value) -> Result<Value, PlatformError> {
    Err(unavailable())
}
pub fn state(app: &AppHandle) -> Result<Value, PlatformError> {
    native(app, "getSpeechQueueState", json!({}))
}
pub fn seek(app: &AppHandle, index: usize) -> Result<(), PlatformError> {
    native(
        app,
        "controlSpeechQueue",
        json!({"action":"seek","index":index}),
    )
    .map(|_| ())
}
fn segment(request: &QueueRequest, index: usize) -> SpeechPlayRequest {
    SpeechPlayRequest {
        provider_id: request.provider_id.clone(),
        model_id: request.model_id.clone(),
        voice_id: request.voice_id.clone(),
        locale: request.locale.clone(),
        rate: request.rate,
        source_id: request.source_id.clone(),
        item_id: request.items[index].id.clone(),
        text: request.items[index].text.clone(),
        usage: "article".into(),
    }
}
pub fn start(
    app: AppHandle,
    paths: PlatformPaths,
    request: QueueRequest,
) -> Result<(), PlatformError> {
    if request.items.is_empty()
        || request.items.len() > 10000
        || request.start_index >= request.items.len()
        || request.title.chars().count() > 200
        || request
            .items
            .iter()
            .map(|item| item.text.encode_utf16().count())
            .sum::<usize>()
            > 2_000_000
    {
        return Err(PlatformError::new("invalidInput", "朗读队列无效。", false));
    }
    for index in 0..request.items.len() {
        mobile_speech::validate_play(&segment(&request, index))?;
    }
    let session = uuid::Uuid::new_v4().to_string();
    native(
        &app,
        "startSpeechQueue",
        json!({"sessionId":session,"sourceId":request.source_id,"title":request.title,"items":request.items,"startIndex":request.start_index,"providerId":request.provider_id,"locale":request.locale,"rate":request.rate}),
    )?;
    if request.provider_id != "system" {
        tauri::async_runtime::spawn_blocking(move || {
            let result = prepare_audio(&app, &paths, &request, &session);
            if result.is_err() {
                let _ = native(
                    &app,
                    "controlSpeechQueue",
                    json!({"action":"error","sessionId":session}),
                );
            }
        });
    }
    Ok(())
}

fn prepare_audio(
    app: &AppHandle,
    paths: &PlatformPaths,
    request: &QueueRequest,
    session: &str,
) -> Result<(), PlatformError> {
    let mut prepared = std::collections::HashMap::<usize, std::path::PathBuf>::new();
    loop {
        let playback = state(app)?;
        if playback["sessionId"].as_str() != Some(session)
            || !matches!(playback["status"].as_str(), Some("playing" | "paused"))
        {
            return Ok(());
        }
        let index = playback["index"].as_u64().ok_or_else(unavailable)? as usize;
        for next in index..=(index + 1).min(request.items.len() - 1) {
            if prepared.get(&next).is_some_and(|path| path.is_file()) {
                continue;
            }
            let file = mobile_speech::synthesize(app, paths, &segment(request, next), None, false)?;
            let current = state(app)?;
            if current["sessionId"].as_str() != Some(session)
                || !matches!(current["status"].as_str(), Some("playing" | "paused"))
            {
                return Ok(());
            }
            native(
                app,
                "supplySpeechQueueAudio",
                json!({"sessionId":session,"index":next,"path":file}),
            )?;
            prepared.insert(next, file);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}
