const COMMANDS: &[&str] = &[
    "secret_save",
    "secret_load",
    "secret_delete",
    "secret_status",
    "network_execute",
    "network_cancel",
    "select_epub",
    "cancel_epub_import",
    "select_dictionary_pack",
    "cancel_dictionary_pack_install",
    "download_dictionary_source",
    "cancel_dictionary_source_download",
    "select_portable_backup",
    "save_portable_backup",
    "cancel_portable_transfer",
    "open_app_storage_settings",
    "get_package_storage_info",
    "system_tts_capability",
    "system_tts_speak",
    "play_speech_audio",
    "pause_speech",
    "resume_speech",
    "stop_speech",
    "share_diagnostic_bundle",
    "factory_reset",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
