use crate::{
    atomic_file,
    dictionary_query::{
        DictionaryEntryResult, DictionaryLookupRequest, DictionaryLookupResult,
        DictionarySenseGroup, LexemeDetail,
    },
    learning_contract::create_lexeme_key,
    mobile_online,
    platform_error::PlatformError,
    platform_paths::PlatformPaths,
    platform_state::PlatformState,
};
#[cfg(target_os = "android")]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{Duration as ChronoDuration, Utc};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

#[cfg(target_os = "android")]
const SECRET_SLOT: &str = "baidu-dictionary";
const TOKEN_URL: &str = "https://aip.baidubce.com/oauth/2.0/token";
const LOOKUP_URL: &str = "https://aip.baidubce.com/rpc/2.0/mt/texttrans-with-dict/v1";
const CACHE_VERSION: &str = "parser-v1";
const CACHE_LIMIT: u64 = 64 * 1024 * 1024;
const CONTEXT_PROMPT_VERSION: &str = "dictionary-context-v2";
const EXAMPLE_PROMPT_VERSION: &str = "dictionary-example-translation-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaiduCredentials {
    api_key: String,
    secret_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryCredentialStatus {
    pub configured: bool,
    pub api_key: mobile_online::KeyStatus,
    pub secret_key: mobile_online::KeyStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaiduEnrichment {
    lemma: String,
    phonetic: Option<String>,
    senses: Vec<DictionarySenseGroup>,
    forms: Vec<String>,
    examples: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEnvelope {
    expires_at: String,
    value: Option<BaiduEnrichment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextDefinition {
    pub meaning_zh: String,
    pub part_of_speech: String,
    pub explanation_zh: String,
    pub phrase: Option<String>,
    pub confidence: String,
    pub cached: bool,
    pub basis: String,
    pub resolved_lexeme_key: Option<String>,
    pub resolved_lemma: Option<String>,
}

pub fn credential_status(app: &AppHandle) -> Result<DictionaryCredentialStatus, PlatformError> {
    let configured = secret_status(app)?;
    let status = || mobile_online::KeyStatus {
        configured,
        masked: configured.then_some("••••••••"),
    };
    Ok(DictionaryCredentialStatus {
        configured,
        api_key: status(),
        secret_key: status(),
    })
}

pub fn save_candidate_credentials(
    app: &AppHandle,
    api_key: &str,
    secret_key: &str,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    let credentials = validate_credentials(api_key, secret_key)?;
    let result = test_with_credentials(app, &credentials)?;
    if !result.ok {
        return Ok(result);
    }
    save_credentials(app, &credentials)?;
    Ok(result)
}

pub fn delete_credentials(app: &AppHandle) -> Result<(), PlatformError> {
    delete_secret(app)
}

pub fn test_connection(
    app: &AppHandle,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    let credentials = load_credentials(app)?.ok_or_else(|| {
        PlatformError::new(
            "secretMissing",
            "请先保存百度 API Key 和 Secret Key。",
            false,
        )
    })?;
    test_with_credentials(app, &credentials)
}

fn test_with_credentials(
    app: &AppHandle,
    credentials: &BaiduCredentials,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    let token = access_token(app, credentials)?;
    let value = request_lookup(app, &token, "dictionary")?;
    let parsed = parse_enrichment(&value, "lex_en_connection_test")?;
    Ok(if parsed.is_some() {
        mobile_online::ConnectionTestResult {
            ok: true,
            message: "连接成功，百度词典增强可用。".into(),
        }
    } else {
        mobile_online::ConnectionTestResult {
            ok: false,
            message: "连接成功，但测试词未返回词典数据。".into(),
        }
    })
}

pub fn enhance_lookup(
    app: &AppHandle,
    paths: &PlatformPaths,
    result: &mut DictionaryLookupResult,
) -> Result<(), PlatformError> {
    result.requested_provider_id = "baidu";
    let credentials = load_credentials(app)?.ok_or_else(|| {
        PlatformError::new("secretMissing", "请先在词典设置中保存百度凭据。", false)
    })?;
    let lexeme_key = result
        .lexeme_key
        .clone()
        .unwrap_or_else(|| create_lexeme_key("en", &result.normalized));
    let enrichment = cached_lookup(app, paths, &credentials, &result.normalized, &lexeme_key)?;
    if let Some(enrichment) = enrichment {
        merge_lookup(result, enrichment, &lexeme_key);
    }
    Ok(())
}

pub fn enhance_lexeme(
    app: &AppHandle,
    paths: &PlatformPaths,
    detail: &mut LexemeDetail,
) -> Result<(), PlatformError> {
    let credentials = load_credentials(app)?.ok_or_else(|| {
        PlatformError::new("secretMissing", "请先在词典设置中保存百度凭据。", false)
    })?;
    if let Some(enrichment) = cached_lookup(
        app,
        paths,
        &credentials,
        &detail.summary.lemma,
        &detail.summary.lexeme_key,
    )? {
        if !enrichment.senses.is_empty() {
            detail.entries = vec![DictionaryEntryResult {
                word: enrichment.lemma.clone(),
                phonetic: enrichment.phonetic.clone(),
                senses: enrichment.senses,
                position_weights: None,
                tags: Vec::new(),
                frequency: detail.summary.frequency.clone(),
                exchanges: enrichment.forms.clone(),
            }];
        }
        detail.summary.phonetic = enrichment.phonetic.or(detail.summary.phonetic.take());
        detail.forms.extend(enrichment.forms);
        detail.forms.sort();
        detail.forms.dedup();
        detail.examples = enrichment.examples;
        detail.provider_id = "baidu";
    }
    Ok(())
}

pub fn translate_examples(
    app: &AppHandle,
    state: &PlatformState,
    examples: &mut [Value],
) -> Result<(), PlatformError> {
    if examples.is_empty() {
        return Ok(());
    }
    let (enabled, preferences) = {
        let database = state.database()?;
        (
            crate::dictionary_query::get_preferences(&database)?.translate_examples,
            mobile_online::get_preferences(&database)?,
        )
    };
    if !enabled
        || !examples
            .iter()
            .any(|item| item.get("translationZh").map_or(true, Value::is_null))
    {
        return Ok(());
    }
    let texts = examples
        .iter()
        .map(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_owned()
        })
        .collect::<Vec<_>>();
    if texts
        .iter()
        .any(|text| text.is_empty() || text.chars().count() > 200)
        || texts.len() > 4
    {
        return Err(PlatformError::new(
            "invalidInput",
            "例句翻译请求无效。",
            false,
        ));
    }
    let cache_model = mobile_online::cache_model(&preferences)?;
    let cache_key = sha256(
        &serde_json::to_string(
            &json!({"version":EXAMPLE_PROMPT_VERSION,"model":cache_model,"texts":texts}),
        )
        .unwrap_or_default(),
    );
    let file = state
        .paths
        .cache
        .join("dictionary")
        .join("example-translations")
        .join(format!("{cache_key}.json"));
    let translations = fs::read(&file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .filter(|values| valid_example_translations(values, texts.len()))
        .unwrap_or_default();
    let translations = if translations.is_empty() {
        let key = mobile_online::translation_key(app, &preferences)?;
        let parsed = mobile_online::complete_json(app, &preferences, &key,
            "将英文学习例句准确、简洁地翻译成简体中文，保持原意和语气，不添加解释。只返回 JSON：{\"translations\":[\"译文1\",\"译文2\"]}，数量和顺序必须与输入完全一致。",
            json!({"examples":texts}))?;
        let values = parsed
            .get("translations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|value| value.trim().to_owned())
            .collect::<Vec<_>>();
        if !valid_example_translations(&values, texts.len()) {
            return Err(PlatformError::new(
                "invalidResponse",
                "模型返回的例句译文不完整。",
                true,
            ));
        }
        atomic_file::atomic_replace(
            &file,
            &serde_json::to_vec(&values).map_err(|_| PlatformError::storage_unavailable())?,
        )?;
        values
    } else {
        translations
    };
    for (item, translation) in examples.iter_mut().zip(translations) {
        if let Some(object) = item.as_object_mut() {
            object.insert("translationZh".into(), Value::String(translation));
        }
    }
    Ok(())
}

fn valid_example_translations(values: &[String], expected: usize) -> bool {
    values.len() == expected
        && values
            .iter()
            .all(|value| !value.trim().is_empty() && value.chars().count() <= 500)
}

fn merge_lookup(
    result: &mut DictionaryLookupResult,
    enrichment: BaiduEnrichment,
    lexeme_key: &str,
) {
    if !enrichment.senses.is_empty() {
        result.entries = vec![DictionaryEntryResult {
            word: enrichment.lemma.clone(),
            phonetic: enrichment.phonetic.clone(),
            senses: enrichment.senses,
            position_weights: None,
            tags: Vec::new(),
            frequency: result.metadata.frequency.clone(),
            exchanges: enrichment.forms.clone(),
        }];
        result.found = true;
    }
    if result.lexeme_key.is_some() {
        result.lexeme_key = Some(lexeme_key.to_owned());
    }
    result.lemma = enrichment.lemma;
    result.examples = enrichment.examples;
    result.resolved_provider_id = "baidu";
    result.fallback_used = false;
}

fn cached_lookup(
    app: &AppHandle,
    paths: &PlatformPaths,
    credentials: &BaiduCredentials,
    query: &str,
    lexeme_key: &str,
) -> Result<Option<BaiduEnrichment>, PlatformError> {
    let normalized = query.trim().to_lowercase();
    let key = sha256(&format!(
        "en\u{1f}zh\u{1f}{normalized}\u{1f}{CACHE_VERSION}"
    ));
    let file = cache_root(paths).join(format!("{key}.json"));
    if let Ok(bytes) = fs::read(&file) {
        if let Ok(envelope) = serde_json::from_slice::<CacheEnvelope>(&bytes) {
            if chrono::DateTime::parse_from_rfc3339(&envelope.expires_at)
                .ok()
                .is_some_and(|expiry| expiry > Utc::now())
            {
                let _ = filetime_touch(&file);
                return Ok(envelope.value);
            }
        }
        let _ = fs::remove_file(&file);
    }
    let token = access_token(app, credentials)?;
    let value = parse_enrichment(&request_lookup(app, &token, &normalized)?, lexeme_key)?;
    let ttl = if value.is_some() {
        ChronoDuration::days(30)
    } else {
        ChronoDuration::days(1)
    };
    let envelope = CacheEnvelope {
        expires_at: (Utc::now() + ttl).to_rfc3339(),
        value: value.clone(),
    };
    atomic_file::atomic_replace(
        &file,
        &serde_json::to_vec(&envelope).map_err(|_| PlatformError::storage_unavailable())?,
    )?;
    trim_cache(&cache_root(paths));
    Ok(value)
}

fn access_token(app: &AppHandle, credentials: &BaiduCredentials) -> Result<String, PlatformError> {
    let body = format!(
        "grant_type=client_credentials&client_id={}&client_secret={}",
        utf8_percent_encode(&credentials.api_key, NON_ALPHANUMERIC),
        utf8_percent_encode(&credentials.secret_key, NON_ALPHANUMERIC)
    );
    let (status, value) = native_json(
        app,
        TOKEN_URL,
        json!({"Content-Type":"application/x-www-form-urlencoded"}),
        body.as_bytes(),
        10_000,
        4 * 1024 * 1024,
    )?;
    if !(200..300).contains(&status) {
        return Err(PlatformError::new(
            "secretRejected",
            "百度词典鉴权失败。",
            false,
        ));
    }
    value
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            PlatformError::new("secretRejected", "百度词典鉴权未返回 Access Token。", false)
        })
}

fn request_lookup(app: &AppHandle, token: &str, query: &str) -> Result<Value, PlatformError> {
    let url = format!(
        "{LOOKUP_URL}?access_token={}",
        utf8_percent_encode(token, NON_ALPHANUMERIC)
    );
    let body = serde_json::to_vec(&json!({"q":query,"from":"en","to":"zh"}))
        .map_err(|_| PlatformError::new("invalidInput", "百度词典请求无效。", false))?;
    let (status, value) = native_json(
        app,
        &url,
        json!({"Content-Type":"application/json;charset=utf-8"}),
        &body,
        10_000,
        4 * 1024 * 1024,
    )?;
    if status == 429 || status >= 500 {
        return Err(PlatformError::new(
            "serviceUnavailable",
            "百度词典暂时不可用。",
            true,
        ));
    }
    if !(200..300).contains(&status) {
        return Err(PlatformError::new(
            "serviceUnavailable",
            "百度词典请求失败。",
            false,
        ));
    }
    if value.get("error_code").and_then(Value::as_i64).is_some() {
        return Err(PlatformError::new(
            "serviceUnavailable",
            "百度词典返回服务错误。",
            true,
        ));
    }
    Ok(value)
}

fn parse_enrichment(
    outer: &Value,
    lexeme_key: &str,
) -> Result<Option<BaiduEnrichment>, PlatformError> {
    let dictionary = outer
        .pointer("/result/trans_result/0/dict")
        .and_then(Value::as_str);
    let Some(dictionary) = dictionary else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(dictionary)
        .map_err(|_| PlatformError::new("invalidResponse", "百度词典返回格式不正确。", false))?;
    let simple = &value["word_result"]["simple_means"];
    if !simple.is_object() {
        return Ok(None);
    }
    let lemma = simple
        .get("word_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let symbol = simple
        .get("symbols")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or(Value::Null);
    let phonetic = symbol
        .get("ph_en")
        .or_else(|| symbol.get("ph_am"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty());
    let mut senses = Vec::new();
    for part in symbol
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let translations = part
            .get("means")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|value| value.chars().any(is_han))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !translations.is_empty() {
            senses.push(DictionarySenseGroup {
                part_of_speech: normalize_pos(
                    part.get("part").and_then(Value::as_str).unwrap_or("其他"),
                ),
                translations,
                definitions: Vec::new(),
            });
        }
    }
    if senses.is_empty() {
        let translations = simple
            .get("word_means")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|value| value.chars().any(is_han))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !translations.is_empty() {
            senses.push(DictionarySenseGroup {
                part_of_speech: "其他".into(),
                translations,
                definitions: Vec::new(),
            });
        }
    }
    let forms = simple
        .get("exchange")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|values| values.values())
        .flat_map(|value| value.as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let mut examples = Vec::new();
    for item in value["word_result"]["edict"]["item"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let pos = normalize_pos(item.get("pos").and_then(Value::as_str).unwrap_or("其他"));
        for group in item
            .get("tr_group")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            for text in group
                .get("example")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if (20..=160).contains(&text.chars().count()) && examples.len() < 2 {
                    examples.push(json!({"exampleId":sha256(&format!("{lexeme_key}\u{1f}{}", text.trim().to_lowercase())),"text":text,"translationZh":null,"partOfSpeech":pos,"definition":null,"providerId":"baidu"}));
                }
            }
        }
    }
    Ok(Some(BaiduEnrichment {
        lemma,
        phonetic,
        senses,
        forms,
        examples,
    }))
}

pub fn explain_context(
    app: &AppHandle,
    state: &PlatformState,
    request: &DictionaryLookupRequest,
    result: &DictionaryLookupResult,
    preferred_lexeme_key: Option<&str>,
) -> Result<ContextDefinition, PlatformError> {
    let preferences = {
        let database = state.database()?;
        mobile_online::get_preferences(&database)?
    };
    let key = mobile_online::translation_key(app, &preferences)?;
    let basis = if preferred_lexeme_key.is_some() {
        "selected-lexeme"
    } else if result.candidates.is_empty() {
        "context-only"
    } else {
        "auto-candidates"
    };
    let resolved = if let Some(key) = preferred_lexeme_key {
        result
            .candidates
            .iter()
            .find(|candidate| candidate.lexeme_key == key)
    } else if !result.requires_selection {
        result.candidates.first()
    } else {
        None
    };
    let candidate_digest = sha256(
        &serde_json::to_string(
            &result
                .candidates
                .iter()
                .map(|item| (&item.lexeme_key, &item.lemma, item.confidence))
                .collect::<Vec<_>>(),
        )
        .unwrap_or_default(),
    );
    let dictionary_version = result.dictionary_version.as_deref().unwrap_or("none");
    let cache_key = sha256(
        &[
            result.normalized.as_str(),
            basis,
            preferred_lexeme_key.unwrap_or(&candidate_digest),
            request.block_id.as_str(),
            &sha256(&result.paragraph),
            &sha256(&result.sentence),
            dictionary_version,
            &format!("{}:{}", preferences.provider_id, preferences.model_id),
            CONTEXT_PROMPT_VERSION,
        ]
        .join("\u{1f}"),
    );
    {
        let database = state.database()?;
        let cached = database
            .connection()
            .query_row(
                "SELECT result_json FROM context_definitions WHERE cache_key=?1",
                [&cache_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| PlatformError::database_corrupt())?;
        if let Some(cached) = cached {
            if let Ok(mut value) = serde_json::from_str::<ContextDefinition>(&cached) {
                value.cached = true;
                return Ok(value);
            }
        }
    }
    let system = "你是严谨的英语词义辨析助手。结合英文语境判断所点词语在文中的含义。词典候选仅是辅助；没有候选或候选不确定时也必须根据语境作答，并相应降低 confidence。不要扩写文章，不要虚构原文信息。只返回 JSON：{\"meaningZh\":\"文中义\",\"partOfSpeech\":\"词性\",\"explanationZh\":\"一句简短说明\",\"phrase\":null,\"confidence\":\"high|medium|low\"}。";
    let parsed = mobile_online::complete_json(
        app,
        &preferences,
        &key,
        system,
        json!({"word":result.surface,"normalized":result.normalized,"basis":basis,"resolvedLemma":resolved.map(|item|item.lemma.as_str()),"sentence":result.sentence,"paragraph":result.paragraph,"candidates":result.candidates,"dictionaryEntries":result.entries}),
    )?;
    let required = |key: &str| {
        parsed
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                PlatformError::new("invalidResponse", "模型返回的文中义字段不完整。", true)
            })
    };
    let confidence = parsed
        .get("confidence")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "high" | "medium" | "low"))
        .unwrap_or("medium")
        .to_owned();
    let definition = ContextDefinition {
        meaning_zh: required("meaningZh")?,
        part_of_speech: required("partOfSpeech")?,
        explanation_zh: required("explanationZh")?,
        phrase: parsed
            .get("phrase")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|value| !value.is_empty()),
        confidence,
        cached: false,
        basis: basis.into(),
        resolved_lexeme_key: resolved.map(|item| item.lexeme_key.clone()),
        resolved_lemma: resolved.map(|item| item.lemma.clone()),
    };
    let lexeme_key = definition
        .resolved_lexeme_key
        .clone()
        .unwrap_or_else(|| create_lexeme_key("en", &result.normalized));
    let cache_model = mobile_online::cache_model(&preferences)?;
    let database = state.database()?;
    database.connection().execute("INSERT OR REPLACE INTO context_definitions(cache_key,lexeme_key,word,lemma,article_id,block_id,sentence_hash,dictionary_version,model,prompt_version,result_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)", params![cache_key,lexeme_key,result.normalized,definition.resolved_lemma.as_deref().unwrap_or(&result.normalized),request.article_id,request.block_id,sha256(&result.sentence),dictionary_version,cache_model,CONTEXT_PROMPT_VERSION,serde_json::to_string(&definition).map_err(|_|PlatformError::storage_unavailable())?,Utc::now().to_rfc3339()]).map_err(|_| PlatformError::storage_unavailable())?;
    Ok(definition)
}

fn validate_credentials(
    api_key: &str,
    secret_key: &str,
) -> Result<BaiduCredentials, PlatformError> {
    let api_key = api_key.trim();
    let secret_key = secret_key.trim();
    if api_key.len() < 16 || secret_key.len() < 16 {
        return Err(PlatformError::new(
            "invalidInput",
            "百度凭据格式无效。",
            false,
        ));
    }
    Ok(BaiduCredentials {
        api_key: api_key.into(),
        secret_key: secret_key.into(),
    })
}

fn cache_root(paths: &PlatformPaths) -> PathBuf {
    paths.cache.join("dictionary").join("baidu-v2")
}
fn sha256(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn is_han(value: char) -> bool {
    matches!(value as u32, 0x3400..=0x9fff)
}
fn normalize_pos(value: &str) -> String {
    match value.trim().trim_end_matches('.').to_lowercase().as_str() {
        "n" | "noun" => "名词 · n.".into(),
        "v" | "verb" => "动词 · v.".into(),
        "adj" | "adjective" => "形容词 · adj.".into(),
        "adv" | "adverb" => "副词 · adv.".into(),
        _ => value.trim().to_owned(),
    }
}
fn filetime_touch(path: &Path) -> std::io::Result<()> {
    let bytes = fs::read(path)?;
    fs::write(path, bytes)
}
fn trim_cache(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .map(|meta| (entry.path(), meta.len(), meta.modified().ok()))
        })
        .collect::<Vec<_>>();
    let mut total = files.iter().map(|item| item.1).sum::<u64>();
    files.sort_by_key(|item| item.2);
    for (path, size, _) in files {
        if total <= CACHE_LIMIT {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size)
        }
    }
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
    let encoded = BASE64.encode(body);
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
            body_base64: Some(&encoded),
        })
        .map_err(|error| match error.code() {
            Some("networkTimeout") => {
                PlatformError::new("networkTimeout", "在线服务请求超时。", true)
            }
            Some("networkOffline") => {
                PlatformError::new("networkOffline", "当前设备无法连接网络。", true)
            }
            Some("networkTls") => PlatformError::new("networkTls", "TLS 验证失败。", false),
            Some("networkResponseTooLarge") => PlatformError::new(
                "networkResponseTooLarge",
                "在线服务响应超过大小限制。",
                false,
            ),
            _ => PlatformError::new("networkTransport", "在线服务网络请求失败。", true),
        })?;
    let bytes = BASE64
        .decode(response.body_base64)
        .map_err(|_| PlatformError::new("invalidResponse", "在线服务返回格式不正确。", true))?;
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
        "当前平台未启用移动在线服务。",
        false,
    ))
}

#[cfg(target_os = "android")]
fn load_credentials(app: &AppHandle) -> Result<Option<BaiduCredentials>, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let value = app
        .foundation()
        .secret_load(SECRET_SLOT)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法读取百度凭据。", false))?
        .value;
    value
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| {
                PlatformError::new("secretUnavailable", "已保存的百度凭据无法读取。", false)
            })
        })
        .transpose()
}
#[cfg(not(target_os = "android"))]
fn load_credentials(_app: &AppHandle) -> Result<Option<BaiduCredentials>, PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用 Android Keystore。",
        false,
    ))
}
#[cfg(target_os = "android")]
fn save_credentials(app: &AppHandle, value: &BaiduCredentials) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let encoded = serde_json::to_string(value)
        .map_err(|_| PlatformError::new("invalidInput", "百度凭据无效。", false))?;
    app.foundation()
        .secret_save(SECRET_SLOT, &encoded)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法安全保存百度凭据。", false))
}
#[cfg(not(target_os = "android"))]
fn save_credentials(_app: &AppHandle, _value: &BaiduCredentials) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用 Android Keystore。",
        false,
    ))
}
#[cfg(target_os = "android")]
fn delete_secret(app: &AppHandle) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_delete(SECRET_SLOT)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法删除百度凭据。", false))
}
#[cfg(not(target_os = "android"))]
fn delete_secret(_app: &AppHandle) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "unsupportedPlatform",
        "当前平台未启用 Android Keystore。",
        false,
    ))
}
#[cfg(target_os = "android")]
fn secret_status(app: &AppHandle) -> Result<bool, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation()
        .secret_status(SECRET_SLOT)
        .map(|status| status.configured)
        .map_err(|_| PlatformError::new("secretUnavailable", "无法读取百度凭据状态。", false))
}
#[cfg(not(target_os = "android"))]
fn secret_status(_app: &AppHandle) -> Result<bool, PlatformError> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidate_cache_key_is_stable() {
        assert_eq!(sha256("en\u{1f}zh\u{1f}take\u{1f}parser-v1").len(), 64)
    }
    #[test]
    fn keeps_context_only_identity_separate() {
        assert_ne!(
            create_lexeme_key("en", "unlisted"),
            create_lexeme_key("en", "listed")
        )
    }
}
