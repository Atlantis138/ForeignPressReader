use super::*;

#[tauri::command]
pub fn get_mobile_dictionary_status(
    state: tauri::State<'_, PlatformState>,
) -> Result<DictionaryPackStatus, PlatformError> {
    dictionary_pack::status(&state.paths)
}

#[tauri::command]
pub fn get_mobile_dictionary_center_status(
    state: tauri::State<'_, PlatformState>,
) -> Result<MobileDictionaryCenterStatus, PlatformError> {
    let (resource, health) = match state.dictionary_runtime().fast_status(&state.paths) {
        Ok(resource) => {
            let health = if resource.installed {
                "ready"
            } else {
                "missing"
            };
            (resource, health)
        }
        Err(_) => {
            let base_installed = dictionary_pack::installed_database_path(&state.paths).exists();
            let full_installed =
                dictionary_pack::installed_full_database_path(&state.paths).exists();
            let installing = state.dictionary_runtime().install_active();
            let local = |installed| DictionaryLocalPackStatus {
                installed,
                installing,
                version: None,
                entry_count: 0,
                form_count: 0,
                size_bytes: 0,
            };
            (
                DictionaryResourceStatus {
                    provider_id: "ecdict",
                    installed: base_installed,
                    base_installed,
                    full_extension_installed: full_installed,
                    extension_compatible: false,
                    effective_profile: if base_installed { "standard" } else { "none" },
                    installing,
                    base: local(base_installed),
                    full: local(full_installed),
                    version: None,
                    entry_count: 0,
                    form_count: 0,
                    size_bytes: 0,
                    source: "local",
                    license: "MIT",
                },
                "damaged",
            )
        }
    };
    Ok(MobileDictionaryCenterStatus {
        resource,
        health,
        online_enhancement: MobileDictionaryOnlineEnhancement {
            available: false,
            phase: "reserved-e4",
            cache_status: "disabled",
            updated_at: None,
        },
    })
}

#[tauri::command]
pub fn preflight_mobile_dictionary_install(
    state: tauri::State<'_, PlatformState>,
    profile: String,
) -> dictionary_pack::DictionaryInstallPreflight {
    dictionary_pack::install_preflight(&state.paths, &profile)
}

#[tauri::command]
pub async fn install_mobile_dictionary_online(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request_id: String,
    profile: Option<String>,
) -> Result<DictionaryPackStatus, PlatformError> {
    let cancelled = state.dictionary_runtime().begin_install(&request_id)?;
    let result: Result<DictionaryPackStatus, PlatformError> = async {
        dictionary_pack::ensure_online_build_space(&state.paths)?;
        let (csv_path, lemma_path) =
            dictionary_pack::prepare_online_source_paths(&state.paths, &request_id)?;
        download_dictionary_source_on_platform(
            &app,
            &request_id,
            "ecdict.csv",
            &csv_path,
            dictionary_builder::ECDICT_CSV_SIZE,
            dictionary_builder::ECDICT_CSV_BLOB_SHA,
            &cancelled,
        )?;
        download_dictionary_source_on_platform(
            &app,
            &request_id,
            "lemma.en.txt",
            &lemma_path,
            dictionary_builder::ECDICT_LEMMA_SIZE,
            dictionary_builder::ECDICT_LEMMA_BLOB_SHA,
            &cancelled,
        )?;
        if cancelled.load(Ordering::Relaxed) {
            return Err(PlatformError::new(
                "dictionaryInstallCancelled",
                "词典预载已取消。",
                false,
            ));
        }
        state.dictionary_runtime().cancel_all_queries();
        let paths = state.paths.clone();
        let build_request = request_id.clone();
        let build_cancelled = cancelled.clone();
        let build_profile = profile.unwrap_or_else(|| "standard".into());
        emit_dictionary_install_progress(
            &app,
            "indexing-entries",
            0,
            0,
            0,
            Some(if build_profile == "full" {
                "正在构建完整 ECDICT 索引，可能需要数分钟。"
            } else {
                "正在筛选标准词条并构建离线索引，可能需要数分钟。"
            }),
        );
        tauri::async_runtime::spawn_blocking(move || {
            if build_profile == "full" {
                dictionary_builder::build_full_and_publish(
                    &paths,
                    &build_request,
                    &csv_path,
                    &lemma_path,
                    &build_cancelled,
                )
            } else {
                dictionary_builder::build_and_publish(
                    &paths,
                    &build_request,
                    &csv_path,
                    &lemma_path,
                    &build_cancelled,
                )
            }
        })
        .await
        .map_err(|_| {
            PlatformError::new(
                "learningDatabaseUnavailable",
                "词典构建任务异常结束。",
                true,
            )
        })?
    }
    .await;
    if result.is_err() {
        dictionary_pack::cleanup_request(&state.paths, &request_id);
    }
    state.dictionary_runtime().finish_install(&request_id);
    if result.is_ok() {
        state.dictionary_runtime().invalidate_generation();
    }
    match &result {
        Ok(_) => emit_dictionary_install_progress(
            &app,
            "completed",
            1,
            1,
            0,
            Some("ECDICT 离线词典已安装。"),
        ),
        Err(error) if error.code == "dictionaryInstallCancelled" => {
            emit_dictionary_install_progress(&app, "cancelled", 0, 0, 0, Some("词典安装已取消。"))
        }
        Err(_) => emit_dictionary_install_progress(
            &app,
            "error",
            0,
            0,
            0,
            Some("词典安装失败，原有资源未改变。"),
        ),
    }
    result
}

#[tauri::command]
pub async fn select_and_install_mobile_dictionary(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request_id: String,
    profile: Option<String>,
) -> Result<MobileDictionaryInstallResult, PlatformError> {
    let _cancelled = state.dictionary_runtime().begin_install(&request_id)?;
    let result: Result<MobileDictionaryInstallResult, PlatformError> = async {
        let destination = dictionary_pack::prepare_install_destination(&state.paths, &request_id)?;
        let selection = select_dictionary_pack_on_platform(&app, &request_id, &destination)?;
        if selection.cancelled {
            dictionary_pack::cleanup_request(&state.paths, &request_id);
            return Ok(MobileDictionaryInstallResult {
                cancelled: true,
                status: dictionary_pack::status(&state.paths)?,
            });
        }
        state.dictionary_runtime().cancel_all_queries();
        let paths = state.paths.clone();
        let install_profile = profile.unwrap_or_else(|| "standard".into());
        emit_dictionary_install_progress(
            &app,
            "finalizing",
            0,
            0,
            0,
            Some("正在校验并发布本地词典包。"),
        );
        let status = tauri::async_runtime::spawn_blocking(move || {
            if install_profile == "full" {
                dictionary_pack::install_full_package(&paths, &destination)
            } else {
                dictionary_pack::install_package(&paths, &destination)
            }
        })
        .await
        .map_err(|_| {
            PlatformError::new(
                "learningDatabaseUnavailable",
                "词典安装任务异常结束。",
                true,
            )
        })??;
        Ok(MobileDictionaryInstallResult {
            cancelled: false,
            status,
        })
    }
    .await;
    if result.is_err() {
        dictionary_pack::cleanup_request(&state.paths, &request_id);
    }
    state.dictionary_runtime().finish_install(&request_id);
    if result.is_ok() {
        state.dictionary_runtime().invalidate_generation();
    }
    match &result {
        Ok(value) if !value.cancelled => {
            emit_dictionary_install_progress(&app, "completed", 1, 1, 0, Some("本地词典包已安装。"))
        }
        Ok(_) => emit_dictionary_install_progress(
            &app,
            "cancelled",
            0,
            0,
            0,
            Some("已取消选择，原有词典未改变。"),
        ),
        Err(error) if error.code == "dictionaryInstallCancelled" => {
            emit_dictionary_install_progress(&app, "cancelled", 0, 0, 0, Some("词典安装已取消。"))
        }
        Err(_) => emit_dictionary_install_progress(
            &app,
            "error",
            0,
            0,
            0,
            Some("本地词典包安装失败，原有资源未改变。"),
        ),
    }
    result
}

#[tauri::command]
pub fn cancel_mobile_dictionary_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request_id: String,
) -> Result<(), PlatformError> {
    state.dictionary_runtime().cancel_install(&request_id);
    #[cfg(target_os = "android")]
    {
        use fpr_platform_plugin::FoundationExt;
        let _ = app.foundation().cancel_dictionary_pack_install(&request_id);
        let _ = app
            .foundation()
            .cancel_dictionary_source_download(&request_id);
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    #[cfg(target_os = "android")]
    emit_dictionary_install_progress(&app, "cancelled", 0, 0, 0, Some("正在取消词典安装…"));
    Ok(())
}

#[tauri::command]
pub fn remove_mobile_dictionary(
    state: tauri::State<'_, PlatformState>,
) -> Result<(), PlatformError> {
    if state.dictionary_runtime().install_active() {
        return Err(PlatformError::new(
            "learningDatabaseUnavailable",
            "词典安装期间不能删除资源。",
            true,
        ));
    }
    state.dictionary_runtime().cancel_all_queries();
    dictionary_pack::remove(&state.paths)?;
    state.dictionary_runtime().invalidate_generation();
    Ok(())
}

#[tauri::command]
pub fn remove_mobile_dictionary_full_extension(
    state: tauri::State<'_, PlatformState>,
) -> Result<(), PlatformError> {
    state.dictionary_runtime().cancel_all_queries();
    dictionary_pack::remove_full(&state.paths)?;
    state.dictionary_runtime().invalidate_generation();
    Ok(())
}

#[tauri::command]
pub async fn repair_mobile_dictionary(
    state: tauri::State<'_, PlatformState>,
    _profile: String,
) -> Result<(), PlatformError> {
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || dictionary_pack::deep_verify(&paths))
        .await
        .map_err(|_| {
            PlatformError::new(
                "learningDatabaseUnavailable",
                "词典校验任务异常结束。",
                true,
            )
        })??;
    state.dictionary_runtime().invalidate_generation();
    Ok(())
}

#[tauri::command]
pub async fn lookup_mobile_dictionary(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request_id: String,
    request: DictionaryLookupRequest,
    preferred_lexeme_key: Option<String>,
) -> Result<dictionary_query::DictionaryLookupResult, PlatformError> {
    let resource = state.dictionary_runtime().fast_status(&state.paths)?;
    resource
        .installed
        .then_some(())
        .ok_or_else(|| PlatformError::new("dictionaryNotInstalled", "尚未安装本地词典。", false))?;
    let context = {
        let database = state.database()?;
        mobile_reading::dictionary_lookup_context(&database, &request)?
    };
    let cancelled = state.dictionary_runtime().begin_query(&request_id)?;
    let path = dictionary_pack::installed_database_path(&state.paths);
    let full_path = resource
        .extension_compatible
        .then(|| dictionary_pack::installed_full_database_path(&state.paths));
    let task = tauri::async_runtime::spawn_blocking(move || {
        dictionary_query::lookup_with_extension(
            &path,
            full_path.as_deref(),
            context,
            preferred_lexeme_key.as_deref(),
            &cancelled,
        )
    })
    .await;
    state.dictionary_runtime().finish_query(&request_id);
    let mut result = task.map_err(|_| {
        PlatformError::new(
            "learningDatabaseUnavailable",
            "词典查询任务异常结束。",
            true,
        )
    })??;
    let preferences = {
        let database = state.database()?;
        dictionary_query::get_preferences(&database)?
    };
    if preferences.lookup_provider_id == "baidu" {
        if let Err(error) =
            mobile_dictionary_online::enhance_lookup(&app, &state.paths, &mut result)
        {
            if !preferences.fallback_to_local {
                return Err(error);
            }
            result.requested_provider_id = "baidu";
            result.resolved_provider_id = "ecdict";
            result.fallback_used = true;
        }
    }
    let _ = mobile_dictionary_online::translate_examples(&app, &state, &mut result.examples);
    Ok(result)
}

#[tauri::command]
pub async fn search_mobile_dictionary(
    state: tauri::State<'_, PlatformState>,
    request_id: String,
    query: MobileDictionarySearchQuery,
) -> Result<dictionary_query::DictionarySearchPage, PlatformError> {
    let resource = state.dictionary_runtime().fast_status(&state.paths)?;
    let cancelled = state.dictionary_runtime().begin_query(&request_id)?;
    let path = dictionary_pack::installed_database_path(&state.paths);
    let full_path = resource
        .extension_compatible
        .then(|| dictionary_pack::installed_full_database_path(&state.paths));
    let task = tauri::async_runtime::spawn_blocking(move || {
        dictionary_query::search_with_extension(&path, full_path.as_deref(), query, &cancelled)
    })
    .await;
    state.dictionary_runtime().finish_query(&request_id);
    task.map_err(|_| {
        PlatformError::new(
            "learningDatabaseUnavailable",
            "词典搜索任务异常结束。",
            true,
        )
    })?
}

#[tauri::command]
pub async fn get_mobile_dictionary_lexeme(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    lexeme_key: String,
) -> Result<dictionary_query::LexemeDetail, PlatformError> {
    let resource = state.dictionary_runtime().fast_status(&state.paths)?;
    let path = dictionary_pack::installed_database_path(&state.paths);
    let full_path = resource
        .extension_compatible
        .then(|| dictionary_pack::installed_full_database_path(&state.paths));
    let mut detail = tauri::async_runtime::spawn_blocking(move || {
        dictionary_query::get_lexeme_with_extension(&path, full_path.as_deref(), &lexeme_key)
    })
    .await
    .map_err(|_| {
        PlatformError::new(
            "learningDatabaseUnavailable",
            "词条读取任务异常结束。",
            true,
        )
    })??;
    let preferences = {
        let database = state.database()?;
        dictionary_query::get_preferences(&database)?
    };
    if preferences.lookup_provider_id == "baidu" {
        if let Err(error) =
            mobile_dictionary_online::enhance_lexeme(&app, &state.paths, &mut detail)
        {
            if !preferences.fallback_to_local {
                return Err(error);
            }
        }
    }
    let _ = mobile_dictionary_online::translate_examples(&app, &state, &mut detail.examples);
    Ok(detail)
}

#[tauri::command]
pub async fn hydrate_mobile_study_examples(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    session_id: String,
    item_id: String,
    expected_version: i64,
) -> Result<Vec<serde_json::Value>, PlatformError> {
    let lexeme_key = {
        let database = state.database()?;
        mobile_study::current_item_lexeme(&database, &session_id, &item_id, expected_version)?
    };
    let resource = state.dictionary_runtime().fast_status(&state.paths)?;
    if !resource.installed {
        return Ok(Vec::new());
    }
    let path = dictionary_pack::installed_database_path(&state.paths);
    let full_path = resource
        .extension_compatible
        .then(|| dictionary_pack::installed_full_database_path(&state.paths));
    let mut detail = tauri::async_runtime::spawn_blocking(move || {
        dictionary_query::get_lexeme_with_extension(&path, full_path.as_deref(), &lexeme_key)
    })
    .await
    .map_err(|_| {
        PlatformError::new(
            "learningDatabaseUnavailable",
            "学习例句读取任务异常结束。",
            true,
        )
    })??;
    let preferences = {
        let database = state.database()?;
        dictionary_query::get_preferences(&database)?
    };
    if preferences.lookup_provider_id == "baidu" {
        if let Err(error) =
            mobile_dictionary_online::enhance_lexeme(&app, &state.paths, &mut detail)
        {
            if !preferences.fallback_to_local {
                return Err(error);
            }
        }
    }
    let _ = mobile_dictionary_online::translate_examples(&app, &state, &mut detail.examples);
    Ok(detail.examples)
}

#[tauri::command]
pub async fn get_mobile_lexeme_source(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    lexeme_key: String,
) -> Result<MobileLexemeSource, PlatformError> {
    let user = {
        let database = state.database()?;
        mobile_vocabulary::get_lexeme_snapshot(&database, &lexeme_key)?
    };
    let resource = state.dictionary_runtime().fast_status(&state.paths).ok();
    let local_profile = resource
        .as_ref()
        .map_or("none", |status| status.effective_profile);
    let mut detail = if resource.as_ref().is_some_and(|status| status.installed) {
        let path = dictionary_pack::installed_database_path(&state.paths);
        let full_path = resource
            .as_ref()
            .filter(|status| status.extension_compatible)
            .map(|_| dictionary_pack::installed_full_database_path(&state.paths));
        let key = lexeme_key.clone();
        tauri::async_runtime::spawn_blocking(move || {
            dictionary_query::get_lexeme_with_extension(&path, full_path.as_deref(), &key)
        })
        .await
        .map_err(|_| {
            PlatformError::new(
                "learningDatabaseUnavailable",
                "词条读取任务异常结束。",
                true,
            )
        })?
        .ok()
    } else {
        None
    };
    if let Some(value) = detail.as_mut() {
        let preferences = {
            let database = state.database()?;
            dictionary_query::get_preferences(&database)?
        };
        if preferences.lookup_provider_id == "baidu" {
            if let Err(error) = mobile_dictionary_online::enhance_lexeme(&app, &state.paths, value)
            {
                if !preferences.fallback_to_local {
                    return Err(error);
                }
            }
        }
        let _ = mobile_dictionary_online::translate_examples(&app, &state, &mut value.examples);
    }
    let favorite = user.as_ref().is_some_and(|value| value.favorite);
    let manual_state = user
        .as_ref()
        .map_or_else(|| "unrated".to_owned(), |value| value.manual_state.clone());
    let snapshot = user.map(|value| value.snapshot);
    if detail.is_none() && snapshot.is_none() {
        return Err(PlatformError::new(
            "learningEntityMissing",
            "词条不存在。",
            false,
        ));
    }
    Ok(MobileLexemeSource {
        source: if detail.is_some() {
            "resource"
        } else {
            "snapshot"
        },
        detail,
        snapshot,
        local_profile,
        favorite,
        manual_state,
    })
}

#[tauri::command]
pub fn list_mobile_dictionary_collections(
    state: tauri::State<'_, PlatformState>,
) -> Result<Vec<dictionary_query::DictionaryCollection>, PlatformError> {
    dictionary_query::list_collections(&dictionary_pack::installed_database_path(&state.paths))
}

#[tauri::command]
pub fn get_mobile_dictionary_preferences(
    state: tauri::State<'_, PlatformState>,
) -> Result<dictionary_query::DictionaryPreferences, PlatformError> {
    let database = state.database()?;
    dictionary_query::get_preferences(&database)
}

#[tauri::command]
pub fn save_mobile_dictionary_preferences(
    state: tauri::State<'_, PlatformState>,
    value: dictionary_query::DictionaryPreferences,
) -> Result<dictionary_query::DictionaryPreferences, PlatformError> {
    let database = state.database()?;
    dictionary_query::save_preferences(&database, value)
}

#[tauri::command]
pub fn get_mobile_dictionary_credential_status(
    app: tauri::AppHandle,
) -> Result<mobile_dictionary_online::DictionaryCredentialStatus, PlatformError> {
    mobile_dictionary_online::credential_status(&app)
}

#[tauri::command]
pub fn save_mobile_baidu_credentials(
    app: tauri::AppHandle,
    api_key: String,
    secret_key: String,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    mobile_dictionary_online::save_candidate_credentials(&app, &api_key, &secret_key)
}

#[tauri::command]
pub fn delete_mobile_baidu_credentials(app: tauri::AppHandle) -> Result<(), PlatformError> {
    mobile_dictionary_online::delete_credentials(&app)
}

#[tauri::command]
pub fn test_mobile_baidu_connection(
    app: tauri::AppHandle,
) -> Result<mobile_online::ConnectionTestResult, PlatformError> {
    mobile_dictionary_online::test_connection(&app)
}

#[tauri::command]
pub async fn explain_mobile_dictionary_context(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    request: DictionaryLookupRequest,
    preferred_lexeme_key: Option<String>,
) -> Result<mobile_dictionary_online::ContextDefinition, PlatformError> {
    let preferences = {
        let database = state.database()?;
        let preferences = dictionary_query::get_preferences(&database)?;
        if !preferences.context_explanation_enabled {
            return Err(PlatformError::new(
                "featureDisabled",
                "请先在设置中启用文中义分析。",
                false,
            ));
        }
        preferences
    };
    let resource = state.dictionary_runtime().fast_status(&state.paths)?;
    if !resource.installed {
        return Err(PlatformError::new(
            "dictionaryNotInstalled",
            "尚未安装本地词典。",
            false,
        ));
    }
    let context = {
        let database = state.database()?;
        mobile_reading::dictionary_lookup_context(&database, &request)?
    };
    let path = dictionary_pack::installed_database_path(&state.paths);
    let full_path = resource
        .extension_compatible
        .then(|| dictionary_pack::installed_full_database_path(&state.paths));
    let selected = preferred_lexeme_key.clone();
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        dictionary_query::lookup_with_extension(
            &path,
            full_path.as_deref(),
            context,
            selected.as_deref(),
            &AtomicBool::new(false),
        )
    })
    .await
    .map_err(|_| {
        PlatformError::new(
            "learningDatabaseUnavailable",
            "词典查询任务异常结束。",
            true,
        )
    })??;
    if preferences.lookup_provider_id == "baidu" {
        if let Err(error) =
            mobile_dictionary_online::enhance_lookup(&app, &state.paths, &mut result)
        {
            if !preferences.fallback_to_local {
                return Err(error);
            }
            result.fallback_used = true;
        }
    }
    mobile_dictionary_online::explain_context(
        &app,
        &state,
        &request,
        &result,
        preferred_lexeme_key.as_deref(),
    )
}

#[tauri::command]
pub fn cancel_mobile_dictionary_query(state: tauri::State<'_, PlatformState>, request_id: String) {
    state.dictionary_runtime().cancel_query(&request_id);
}
