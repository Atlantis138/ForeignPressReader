use crate::{
    atomic_file, database::AndroidDatabase, mobile_online, platform_error::PlatformError,
    platform_paths::PlatformPaths,
};
#[cfg(target_os = "android")]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;
const CACHE_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechProviderSetting {
    pub model_id: String,
    pub voice_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechPreferences {
    pub locale: String,
    pub voice_id: Option<String>,
    pub provider_settings: HashMap<String, SpeechProviderSetting>,
    pub rate: f64,
    pub auto_play_study: bool,
    pub word_provider_id: String,
    pub article_provider_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechPlayRequest {
    pub provider_id: String,
    pub model_id: String,
    pub text: String,
    pub locale: String,
    pub voice_id: String,
    pub rate: f64,
    pub source_id: String,
    pub item_id: String,
    pub usage: String,
}

pub fn get_preferences(database: &AndroidDatabase) -> Result<SpeechPreferences, PlatformError> {
    let value = database
        .connection()
        .query_row(
            "SELECT value FROM settings WHERE key='speech.preferences'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    Ok(value
        .and_then(|value| serde_json::from_str(&value).ok())
        .and_then(normalize)
        .unwrap_or_else(default_preferences))
}

pub fn save_preferences(
    database: &AndroidDatabase,
    value: SpeechPreferences,
) -> Result<SpeechPreferences, PlatformError> {
    let value = normalize(value)
        .ok_or_else(|| PlatformError::new("invalidInput", "语音设置无效。", false))?;
    let encoded =
        serde_json::to_string(&value).map_err(|_| PlatformError::storage_unavailable())?;
    database.connection().execute("INSERT INTO settings(key,value,updated_at,device_id) VALUES('speech.preferences',?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id",params![encoded,Utc::now().to_rfc3339(),database.device_id()]).map_err(|_|PlatformError::storage_unavailable())?;
    Ok(value)
}

pub fn settings(app: &AppHandle, database: &AndroidDatabase) -> Result<Value, PlatformError> {
    let preferences = get_preferences(database)?;
    let system = system_tts_configured(app);
    let google = secret_status(app, "google-tts")?;
    let minimax = secret_status(app, "minimax-tts")?;
    Ok(json!({"preferences":preferences,"providers":[
        {"id":"system","name":"系统语音","description":"使用设备内置英文语音，本地合成，不上传文本。","requiresApiKey":false,"keyStatus":{"configured":system,"masked":null},"models":[],"voices":[]},
        {"id":"google","name":"Google Cloud Text-to-Speech","description":"Google Standard 基础声音。","requiresApiKey":true,"keyStatus":{"configured":google,"masked":if google{Some("••••••••")}else{None}},"models":[{"id":"standard","name":"Standard","description":"Google 基础标准语音"}],"voices":google_voices()},
        {"id":"minimax","name":"MiniMax Text-to-Speech","description":"MiniMax 中国站同步语音合成。","requiresApiKey":true,"keyStatus":{"configured":minimax,"masked":if minimax{Some("••••••••")}else{None}},"models":[{"id":"speech-2.8-turbo","name":"Speech 2.8 Turbo","description":"低延迟、自然流畅"},{"id":"speech-2.8-hd","name":"Speech 2.8 HD","description":"更高音质"}],"voices":minimax_voices()}
    ]}))
}

#[cfg(target_os = "android")]
fn system_tts_configured(app: &AppHandle) -> bool {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .system_tts_capability()
        .map(|capability| capability.available && capability.english_available)
        .unwrap_or(false)
}

#[cfg(not(target_os = "android"))]
fn system_tts_configured(_app: &AppHandle) -> bool {
    false
}

pub fn save_candidate_key(
    app: &AppHandle,
    paths: &PlatformPaths,
    provider_id: &str,
    value: &str,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    if value.trim().len() < 16 {
        return Err(PlatformError::new(
            "invalidInput",
            "语音 API Key 格式无效。",
            false,
        ));
    }
    let request = test_request(provider_id)?;
    let _ = synthesize(app, paths, &request, Some(value.trim()), true)?;
    save_secret(app, credential_slot(provider_id)?, value.trim())?;
    Ok(mobile_online::ConnectionTestResult {
        ok: true,
        message: format!(
            "{} 连接成功；本次测试可能消耗少量额度。",
            provider_name(provider_id)?
        ),
    })
}

pub fn test_connection(
    app: &AppHandle,
    paths: &PlatformPaths,
    provider_id: &str,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    let request = test_request(provider_id)?;
    let _ = synthesize(app, paths, &request, None, true)?;
    Ok(mobile_online::ConnectionTestResult {
        ok: true,
        message: format!(
            "{} 连接成功；本次测试可能消耗少量额度。",
            provider_name(provider_id)?
        ),
    })
}

pub fn delete_key(app: &AppHandle, provider_id: &str) -> Result<(), PlatformError> {
    delete_secret(app, credential_slot(provider_id)?)
}

pub fn play(
    app: &AppHandle,
    paths: &PlatformPaths,
    request: &SpeechPlayRequest,
) -> Result<(), PlatformError> {
    validate_play(request)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    if request.provider_id == "system" {
        return system_speak(
            app,
            &request_id,
            &request.text,
            &request.locale,
            request.rate as f32,
            &request.usage,
        );
    }
    let file = synthesize(app, paths, request, None, false)?;
    play_file(app, &request_id, &file, &request.usage)
}

fn synthesize(
    app: &AppHandle,
    paths: &PlatformPaths,
    request: &SpeechPlayRequest,
    candidate_key: Option<&str>,
    bypass_cache: bool,
) -> Result<PathBuf, PlatformError> {
    validate_play(request)?;
    if !matches!(request.provider_id.as_str(), "google" | "minimax") {
        return Err(PlatformError::new(
            "invalidInput",
            "远程语音服务无效。",
            false,
        ));
    }
    let key = if let Some(value) = candidate_key {
        value.to_owned()
    } else {
        load_secret(app, credential_slot(&request.provider_id)?)?.ok_or_else(|| {
            PlatformError::new("secretMissing", "请先保存所选语音服务的 API Key。", false)
        })?
    };
    let cache_key=sha256(&serde_json::to_string(&json!({"version":1,"providerId":request.provider_id,"modelId":request.model_id,"voiceId":request.voice_id,"locale":request.locale,"rate":format!("{:.2}",request.rate),"textHash":sha256(&request.text)})).unwrap_or_default());
    let file = paths
        .cache
        .join("speech")
        .join(&request.provider_id)
        .join(format!("{cache_key}.mp3"));
    if !bypass_cache && file_valid(&file) {
        touch(&file);
        return Ok(file);
    }
    let bytes = match request.provider_id.as_str() {
        "google" => google_synthesize(app, request, &key)?,
        "minimax" => minimax_synthesize(app, request, &key)?,
        _ => unreachable!(),
    };
    if bytes.is_empty() || bytes.len() > MAX_AUDIO_BYTES || !likely_mp3(&bytes) {
        return Err(PlatformError::new(
            "invalidResponse",
            "语音服务返回了无效音频。",
            false,
        ));
    }
    atomic_file::atomic_replace(&file, &bytes)?;
    trim_cache(&paths.cache.join("speech"));
    Ok(file)
}

fn google_synthesize(
    app: &AppHandle,
    request: &SpeechPlayRequest,
    key: &str,
) -> Result<Vec<u8>, PlatformError> {
    let body=serde_json::to_vec(&json!({"input":{"text":request.text},"voice":{"languageCode":request.locale,"name":request.voice_id},"audioConfig":{"audioEncoding":"MP3","speakingRate":request.rate}})).map_err(|_|PlatformError::new("invalidInput","语音请求无效。",false))?;
    let (status, value) = native_json(
        app,
        "https://texttospeech.googleapis.com/v1/text:synthesize",
        json!({"Content-Type":"application/json; charset=utf-8","x-goog-api-key":key}),
        &body,
        60_000,
        34 * 1024 * 1024,
    )?;
    require_success(status)?;
    let encoded = value
        .get("audioContent")
        .and_then(Value::as_str)
        .ok_or_else(|| PlatformError::new("invalidResponse", "Google 返回了无效音频。", false))?;
    base64_decode(encoded)
}

fn minimax_synthesize(
    app: &AppHandle,
    request: &SpeechPlayRequest,
    key: &str,
) -> Result<Vec<u8>, PlatformError> {
    let body=serde_json::to_vec(&json!({"model":request.model_id,"text":request.text,"stream":false,"language_boost":"English","output_format":"hex","voice_setting":{"voice_id":request.voice_id,"speed":request.rate,"vol":1,"pitch":0},"audio_setting":{"sample_rate":32000,"bitrate":128000,"format":"mp3","channel":1},"subtitle_enable":false})).map_err(|_|PlatformError::new("invalidInput","语音请求无效。",false))?;
    let (status, value) = native_json(
        app,
        "https://api.minimaxi.com/v1/t2a_v2",
        json!({"Content-Type":"application/json","Authorization":format!("Bearer {key}")}),
        &body,
        60_000,
        34 * 1024 * 1024,
    )?;
    require_success(status)?;
    if value
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        != Some(0)
    {
        return Err(PlatformError::new(
            "serviceUnavailable",
            "MiniMax 合成失败、受限或额度不足。",
            true,
        ));
    }
    let hex = value
        .pointer("/data/audio")
        .and_then(Value::as_str)
        .ok_or_else(|| PlatformError::new("invalidResponse", "MiniMax 返回了无效音频。", false))?;
    if value.pointer("/data/status").and_then(Value::as_i64) != Some(2)
        || hex.len() > MAX_AUDIO_BYTES * 2
    {
        return Err(PlatformError::new(
            "invalidResponse",
            "MiniMax 返回了无效音频。",
            false,
        ));
    }
    hex::decode(hex)
        .map_err(|_| PlatformError::new("invalidResponse", "MiniMax 返回了无效音频。", false))
}

fn normalize(mut value: SpeechPreferences) -> Option<SpeechPreferences> {
    if !matches!(value.locale.as_str(), "en-US" | "en-GB")
        || !(0.5..=2.0).contains(&value.rate)
        || !matches!(
            value.word_provider_id.as_str(),
            "system" | "google" | "minimax"
        )
        || !matches!(
            value.article_provider_id.as_str(),
            "system" | "google" | "minimax"
        )
    {
        return None;
    }
    value.voice_id = value
        .voice_id
        .map(|voice| voice.trim().chars().take(500).collect::<String>())
        .filter(|voice| !voice.is_empty());
    let google_voice = value
        .provider_settings
        .get("google")
        .filter(|setting| {
            setting.model_id == "standard"
                && google_voice_supported(&setting.voice_id, &value.locale)
        })
        .map(|setting| setting.voice_id.clone())
        .unwrap_or_else(|| default_google_voice(&value.locale).to_owned());
    let minimax = value
        .provider_settings
        .get("minimax")
        .filter(|setting| {
            minimax_model_supported(&setting.model_id) && minimax_voice_supported(&setting.voice_id)
        })
        .cloned()
        .unwrap_or_else(|| SpeechProviderSetting {
            model_id: "speech-2.8-turbo".into(),
            voice_id: "English_expressive_narrator".into(),
        });
    value.provider_settings = HashMap::from([
        (
            "google".into(),
            SpeechProviderSetting {
                model_id: "standard".into(),
                voice_id: google_voice,
            },
        ),
        ("minimax".into(), minimax),
    ]);
    Some(value)
}
fn default_preferences() -> SpeechPreferences {
    SpeechPreferences {
        locale: "en-US".into(),
        voice_id: None,
        rate: 0.9,
        auto_play_study: false,
        word_provider_id: "system".into(),
        article_provider_id: "google".into(),
        provider_settings: HashMap::from([
            (
                "google".into(),
                SpeechProviderSetting {
                    model_id: "standard".into(),
                    voice_id: "en-US-Standard-C".into(),
                },
            ),
            (
                "minimax".into(),
                SpeechProviderSetting {
                    model_id: "speech-2.8-turbo".into(),
                    voice_id: "English_expressive_narrator".into(),
                },
            ),
        ]),
    }
}
fn test_request(provider_id: &str) -> Result<SpeechPlayRequest, PlatformError> {
    Ok(match provider_id {
        "google" => SpeechPlayRequest {
            provider_id: "google".into(),
            model_id: "standard".into(),
            text: "Speech service connected.".into(),
            locale: "en-US".into(),
            voice_id: "en-US-Standard-C".into(),
            rate: 1.0,
            source_id: "settings".into(),
            item_id: "test".into(),
            usage: "word".into(),
        },
        "minimax" => SpeechPlayRequest {
            provider_id: "minimax".into(),
            model_id: "speech-2.8-turbo".into(),
            text: "Speech service connected.".into(),
            locale: "en-US".into(),
            voice_id: "English_expressive_narrator".into(),
            rate: 1.0,
            source_id: "settings".into(),
            item_id: "test".into(),
            usage: "word".into(),
        },
        _ => {
            return Err(PlatformError::new(
                "invalidInput",
                "远程语音服务无效。",
                false,
            ))
        }
    })
}
fn validate_play(value: &SpeechPlayRequest) -> Result<(), PlatformError> {
    let provider_valid = match value.provider_id.as_str() {
        "system" => value.model_id.len() <= 64 && value.voice_id.chars().count() <= 500,
        "google" => {
            value.model_id == "standard" && google_voice_supported(&value.voice_id, &value.locale)
        }
        "minimax" => {
            minimax_model_supported(&value.model_id) && minimax_voice_supported(&value.voice_id)
        }
        _ => false,
    };
    if value.text.trim().is_empty()
        || value.text.chars().count() > 4000
        || !matches!(value.locale.as_str(), "en-US" | "en-GB")
        || !(0.5..=2.0).contains(&value.rate)
        || !matches!(value.usage.as_str(), "word" | "article")
        || value.source_id.len() > 256
        || value.item_id.len() > 256
        || !provider_valid
    {
        return Err(PlatformError::new("invalidInput", "朗读请求无效。", false));
    }
    Ok(())
}
fn credential_slot(provider: &str) -> Result<&'static str, PlatformError> {
    match provider {
        "google" => Ok("google-tts"),
        "minimax" => Ok("minimax-tts"),
        _ => Err(PlatformError::new(
            "invalidInput",
            "远程语音服务无效。",
            false,
        )),
    }
}
fn provider_name(provider: &str) -> Result<&'static str, PlatformError> {
    match provider {
        "google" => Ok("Google Cloud Text-to-Speech"),
        "minimax" => Ok("MiniMax Text-to-Speech"),
        _ => Err(PlatformError::new(
            "invalidInput",
            "远程语音服务无效。",
            false,
        )),
    }
}
fn google_voices() -> Value {
    json!([{"id":"en-US-Standard-A","name":"Standard A · 男声","locales":["en-US"]},{"id":"en-US-Standard-C","name":"Standard C · 女声","locales":["en-US"]},{"id":"en-US-Standard-D","name":"Standard D · 男声","locales":["en-US"]},{"id":"en-US-Standard-E","name":"Standard E · 女声","locales":["en-US"]},{"id":"en-GB-Standard-A","name":"Standard A · 女声","locales":["en-GB"]},{"id":"en-GB-Standard-B","name":"Standard B · 男声","locales":["en-GB"]},{"id":"en-GB-Standard-C","name":"Standard C · 女声","locales":["en-GB"]},{"id":"en-GB-Standard-D","name":"Standard D · 男声","locales":["en-GB"]}])
}
fn minimax_voices() -> Value {
    json!([
        "English_expressive_narrator",
        "English_CaptivatingStoryteller",
        "English_Trustworth_Man",
        "English_CalmWoman",
        "English_magnetic_voiced_man",
        "English_compelling_lady1",
        "English_WiseScholar",
        "English_Steadymentor",
        "English_Deep-VoicedGentleman",
        "English_SereneWoman",
        "English_radiant_girl",
        "English_Aussie_Bloke"
    ]
    .into_iter()
    .map(|id| json!({"id":id,"name":id.replace('_'," "),"locales":["en-US","en-GB"]}))
    .collect::<Vec<_>>())
}
fn default_google_voice(locale: &str) -> &'static str {
    if locale == "en-GB" {
        "en-GB-Standard-A"
    } else {
        "en-US-Standard-C"
    }
}
fn google_voice_supported(voice: &str, locale: &str) -> bool {
    matches!(
        (locale, voice),
        (
            "en-US",
            "en-US-Standard-A" | "en-US-Standard-C" | "en-US-Standard-D" | "en-US-Standard-E"
        ) | (
            "en-GB",
            "en-GB-Standard-A" | "en-GB-Standard-B" | "en-GB-Standard-C" | "en-GB-Standard-D"
        )
    )
}
fn minimax_model_supported(model: &str) -> bool {
    matches!(model, "speech-2.8-turbo" | "speech-2.8-hd")
}
fn minimax_voice_supported(voice: &str) -> bool {
    matches!(
        voice,
        "English_expressive_narrator"
            | "English_CaptivatingStoryteller"
            | "English_Trustworth_Man"
            | "English_CalmWoman"
            | "English_magnetic_voiced_man"
            | "English_compelling_lady1"
            | "English_WiseScholar"
            | "English_Steadymentor"
            | "English_Deep-VoicedGentleman"
            | "English_SereneWoman"
            | "English_radiant_girl"
            | "English_Aussie_Bloke"
    )
}
fn sha256(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn likely_mp3(value: &[u8]) -> bool {
    value.len() >= 3
        && ((value[0] == b'I' && value[1] == b'D' && value[2] == b'3')
            || (value[0] == 0xff && (value[1] & 0xe0) == 0xe0))
}
fn file_valid(path: &Path) -> bool {
    fs::metadata(path)
        .ok()
        .is_some_and(|meta| meta.len() > 0 && meta.len() <= MAX_AUDIO_BYTES as u64)
        && fs::read(path).ok().is_some_and(|bytes| likely_mp3(&bytes))
}
fn touch(path: &Path) {
    if let Ok(bytes) = fs::read(path) {
        let _ = fs::write(path, bytes);
    }
}
fn trim_cache(root: &Path) {
    let Ok(entries) = walk_files(root) else {
        return;
    };
    let mut files = entries;
    let mut total = files.iter().map(|item| item.1).sum::<u64>();
    files.sort_by_key(|item| item.2);
    for (file, size, _) in files {
        if total <= CACHE_LIMIT {
            break;
        }
        if fs::remove_file(file).is_ok() {
            total = total.saturating_sub(size)
        }
    }
}
fn walk_files(root: &Path) -> std::io::Result<Vec<(PathBuf, u64, std::time::SystemTime)>> {
    let mut result = Vec::new();
    if !root.exists() {
        return Ok(result);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_dir() {
            result.extend(walk_files(&entry.path())?)
        } else if meta.is_file() {
            result.push((
                entry.path(),
                meta.len(),
                meta.modified().unwrap_or(std::time::UNIX_EPOCH),
            ))
        }
    }
    Ok(result)
}
fn require_success(status: u16) -> Result<(), PlatformError> {
    if matches!(status, 401 | 403) {
        Err(PlatformError::new(
            "secretRejected",
            "语音 API Key 无效或无调用权限。",
            false,
        ))
    } else if status == 429 || status >= 500 {
        Err(PlatformError::new(
            "serviceUnavailable",
            "语音服务暂时不可用或额度不足。",
            true,
        ))
    } else if !(200..300).contains(&status) {
        Err(PlatformError::new(
            "serviceUnavailable",
            "语音合成请求失败。",
            false,
        ))
    } else {
        Ok(())
    }
}

#[cfg(target_os = "android")]
fn base64_decode(value: &str) -> Result<Vec<u8>, PlatformError> {
    BASE64
        .decode(value)
        .map_err(|_| PlatformError::new("invalidResponse", "Google 返回了无效音频。", false))
}
#[cfg(not(target_os = "android"))]
fn base64_decode(_value: &str) -> Result<Vec<u8>, PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动语音。",
        false,
    ))
}

#[cfg(target_os = "android")]
fn native_json(
    app: &AppHandle,
    url: &str,
    headers: Value,
    body: &[u8],
    timeout_ms: u32,
    max_bytes: u32,
) -> Result<(u16, Value), PlatformError> {
    use fpr_platform_plugin::{FoundationExt, NetworkRequest};
    let headers = serde_json::to_string(&headers)
        .map_err(|_| PlatformError::new("invalidInput", "网络请求无效。", false))?;
    let body = BASE64.encode(body);
    let request_id = uuid::Uuid::new_v4().to_string();
    let response = app
        .foundation()
        .network_execute(NetworkRequest {
            request_id: &request_id,
            url,
            method: "POST",
            timeout_ms,
            max_bytes,
            headers_json: &headers,
            body_base64: Some(&body),
        })
        .map_err(|error| match error.code() {
            Some("networkTimeout") => {
                PlatformError::new("networkTimeout", "语音服务请求超时。", true)
            }
            Some("networkOffline") => {
                PlatformError::new("networkOffline", "当前设备无法连接网络。", true)
            }
            Some("networkTls") => PlatformError::new("networkTls", "TLS 验证失败。", false),
            Some("networkResponseTooLarge") => {
                PlatformError::new("networkResponseTooLarge", "语音响应超过大小限制。", false)
            }
            _ => PlatformError::new("networkTransport", "语音服务网络请求失败。", true),
        })?;
    let bytes = BASE64
        .decode(response.body_base64)
        .map_err(|_| PlatformError::new("invalidResponse", "语音服务返回格式不正确。", true))?;
    Ok((
        response.status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    ))
}
#[cfg(not(target_os = "android"))]
fn native_json(
    _app: &AppHandle,
    _url: &str,
    _headers: Value,
    _body: &[u8],
    _timeout_ms: u32,
    _max_bytes: u32,
) -> Result<(u16, Value), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动语音。",
        false,
    ))
}

#[cfg(target_os = "android")]
fn system_speak(
    app: &AppHandle,
    id: &str,
    text: &str,
    locale: &str,
    rate: f32,
    usage: &str,
) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .system_tts_speak(id, text, locale, rate, usage)
        .map_err(|_| PlatformError::new("speechUnavailable", "系统语音朗读失败。", true))
}
#[cfg(not(target_os = "android"))]
fn system_speak(
    _app: &AppHandle,
    _id: &str,
    _text: &str,
    _locale: &str,
    _rate: f32,
    _usage: &str,
) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动语音。",
        false,
    ))
}
#[cfg(target_os = "android")]
fn play_file(app: &AppHandle, id: &str, path: &Path, usage: &str) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let path = path.to_string_lossy();
    app.foundation()
        .play_speech_audio(id, &path, usage)
        .map_err(|_| PlatformError::new("speechUnavailable", "语音音频播放失败。", true))
}
#[cfg(not(target_os = "android"))]
fn play_file(_app: &AppHandle, _id: &str, _path: &Path, _usage: &str) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动语音。",
        false,
    ))
}

#[cfg(target_os = "android")]
fn load_secret(app: &AppHandle, slot: &str) -> Result<Option<String>, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_load(slot)
        .map(|value| value.value)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法读取语音 API Key。", false))
}
#[cfg(not(target_os = "android"))]
fn load_secret(_app: &AppHandle, _slot: &str) -> Result<Option<String>, PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用 Android Keystore。",
        false,
    ))
}
#[cfg(target_os = "android")]
fn save_secret(app: &AppHandle, slot: &str, value: &str) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_save(slot, value)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法安全保存语音 API Key。", false))
}
#[cfg(not(target_os = "android"))]
fn save_secret(_app: &AppHandle, _slot: &str, _value: &str) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用 Android Keystore。",
        false,
    ))
}
#[cfg(target_os = "android")]
fn delete_secret(app: &AppHandle, slot: &str) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_delete(slot)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法删除语音 API Key。", false))
}
#[cfg(not(target_os = "android"))]
fn delete_secret(_app: &AppHandle, _slot: &str) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用 Android Keystore。",
        false,
    ))
}
#[cfg(target_os = "android")]
fn secret_status(app: &AppHandle, slot: &str) -> Result<bool, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_status(slot)
        .map(|value| value.configured)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法读取语音 API Key 状态。", false))
}
#[cfg(not(target_os = "android"))]
fn secret_status(_app: &AppHandle, _slot: &str) -> Result<bool, PlatformError> {
    Ok(false)
}

#[cfg(target_os = "android")]
pub fn pause(app: &AppHandle) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .pause_speech()
        .map_err(|_| PlatformError::new("speechUnavailable", "暂停朗读失败。", true))
}
#[cfg(not(target_os = "android"))]
pub fn pause(_app: &AppHandle) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动语音。",
        false,
    ))
}
#[cfg(target_os = "android")]
pub fn resume(app: &AppHandle) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .resume_speech()
        .map_err(|_| PlatformError::new("speechUnavailable", "继续朗读失败。", true))
}
#[cfg(not(target_os = "android"))]
pub fn resume(_app: &AppHandle) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动语音。",
        false,
    ))
}
#[cfg(target_os = "android")]
pub fn stop(app: &AppHandle) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .stop_speech()
        .map_err(|_| PlatformError::new("speechUnavailable", "停止朗读失败。", true))
}
#[cfg(not(target_os = "android"))]
pub fn stop(_app: &AppHandle) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动语音。",
        false,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_defaults_and_locale_specific_voice() {
        let mut preferences = default_preferences();
        preferences.locale = "en-GB".into();
        preferences
            .provider_settings
            .get_mut("google")
            .unwrap()
            .voice_id = "en-US-Standard-C".into();
        preferences.provider_settings.insert(
            "untrusted".into(),
            SpeechProviderSetting {
                model_id: "arbitrary".into(),
                voice_id: "arbitrary".into(),
            },
        );
        let value = normalize(preferences).unwrap();
        assert_eq!(value.word_provider_id, "system");
        assert_eq!(
            value.provider_settings["google"].voice_id,
            "en-GB-Standard-A"
        );
        assert!(!value.provider_settings.contains_key("untrusted"));
    }

    #[test]
    fn rejects_unregistered_remote_model_and_voice() {
        let mut request = test_request("google").unwrap();
        request.model_id = "unregistered".into();
        assert_eq!(validate_play(&request).unwrap_err().code, "invalidInput");
        request.model_id = "standard".into();
        request.voice_id = "en-GB-Standard-A".into();
        assert_eq!(validate_play(&request).unwrap_err().code, "invalidInput");
    }

    #[test]
    fn separates_cache_identity() {
        let request = test_request("google").unwrap();
        let left = sha256(
            &serde_json::to_string(&json!({"provider":request.provider_id,"text":request.text}))
                .unwrap(),
        );
        let right = sha256(
            &serde_json::to_string(&json!({"provider":"minimax","text":request.text})).unwrap(),
        );
        assert_ne!(left, right)
    }
}
