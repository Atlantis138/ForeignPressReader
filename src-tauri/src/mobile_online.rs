use crate::{
    database::AndroidDatabase, platform_error::PlatformError, platform_state::PlatformState,
};
#[cfg(target_os = "android")]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

pub const TRANSLATION_PROMPT_VERSION: &str = "editorial-zh-v1";

const DEEPSEEK_MODELS: &[ModelDef] = &[
    ModelDef::new(
        "deepseek-v4-flash",
        "DeepSeek V4 Flash",
        12,
        12_000,
        8_192,
        "max_tokens",
        true,
    ),
    ModelDef::new(
        "deepseek-v4-pro",
        "DeepSeek V4 Pro",
        12,
        12_000,
        8_192,
        "max_tokens",
        true,
    ),
];
const OPENAI_MODELS: &[ModelDef] = &[
    ModelDef::new(
        "gpt-5.4-nano",
        "GPT-5.4 nano",
        12,
        12_000,
        8_192,
        "max_completion_tokens",
        false,
    ),
    ModelDef::new(
        "gpt-5.4-mini",
        "GPT-5.4 mini",
        12,
        12_000,
        8_192,
        "max_completion_tokens",
        false,
    ),
];
const MOONSHOT_MODELS: &[ModelDef] = &[
    ModelDef::new(
        "moonshot-v1-8k",
        "Moonshot V1 8K",
        6,
        4_000,
        4_096,
        "max_tokens",
        false,
    ),
    ModelDef::new(
        "moonshot-v1-32k",
        "Moonshot V1 32K",
        12,
        12_000,
        8_192,
        "max_tokens",
        false,
    ),
    ModelDef::new(
        "moonshot-v1-128k",
        "Moonshot V1 128K",
        12,
        12_000,
        8_192,
        "max_tokens",
        false,
    ),
    ModelDef::new(
        "kimi-k2.6",
        "Kimi K2.6",
        12,
        12_000,
        8_192,
        "max_tokens",
        true,
    ),
];

#[derive(Debug, Clone, Copy)]
struct ModelDef {
    id: &'static str,
    name: &'static str,
    max_blocks: usize,
    max_characters: usize,
    max_completion_tokens: u64,
    completion_field: &'static str,
    disable_thinking: bool,
}

impl ModelDef {
    const fn new(
        id: &'static str,
        name: &'static str,
        max_blocks: usize,
        max_characters: usize,
        max_completion_tokens: u64,
        completion_field: &'static str,
        disable_thinking: bool,
    ) -> Self {
        Self {
            id,
            name,
            max_blocks,
            max_characters,
            max_completion_tokens,
            completion_field,
            disable_thinking,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ProviderDef {
    id: &'static str,
    name: &'static str,
    url: &'static str,
    models: &'static [ModelDef],
}

const PROVIDERS: &[ProviderDef] = &[
    ProviderDef {
        id: "deepseek",
        name: "DeepSeek",
        url: "https://api.deepseek.com/chat/completions",
        models: DEEPSEEK_MODELS,
    },
    ProviderDef {
        id: "openai",
        name: "OpenAI",
        url: "https://api.openai.com/v1/chat/completions",
        models: OPENAI_MODELS,
    },
    ProviderDef {
        id: "moonshot",
        name: "Kimi（Moonshot）",
        url: "https://api.moonshot.cn/v1/chat/completions",
        models: MOONSHOT_MODELS,
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationPreferences {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub configured: bool,
    pub masked: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationModelOption {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProviderOption {
    pub id: &'static str,
    pub name: &'static str,
    pub key_status: KeyStatus,
    pub models: Vec<TranslationModelOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSettings {
    pub preferences: TranslationPreferences,
    pub providers: Vec<TranslationProviderOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationProgress {
    pub article_id: String,
    pub completed: usize,
    pub total: usize,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResult {
    pub article_id: String,
    pub translated: usize,
    pub total: usize,
    pub cached: bool,
}

#[derive(Clone)]
struct SourceSegment {
    id: String,
    kind: String,
    text: String,
    source_hash: String,
}

pub fn get_preferences(
    database: &AndroidDatabase,
) -> Result<TranslationPreferences, PlatformError> {
    let value = database
        .connection()
        .query_row(
            "SELECT value FROM settings WHERE key='translation.preferences'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| PlatformError::database_corrupt())?;
    Ok(value
        .and_then(|value| serde_json::from_str(&value).ok())
        .filter(valid_preferences)
        .unwrap_or_else(default_preferences))
}

pub fn save_preferences(
    database: &AndroidDatabase,
    value: TranslationPreferences,
) -> Result<TranslationPreferences, PlatformError> {
    if !valid_preferences(&value) {
        return Err(PlatformError::new(
            "invalidInput",
            "翻译服务或模型无效。",
            false,
        ));
    }
    let encoded =
        serde_json::to_string(&value).map_err(|_| PlatformError::storage_unavailable())?;
    database.connection().execute(
        "INSERT INTO settings(key,value,updated_at,device_id) VALUES('translation.preferences',?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id",
        params![encoded, Utc::now().to_rfc3339(), database.device_id()],
    ).map_err(|_| PlatformError::storage_unavailable())?;
    Ok(value)
}

pub fn cache_model(preferences: &TranslationPreferences) -> Result<String, PlatformError> {
    let (provider, model) = resolve(preferences)?;
    Ok(if provider.id == "deepseek" {
        model.id.to_owned()
    } else {
        format!("{}:{}", provider.id, model.id)
    })
}

pub fn settings(
    app: &AppHandle,
    database: &AndroidDatabase,
) -> Result<TranslationSettings, PlatformError> {
    let preferences = get_preferences(database)?;
    let providers = PROVIDERS
        .iter()
        .map(|provider| {
            let configured = secret_configured(app, provider.id).unwrap_or(false);
            TranslationProviderOption {
                id: provider.id,
                name: provider.name,
                key_status: KeyStatus {
                    configured,
                    masked: configured.then_some("••••••••"),
                },
                models: provider
                    .models
                    .iter()
                    .map(|model| TranslationModelOption {
                        id: model.id,
                        name: model.name,
                        description: if model.id == "moonshot-v1-8k" {
                            "短批次、低成本"
                        } else {
                            "适合文章与词义服务"
                        },
                    })
                    .collect(),
            }
        })
        .collect();
    Ok(TranslationSettings {
        preferences,
        providers,
    })
}

pub fn save_candidate_key(
    app: &AppHandle,
    provider_id: &str,
    model_id: &str,
    value: &str,
) -> Result<ConnectionTestResult, PlatformError> {
    if value.trim().len() < 16 {
        return Err(PlatformError::new(
            "invalidInput",
            "API Key 格式无效。",
            false,
        ));
    }
    let preferences = TranslationPreferences {
        provider_id: provider_id.to_owned(),
        model_id: model_id.to_owned(),
    };
    let result = test_with_key(app, &preferences, value.trim())?;
    if !result.ok {
        return Ok(result);
    }
    save_secret(app, provider_id, value.trim())?;
    Ok(result)
}

pub fn delete_key(app: &AppHandle, provider_id: &str) -> Result<(), PlatformError> {
    provider(provider_id)?;
    delete_secret(app, provider_id)
}

pub fn test_connection(
    app: &AppHandle,
    preferences: &TranslationPreferences,
) -> Result<ConnectionTestResult, PlatformError> {
    let key = load_secret(app, &preferences.provider_id)?.ok_or_else(|| {
        PlatformError::new("secretMissing", "尚未保存所选服务的 API Key。", false)
    })?;
    test_with_key(app, preferences, &key)
}

pub fn complete_json(
    app: &AppHandle,
    preferences: &TranslationPreferences,
    key: &str,
    system_prompt: &str,
    payload: Value,
) -> Result<Value, PlatformError> {
    let (provider, model) = resolve(preferences)?;
    let body = completion_body(
        model,
        2_048,
        vec![
            json!({"role":"system","content":system_prompt}),
            json!({"role":"user","content":serde_json::to_string(&payload).unwrap_or_default()}),
        ],
    );
    let mut last = PlatformError::new("serviceUnavailable", "模型服务暂时不可用。", true);
    for attempt in 0..3 {
        match request_json(app, provider.url, key, &body, 30_000, 4 * 1024 * 1024) {
            Ok((401 | 403, _)) => {
                return Err(PlatformError::new(
                    "secretRejected",
                    "API Key 无效或账户无权访问该模型。",
                    false,
                ))
            }
            Ok((status, _)) if !(200..300).contains(&status) => {
                last = PlatformError::new(
                    "serviceUnavailable",
                    "模型服务暂时不可用。",
                    status == 429 || status >= 500,
                );
                if !last.retryable {
                    return Err(last);
                }
            }
            Ok((_, outer)) => {
                if outer
                    .pointer("/choices/0/finish_reason")
                    .and_then(Value::as_str)
                    == Some("length")
                {
                    last = PlatformError::new("responseTruncated", "模型返回内容被截断。", true);
                } else {
                    let content = outer
                        .pointer("/choices/0/message/content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            PlatformError::new("invalidResponse", "模型返回了空内容。", true)
                        })?;
                    return serde_json::from_str(strip_fence(content)).map_err(|_| {
                        PlatformError::new("invalidResponse", "模型返回格式不正确。", true)
                    });
                }
            }
            Err(error) => {
                last = error;
                if !last.retryable {
                    return Err(last);
                }
            }
        }
        if attempt < 2 {
            std::thread::sleep(Duration::from_millis(if attempt == 0 {
                500
            } else {
                1_500
            }));
        }
    }
    Err(last)
}

fn test_with_key(
    app: &AppHandle,
    preferences: &TranslationPreferences,
    key: &str,
) -> Result<ConnectionTestResult, PlatformError> {
    let (provider, model) = resolve(preferences)?;
    let body = completion_body(
        model,
        32,
        vec![
            json!({"role":"system","content":"只返回 JSON：{\"ok\":true}。"}),
            json!({"role":"user","content":"连接测试"}),
        ],
    );
    let (status, value) = request_json(app, provider.url, key, &body, 15_000, 4 * 1024 * 1024)?;
    if status == 401 || status == 403 {
        return Ok(ConnectionTestResult {
            ok: false,
            message: "API Key 无效或无权访问。".into(),
        });
    }
    if !(200..300).contains(&status) {
        return Ok(ConnectionTestResult {
            ok: false,
            message: format!("连接失败（HTTP {status}）"),
        });
    }
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    Ok(if content.is_empty() {
        ConnectionTestResult {
            ok: false,
            message: format!("{} 返回了空内容。", provider.name),
        }
    } else {
        ConnectionTestResult {
            ok: true,
            message: format!(
                "连接成功，{} 可用（本次测试会产生极少量用量）。",
                model.name
            ),
        }
    })
}

pub fn translate_article(
    app: &AppHandle,
    state: &PlatformState,
    article_id: &str,
    request_id: &str,
    key: &str,
    preferences: &TranslationPreferences,
) -> Result<TranslationResult, PlatformError> {
    let (provider, model) = resolve(preferences)?;
    let cache_model = cache_model(preferences)?;
    let (title, section_title, all, missing) = {
        let database = state.database()?;
        let (title, section_title) = database.connection().query_row(
            "SELECT a.title,s.title FROM articles a LEFT JOIN sections s ON s.id=a.section_id WHERE a.id=?1", [article_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        ).optional().map_err(|_| PlatformError::database_corrupt())?.ok_or_else(|| PlatformError::new("articleNotFound", "未找到该文章。", false))?;
        let mut statement = database.connection().prepare(
            "SELECT id,type,text FROM blocks WHERE article_id=?1 AND text IS NOT NULL AND trim(text)<>'' AND type<>'image' ORDER BY position",
        ).map_err(|_| PlatformError::database_corrupt())?;
        let all = statement
            .query_map([article_id], |row| {
                let text: String = row.get(2)?;
                Ok(SourceSegment {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    source_hash: sha256(&text),
                    text,
                })
            })
            .map_err(|_| PlatformError::database_corrupt())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| PlatformError::database_corrupt())?;
        let mut missing = Vec::new();
        for segment in &all {
            let found: bool = database.connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM translations WHERE block_id=?1 AND source_hash=?2 AND target_language='zh-CN' AND model=?3 AND prompt_version=?4)",
                params![segment.id, segment.source_hash, cache_model, TRANSLATION_PROMPT_VERSION], |row| row.get(0),
            ).map_err(|_| PlatformError::database_corrupt())?;
            if !found {
                missing.push(segment.clone());
            }
        }
        (title, section_title, all, missing)
    };
    if missing.is_empty() {
        return Ok(TranslationResult {
            article_id: article_id.into(),
            translated: all.len(),
            total: all.len(),
            cached: true,
        });
    }
    let mut completed = all.len() - missing.len();
    emit_progress(app, article_id, completed, all.len(), "started", None);
    let mut batches: VecDeque<Vec<SourceSegment>> = make_batches(missing, model).into();
    while let Some(batch) = batches.pop_front() {
        let messages = vec![
            json!({"role":"system","content":"你是严谨的英中杂志翻译。保持作者语气、专名、数字、限定语和逻辑关系，不添加解释，不遗漏信息。只返回 JSON 对象：{\"segments\":[{\"blockId\":\"原ID\",\"translation\":\"译文\"}]}。每个输入 blockId 必须且只能出现一次。"}),
            json!({"role":"user","content":serde_json::to_string(&json!({"articleTitle":title,"sectionTitle":section_title,"segments":batch.iter().map(|segment| json!({"blockId":segment.id,"type":segment.kind,"text":segment.text})).collect::<Vec<_>>() })).unwrap_or_default()}),
        ];
        let body = completion_body(model, model.max_completion_tokens, messages);
        let (status, outer) = request_json_with_id(
            app,
            request_id,
            provider.url,
            key,
            &body,
            60_000,
            4 * 1024 * 1024,
        )?;
        if status == 401 || status == 403 {
            return Err(PlatformError::new(
                "secretRejected",
                "API Key 无效或账户无权访问该模型。",
                false,
            ));
        }
        if !(200..300).contains(&status) {
            return Err(PlatformError::new(
                "serviceUnavailable",
                "翻译服务暂时不可用。",
                status == 429 || status >= 500,
            ));
        }
        if outer
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            == Some("length")
        {
            if batch.len() == 1 {
                return Err(PlatformError::new(
                    "responseTruncated",
                    "模型返回内容被截断，请稍后重试。",
                    true,
                ));
            }
            let middle = batch.len().div_ceil(2);
            batches.push_front(batch[middle..].to_vec());
            batches.push_front(batch[..middle].to_vec());
            continue;
        }
        let content = outer
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| PlatformError::new("invalidResponse", "模型返回了空内容。", true))?;
        let parsed: Value = serde_json::from_str(strip_fence(content))
            .map_err(|_| PlatformError::new("invalidResponse", "模型返回格式不正确。", true))?;
        let translated = parsed
            .get("segments")
            .and_then(Value::as_array)
            .ok_or_else(|| PlatformError::new("invalidResponse", "模型返回格式不正确。", true))?;
        let sources: HashMap<&str, &SourceSegment> = batch
            .iter()
            .map(|segment| (segment.id.as_str(), segment))
            .collect();
        let mut saved = 0;
        {
            let database = state.database()?;
            for item in translated {
                let block_id = item.get("blockId").and_then(Value::as_str).unwrap_or("");
                let translation = item
                    .get("translation")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let Some(source) = sources.get(block_id) else {
                    continue;
                };
                if translation.is_empty() {
                    continue;
                }
                database.connection().execute(
                    "INSERT OR REPLACE INTO translations(block_id,source_hash,target_language,model,prompt_version,text,created_at) VALUES(?1,?2,'zh-CN',?3,?4,?5,?6)",
                    params![source.id, source.source_hash, cache_model, TRANSLATION_PROMPT_VERSION, translation, Utc::now().to_rfc3339()],
                ).map_err(|_| PlatformError::storage_unavailable())?;
                completed += 1;
                saved += 1;
                emit_progress(app, article_id, completed, all.len(), "progress", None);
            }
        }
        if saved != batch.len() {
            return Err(PlatformError::new(
                "invalidResponse",
                "模型未返回全部段落译文，可稍后重试。",
                true,
            ));
        }
    }
    emit_progress(app, article_id, completed, all.len(), "completed", None);
    Ok(TranslationResult {
        article_id: article_id.into(),
        translated: completed,
        total: all.len(),
        cached: false,
    })
}

fn make_batches(segments: Vec<SourceSegment>, model: ModelDef) -> Vec<Vec<SourceSegment>> {
    let mut result = Vec::new();
    let mut current = Vec::new();
    let mut characters = 0;
    for segment in segments {
        if !current.is_empty()
            && (current.len() >= model.max_blocks
                || characters + segment.text.chars().count() > model.max_characters)
        {
            result.push(std::mem::take(&mut current));
            characters = 0;
        }
        characters += segment.text.chars().count();
        current.push(segment);
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

fn completion_body(model: ModelDef, completion_tokens: u64, messages: Vec<Value>) -> Value {
    let mut body =
        json!({"model":model.id,"response_format":{"type":"json_object"},"messages":messages});
    body[model.completion_field] = json!(completion_tokens.min(model.max_completion_tokens));
    if model.disable_thinking {
        body["thinking"] = json!({"type":"disabled"});
    }
    body
}

fn resolve(value: &TranslationPreferences) -> Result<(ProviderDef, ModelDef), PlatformError> {
    let provider = provider(&value.provider_id)?;
    let model = provider
        .models
        .iter()
        .find(|model| model.id == value.model_id)
        .copied()
        .ok_or_else(|| PlatformError::new("invalidInput", "翻译模型无效。", false))?;
    Ok((provider, model))
}

fn provider(id: &str) -> Result<ProviderDef, PlatformError> {
    PROVIDERS
        .iter()
        .find(|provider| provider.id == id)
        .copied()
        .ok_or_else(|| PlatformError::new("invalidInput", "翻译服务无效。", false))
}

fn valid_preferences(value: &TranslationPreferences) -> bool {
    resolve(value).is_ok()
}
fn default_preferences() -> TranslationPreferences {
    TranslationPreferences {
        provider_id: "deepseek".into(),
        model_id: "deepseek-v4-flash".into(),
    }
}
fn sha256(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn strip_fence(value: &str) -> &str {
    value
        .trim()
        .strip_prefix("```json")
        .or_else(|| value.trim().strip_prefix("```"))
        .unwrap_or(value.trim())
        .trim()
        .strip_suffix("```")
        .unwrap_or(value.trim())
        .trim()
}

pub fn emit_progress(
    app: &AppHandle,
    article_id: &str,
    completed: usize,
    total: usize,
    status: &'static str,
    message: Option<&'static str>,
) {
    let _ = app.emit(
        "mobile-translation-progress",
        TranslationProgress {
            article_id: article_id.into(),
            completed,
            total,
            status,
            message,
        },
    );
}

#[cfg(target_os = "android")]
fn request_json(
    app: &AppHandle,
    url: &str,
    key: &str,
    body: &Value,
    timeout_ms: u32,
    max_bytes: u32,
) -> Result<(u16, Value), PlatformError> {
    request_json_with_id(
        app,
        &uuid::Uuid::new_v4().to_string(),
        url,
        key,
        body,
        timeout_ms,
        max_bytes,
    )
}

#[cfg(not(target_os = "android"))]
fn request_json(
    _app: &AppHandle,
    _url: &str,
    _key: &str,
    _body: &Value,
    _timeout_ms: u32,
    _max_bytes: u32,
) -> Result<(u16, Value), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动在线服务。",
        false,
    ))
}

#[cfg(target_os = "android")]
fn request_json_with_id(
    app: &AppHandle,
    request_id: &str,
    url: &str,
    key: &str,
    body: &Value,
    timeout_ms: u32,
    max_bytes: u32,
) -> Result<(u16, Value), PlatformError> {
    use fpr_platform_plugin::{FoundationExt, NetworkRequest};
    let headers = serde_json::to_string(
        &json!({"Authorization":format!("Bearer {key}"),"Content-Type":"application/json"}),
    )
    .map_err(|_| PlatformError::new("invalidInput", "网络请求无效。", false))?;
    let body = serde_json::to_vec(body)
        .map_err(|_| PlatformError::new("invalidInput", "网络请求无效。", false))?;
    let encoded = BASE64.encode(body);
    let response = app
        .foundation()
        .network_execute(NetworkRequest {
            request_id,
            url,
            method: "POST",
            timeout_ms,
            max_bytes,
            headers_json: &headers,
            body_base64: Some(&encoded),
        })
        .map_err(map_network_error)?;
    let bytes = BASE64
        .decode(response.body_base64)
        .map_err(|_| PlatformError::new("invalidResponse", "在线服务返回格式不正确。", true))?;
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Ok((response.status, value))
}

#[cfg(not(target_os = "android"))]
fn request_json_with_id(
    _app: &AppHandle,
    _request_id: &str,
    _url: &str,
    _key: &str,
    _body: &Value,
    _timeout_ms: u32,
    _max_bytes: u32,
) -> Result<(u16, Value), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用移动在线服务。",
        false,
    ))
}

#[cfg(target_os = "android")]
fn map_network_error(error: fpr_platform_plugin::Error) -> PlatformError {
    match error.code() {
        Some("networkCancelled") => {
            PlatformError::new("networkCancelled", "网络请求已取消。", false)
        }
        Some("networkTimeout") => PlatformError::new("networkTimeout", "在线服务请求超时。", true),
        Some("networkTls") => PlatformError::new("networkTls", "TLS 验证失败。", false),
        Some("networkOffline") => {
            PlatformError::new("networkOffline", "当前设备无法连接网络。", true)
        }
        Some("networkResponseTooLarge") => PlatformError::new(
            "networkResponseTooLarge",
            "在线服务响应超过大小限制。",
            false,
        ),
        _ => PlatformError::new("networkTransport", "在线服务网络请求失败。", true),
    }
}

#[cfg(target_os = "android")]
fn load_secret(app: &AppHandle, slot: &str) -> Result<Option<String>, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_load(slot)
        .map(|value| value.value)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法读取已保存的 API Key。", false))
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
        .map_err(|_| PlatformError::new("secretUnavailable", "无法安全保存 API Key。", false))
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
        .map_err(|_| PlatformError::new("secretUnavailable", "无法删除 API Key。", false))
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
fn secret_configured(app: &AppHandle, slot: &str) -> Result<bool, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_status(slot)
        .map(|status| status.configured)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法读取 API Key 状态。", false))
}
#[cfg(not(target_os = "android"))]
fn secret_configured(_app: &AppHandle, _slot: &str) -> Result<bool, PlatformError> {
    Ok(false)
}

pub fn translation_key(
    app: &AppHandle,
    preferences: &TranslationPreferences,
) -> Result<String, PlatformError> {
    load_secret(app, &preferences.provider_id)?.ok_or_else(|| {
        PlatformError::new(
            "secretMissing",
            "请先在设置中保存所选服务的 API Key。",
            false,
        )
    })
}

#[cfg(target_os = "android")]
pub fn cancel_network(app: &AppHandle, request_id: &str) {
    use fpr_platform_plugin::FoundationExt;
    let _ = app.foundation().network_cancel(request_id);
}
#[cfg(not(target_os = "android"))]
pub fn cancel_network(_app: &AppHandle, _request_id: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_kimi_8k_batches_inside_the_reduced_budget() {
        let (_, model) = resolve(&TranslationPreferences {
            provider_id: "moonshot".into(),
            model_id: "moonshot-v1-8k".into(),
        })
        .unwrap();
        let source = (0..7)
            .map(|index| SourceSegment {
                id: index.to_string(),
                kind: "paragraph".into(),
                text: "a".repeat(700),
                source_hash: String::new(),
            })
            .collect();
        let batches = make_batches(source, model);
        assert_eq!(batches.len(), 2);
        assert!(batches.iter().all(|batch| batch.len() <= 6
            && batch.iter().map(|item| item.text.len()).sum::<usize>() <= 4_000));
    }

    #[test]
    fn cache_identity_separates_non_deepseek_providers() {
        assert_eq!(
            cache_model(&TranslationPreferences {
                provider_id: "openai".into(),
                model_id: "gpt-5.4-nano".into()
            })
            .unwrap(),
            "openai:gpt-5.4-nano"
        );
        assert_eq!(
            cache_model(&default_preferences()).unwrap(),
            "deepseek-v4-flash"
        );
    }
}
