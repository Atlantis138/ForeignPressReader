use super::*;

#[cfg(target_os = "android")]
pub(super) fn select_epub_on_platform(
    app: &tauri::AppHandle,
    request_id: &str,
    destination: &Path,
) -> Result<PlatformSelectedEpub, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let destination = destination.to_string_lossy();
    let selected = app
        .foundation()
        .select_epub(request_id, &destination)
        .map_err(|error| map_android_import_error(error.code()))?;
    Ok(PlatformSelectedEpub {
        cancelled: selected.cancelled,
        display_name: selected.display_name,
    })
}

#[cfg(target_os = "android")]
pub(super) fn package_storage_on_platform(
    app: &tauri::AppHandle,
) -> Result<PlatformStorageInfo, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let info = app.foundation().package_storage_info().map_err(|_| {
        PlatformError::new(
            "storageScanUnavailable",
            "无法读取 Android 应用存储信息。",
            true,
        )
    })?;
    Ok(PlatformStorageInfo {
        application_bytes: info.application_bytes,
        secret_bytes: info.secret_bytes,
    })
}

#[cfg(not(target_os = "android"))]
pub(super) fn package_storage_on_platform(
    _app: &tauri::AppHandle,
) -> Result<PlatformStorageInfo, PlatformError> {
    Ok(PlatformStorageInfo {
        application_bytes: 0,
        secret_bytes: 0,
    })
}

#[cfg(target_os = "android")]
pub(super) fn open_storage_settings_on_platform(
    app: &tauri::AppHandle,
) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    app.foundation().open_app_storage_settings().map_err(|_| {
        PlatformError::new(
            "storageSettingsUnavailable",
            "无法打开 Android 应用存储设置。",
            true,
        )
    })
}

#[cfg(not(target_os = "android"))]
pub(super) fn open_storage_settings_on_platform(
    _app: &tauri::AppHandle,
) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "platformUnavailable",
        "应用存储设置仅在 Android 可用。",
        false,
    ))
}

#[cfg(not(target_os = "android"))]
pub(super) fn select_epub_on_platform(
    _app: &tauri::AppHandle,
    _request_id: &str,
    _destination: &Path,
) -> Result<PlatformSelectedEpub, PlatformError> {
    Err(PlatformError::new(
        "platformUnavailable",
        "EPUB 系统选择器仅在 Android 可用。",
        false,
    ))
}

#[cfg(target_os = "android")]
pub(super) fn map_android_import_error(code: Option<&str>) -> PlatformError {
    match code {
        Some("importCancelled") => {
            PlatformError::new("importCancelled", "EPUB 导入已取消。", false)
        }
        Some("epubTooLarge") => {
            PlatformError::new("epubTooLarge", "EPUB 超过 500 MiB 限制。", false)
        }
        Some("importReadFailed") => {
            PlatformError::new("importReadFailed", "无法从系统文件选择器读取 EPUB。", true)
        }
        _ => PlatformError::new("importReadFailed", "EPUB 系统选择失败。", true),
    }
}

#[cfg(target_os = "android")]
pub(super) fn select_dictionary_pack_on_platform(
    app: &tauri::AppHandle,
    request_id: &str,
    destination: &Path,
) -> Result<PlatformSelectedEpub, PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let destination = destination.to_string_lossy();
    let selected = app
        .foundation()
        .select_dictionary_pack(request_id, &destination)
        .map_err(|error| map_android_dictionary_error(error.code()))?;
    Ok(PlatformSelectedEpub {
        cancelled: selected.cancelled,
        display_name: selected.display_name,
    })
}

#[cfg(not(target_os = "android"))]
pub(super) fn select_dictionary_pack_on_platform(
    _app: &tauri::AppHandle,
    _request_id: &str,
    _destination: &Path,
) -> Result<PlatformSelectedEpub, PlatformError> {
    Err(PlatformError::new(
        "platformUnavailable",
        "词典包系统选择器仅在 Android 可用。",
        false,
    ))
}

#[cfg(target_os = "android")]
pub(super) fn map_android_dictionary_error(code: Option<&str>) -> PlatformError {
    match code {
        Some("dictionaryInstallCancelled") => {
            PlatformError::new("dictionaryInstallCancelled", "词典包安装已取消。", false)
        }
        Some("dictionaryPackTooLarge") => {
            PlatformError::new("dictionaryPackInvalid", "词典包超过 512 MiB 限制。", false)
        }
        Some("dictionaryPackReadFailed") => PlatformError::new(
            "dictionaryPackInvalid",
            "无法从系统文件选择器读取词典包。",
            true,
        ),
        _ => PlatformError::new("dictionaryPackInvalid", "词典包系统选择失败。", true),
    }
}

#[cfg(target_os = "android")]
pub(super) fn download_dictionary_source_on_platform(
    app: &tauri::AppHandle,
    request_id: &str,
    file_name: &str,
    destination: &Path,
    expected_bytes: u64,
    git_blob_sha: &str,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<(), PlatformError> {
    use fpr_platform_plugin::FoundationExt;
    let destination_path = destination.to_path_buf();
    let destination = destination.to_string_lossy().into_owned();
    let mut last_error = PlatformError::new(
        "dictionaryDownloadFailed",
        "ECDICT 固定数据源暂时不可用。",
        true,
    );
    for base in dictionary_builder::ECDICT_SOURCE_BASES {
        if cancelled.load(Ordering::Relaxed) {
            return Err(PlatformError::new(
                "dictionaryInstallCancelled",
                "词典预载已取消。",
                false,
            ));
        }
        let url = format!("{base}/{file_name}");
        let watcher = DictionaryDownloadWatcher::start(
            app.clone(),
            destination_path.clone(),
            expected_bytes,
            if file_name == "lemma.en.txt" {
                "downloading-lemma"
            } else {
                "downloading-dictionary"
            },
        );
        let attempt = app.foundation().download_dictionary_source(
            request_id,
            &url,
            &destination,
            expected_bytes,
            git_blob_sha,
        );
        watcher.finish();
        match attempt {
            Ok(_) => return Ok(()),
            Err(error) if error.code() == Some("dictionaryInstallCancelled") => {
                return Err(PlatformError::new(
                    "dictionaryInstallCancelled",
                    "词典预载已取消。",
                    false,
                ));
            }
            Err(error) if error.code() == Some("dictionarySourceInvalid") => {
                last_error = PlatformError::new(
                    "dictionaryPackInvalid",
                    "ECDICT 固定数据源完整性校验失败。",
                    false,
                );
            }
            Err(_) => {
                last_error = PlatformError::new(
                    "dictionaryDownloadFailed",
                    "ECDICT 固定数据源暂时不可用。",
                    true,
                );
            }
        }
    }
    Err(last_error)
}

#[cfg(not(target_os = "android"))]
pub(super) fn download_dictionary_source_on_platform(
    _app: &tauri::AppHandle,
    _request_id: &str,
    _file_name: &str,
    _destination: &Path,
    _expected_bytes: u64,
    _git_blob_sha: &str,
    _cancelled: &std::sync::atomic::AtomicBool,
) -> Result<(), PlatformError> {
    Err(PlatformError::new(
        "platformUnavailable",
        "联网词典预载仅在 Android 可用。",
        false,
    ))
}

pub(super) fn emit_dictionary_install_progress(
    app: &tauri::AppHandle,
    stage: &str,
    downloaded_bytes: u64,
    total_bytes: u64,
    indexed_entries: u64,
    message: Option<&str>,
) {
    let _ = app.emit(
        "mobile-dictionary-install-progress",
        MobileDictionaryInstallProgress {
            stage: stage.into(),
            downloaded_bytes,
            total_bytes,
            indexed_entries,
            message: message.map(str::to_owned),
        },
    );
}

#[cfg(target_os = "android")]
struct DictionaryDownloadWatcher {
    finished: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

#[cfg(target_os = "android")]
impl DictionaryDownloadWatcher {
    fn start(
        app: tauri::AppHandle,
        destination: PathBuf,
        expected_bytes: u64,
        stage: &'static str,
    ) -> Self {
        let finished = Arc::new(AtomicBool::new(false));
        let thread_finished = finished.clone();
        let thread = thread::spawn(move || {
            let mut last_reported = u64::MAX;
            loop {
                let downloaded = fs::metadata(&destination)
                    .map(|metadata| metadata.len().min(expected_bytes))
                    .unwrap_or(0);
                if downloaded != last_reported {
                    emit_dictionary_install_progress(
                        &app,
                        stage,
                        downloaded,
                        expected_bytes,
                        0,
                        Some(if stage == "downloading-lemma" {
                            "正在下载 ECDICT 词形表。"
                        } else {
                            "正在下载 ECDICT 原始数据。"
                        }),
                    );
                    last_reported = downloaded;
                }
                if thread_finished.load(Ordering::Relaxed) {
                    break;
                }
                thread::sleep(Duration::from_millis(350));
            }
        });
        Self {
            finished,
            thread: Some(thread),
        }
    }

    fn finish(mut self) {
        self.finished.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
#[tauri::command]
pub fn get_platform_info(app: tauri::AppHandle) -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        app_version: app.package_info().version.to_string(),
        build_mode: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
    }
}
