pub mod atomic_file;
mod commands;
pub mod cover_thumbnail;
pub mod database;
pub mod diagnostic_logger;
pub mod dictionary_builder;
pub mod dictionary_pack;
pub mod dictionary_query;
pub mod dictionary_runtime;
pub mod epub_import;
pub mod learning_contract;
pub mod library_sync_settings;
pub mod mobile_dictionary_online;
pub mod mobile_maintenance;
pub mod mobile_online;
pub mod mobile_portable;
pub mod mobile_reading;
pub mod mobile_speech;
mod mobile_speech_queue;
pub mod mobile_study;
pub mod mobile_sync;
pub mod mobile_sync_runtime;
pub mod mobile_vocabulary;
pub mod platform_error;
pub mod platform_paths;
mod platform_state;
mod portable_commands;
pub mod publication_package;
mod publication_repair;
mod reader_records;
mod startup_recovery;
mod sync_commands;

use percent_encoding::percent_decode_str;
use platform_paths::PlatformPaths;
use platform_state::PlatformState;
use std::fs;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_tls_crypto_provider();
    let builder = tauri::Builder::default().register_uri_scheme_protocol(
        "reader-asset",
        |context, request| {
            let response = || -> Result<(Vec<u8>, &'static str, bool), ()> {
                if request.method() != tauri::http::Method::GET {
                    return Err(());
                }
                let parts = request
                    .uri()
                    .path()
                    .trim_start_matches('/')
                    .split('/')
                    .collect::<Vec<_>>();
                let state = context
                    .app_handle()
                    .try_state::<PlatformState>()
                    .ok_or(())?;
                if parts.len() >= 3 && parts[0] == "asset" {
                    let publication_id =
                        percent_decode_str(parts[1]).decode_utf8().map_err(|_| ())?;
                    let asset_path = parts[2..]
                        .iter()
                        .map(|part| {
                            percent_decode_str(part)
                                .decode_utf8()
                                .map(|value| value.into_owned())
                        })
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|_| ())?
                        .join("/");
                    let path = {
                        let database = state.database().map_err(|_| ())?;
                        mobile_reading::resolve_asset(
                            &database,
                            &state.paths.data.join("library"),
                            &publication_id,
                            &asset_path,
                        )
                        .map_err(|_| ())?
                        .ok_or(())?
                    };
                    let mime = asset_mime(&path).ok_or(())?;
                    return Ok((fs::read(path).map_err(|_| ())?, mime, false));
                }
                if parts.len() == 4 && parts[0] == "cover-thumbnail" && parts[1] == "v1" {
                    let publication_id =
                        percent_decode_str(parts[2]).decode_utf8().map_err(|_| ())?;
                    let content_hash = parts[3];
                    let path = {
                        let database = state.database().map_err(|_| ())?;
                        mobile_reading::resolve_cover_asset(
                            &database,
                            &state.paths.data.join("library"),
                            &publication_id,
                            content_hash,
                        )
                        .map_err(|_| ())?
                        .ok_or(())?
                    };
                    if let Ok(body) =
                        cover_thumbnail::load_or_generate(&state.paths.cache, &path, content_hash)
                    {
                        return Ok((body, "image/jpeg", true));
                    }
                    let mime = asset_mime(&path).ok_or(())?;
                    return Ok((fs::read(path).map_err(|_| ())?, mime, false));
                }
                Err(())
            }();
            match response {
                Ok((body, mime, cacheable)) => {
                    let builder = tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("X-Content-Type-Options", "nosniff");
                    let builder = if cacheable {
                        builder.header("Cache-Control", "private, max-age=31536000, immutable")
                    } else {
                        builder
                            .header("Cache-Control", "no-store, max-age=0")
                            .header("Pragma", "no-cache")
                    };
                    builder.body(body).expect("asset response")
                }
                Err(()) => tauri::http::Response::builder()
                    .status(404)
                    .header("X-Content-Type-Options", "nosniff")
                    .body(Vec::new())
                    .expect("not found response"),
            }
        },
    );
    #[cfg(target_os = "android")]
    let builder = builder.plugin(fpr_platform_plugin::init());
    builder
        .setup(|app| {
            let paths = PlatformPaths::new(
                app.path().app_data_dir()?,
                app.path().app_cache_dir()?,
                app.path().app_log_dir()?,
            );
            let result = PlatformState::new(paths.clone(), &app.package_info().version.to_string());
            let error = match result {
                Ok(state) => {
                    app.manage(state);
                    None
                }
                Err(error) => Some(error),
            };
            app.manage(startup_recovery::StartupRecovery {
                paths,
                error: std::sync::Mutex::new(error),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_recovery::get_startup_recovery,
            startup_recovery::restore_startup_snapshot,
            commands::get_platform_info,
            commands::get_mobile_dictionary_status,
            commands::get_mobile_dictionary_center_status,
            commands::preflight_mobile_dictionary_install,
            commands::install_mobile_dictionary_online,
            commands::select_and_install_mobile_dictionary,
            commands::cancel_mobile_dictionary_install,
            commands::remove_mobile_dictionary,
            commands::remove_mobile_dictionary_full_extension,
            commands::repair_mobile_dictionary,
            commands::lookup_mobile_dictionary,
            commands::search_mobile_dictionary,
            commands::get_mobile_dictionary_lexeme,
            commands::hydrate_mobile_study_examples,
            commands::get_mobile_lexeme_source,
            commands::list_mobile_dictionary_collections,
            commands::get_mobile_dictionary_preferences,
            commands::save_mobile_dictionary_preferences,
            commands::get_mobile_dictionary_credential_status,
            commands::save_mobile_baidu_credentials,
            commands::delete_mobile_baidu_credentials,
            commands::test_mobile_baidu_connection,
            commands::explain_mobile_dictionary_context,
            commands::cancel_mobile_dictionary_query,
            commands::get_mobile_reader_vocabulary_state,
            commands::set_mobile_vocabulary_favorite,
            commands::set_mobile_context_saved,
            commands::list_mobile_vocabulary_favorites,
            commands::list_mobile_saved_contexts,
            commands::remove_mobile_vocabulary_favorite,
            commands::stage_mobile_study_answer,
            commands::get_mobile_review_transition_input,
            commands::get_mobile_study_dashboard,
            commands::list_mobile_study_plans,
            commands::create_mobile_study_plan,
            commands::update_mobile_study_plan,
            commands::set_mobile_study_plan_status,
            commands::get_mobile_study_plan,
            commands::list_mobile_study_plan_words,
            commands::set_mobile_study_word_excluded,
            commands::set_mobile_study_word_suspended,
            commands::list_mobile_study_today_words,
            commands::prepare_mobile_today_v2,
            commands::open_mobile_today_v2,
            commands::commit_mobile_study_answer_v2,
            commands::mark_mobile_study_too_easy,
            commands::prepare_mobile_study_extra_batch,
            commands::add_mobile_study_extra_batch,
            commands::sync_mobile_study_sources,
            commands::get_mobile_study_preferences,
            commands::save_mobile_study_preferences,
            commands::get_mobile_study_debug_state,
            commands::set_mobile_study_developer_mode,
            commands::delete_mobile_study_plan,
            commands::reset_mobile_study_progress,
            commands::force_mobile_next_study_day,
            commands::begin_epub_import,
            commands::read_epub_text_entry,
            commands::commit_epub_import,
            commands::cancel_epub_import,
            portable_commands::get_mobile_data_status,
            sync_commands::open_mobile_sync_page,
            sync_commands::close_mobile_sync_page,
            sync_commands::get_mobile_sync_state,
            sync_commands::refresh_mobile_sync_discovery,
            sync_commands::start_mobile_sync_pairing,
            sync_commands::confirm_mobile_sync_pairing,
            sync_commands::reject_mobile_sync_pairing,
            sync_commands::send_mobile_sync_to,
            sync_commands::accept_mobile_sync_incoming,
            sync_commands::get_mobile_sync_incoming_changes,
            sync_commands::reject_mobile_sync_incoming,
            sync_commands::cancel_mobile_sync_operation,
            sync_commands::discard_mobile_sync_pending_transfer,
            sync_commands::revoke_mobile_sync_trust,
            portable_commands::export_mobile_portable,
            portable_commands::select_mobile_portable_import,
            portable_commands::confirm_mobile_portable_import,
            portable_commands::discard_mobile_portable_import,
            portable_commands::cancel_mobile_data_transfer,
            commands::list_mobile_publications,
            commands::get_mobile_library_state,
            commands::save_mobile_library_preferences,
            commands::create_mobile_library_category,
            commands::rename_mobile_library_category,
            commands::delete_mobile_library_category,
            commands::rename_mobile_publication,
            commands::assign_mobile_publications,
            commands::delete_mobile_publications,
            commands::get_mobile_publication,
            commands::reader_search_articles,
            commands::reader_get_data,
            commands::reader_change_data,
            commands::get_mobile_article,
            commands::save_mobile_reading_position,
            commands::get_mobile_reader_preferences,
            commands::save_mobile_reader_preferences,
            commands::get_mobile_translation_settings,
            commands::save_mobile_translation_preferences,
            commands::save_mobile_translation_api_key,
            commands::delete_mobile_translation_api_key,
            commands::test_mobile_translation_connection,
            commands::translate_mobile_article,
            commands::cancel_mobile_translation,
            commands::get_mobile_speech_settings,
            commands::save_mobile_speech_preferences,
            commands::save_mobile_speech_api_key,
            commands::delete_mobile_speech_api_key,
            commands::test_mobile_speech_connection,
            commands::play_mobile_speech,
            commands::start_mobile_speech_queue,
            commands::get_mobile_speech_queue_state,
            commands::seek_mobile_speech_queue,
            commands::pause_mobile_speech,
            commands::resume_mobile_speech,
            commands::stop_mobile_speech,
            commands::get_mobile_storage_report,
            commands::clear_mobile_safe_cache,
            commands::clear_mobile_ai_text_cache,
            commands::open_mobile_app_storage_settings,
            commands::share_mobile_diagnostic_bundle,
            commands::get_mobile_developer_state,
            commands::set_mobile_developer_enabled,
            commands::set_mobile_developer_logging,
            commands::clear_mobile_developer_logs,
            commands::force_mobile_developer_next_study_day,
            commands::reset_mobile_developer_study_progress,
            commands::factory_reset_mobile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}

fn install_tls_crypto_provider() {
    // axum-server and reqwest share rustls but historically selected different
    // default providers. Installing one explicitly avoids an async panic while
    // the local-sync HTTPS server is being created.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn asset_mime(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tls_tests {
    #[test]
    fn local_sync_has_an_explicit_crypto_provider() {
        super::install_tls_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
