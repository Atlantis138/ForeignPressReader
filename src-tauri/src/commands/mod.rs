use crate::{
    dictionary_builder,
    dictionary_pack::{
        self, DictionaryLocalPackStatus, DictionaryPackStatus, DictionaryResourceStatus,
    },
    dictionary_query::{self, DictionaryLookupRequest, MobileDictionarySearchQuery},
    epub_import::{self, BeginImportResult},
    mobile_dictionary_online, mobile_maintenance,
    mobile_online::{self, TranslationPreferences},
    mobile_reading::{self, ParsedPublicationPlan, ReaderPreferences, ReadingPosition},
    mobile_speech::{self, SpeechPlayRequest, SpeechPreferences},
    mobile_study::{
        self, MobileQueuePlanEnvelopeV2, MobileReviewTransitionEnvelopeV2, StudyAnswerRequest,
        StudyMomentProposal, StudyPlanInput, StudyPlanWordQuery, StudyPreferences,
        StudyStageAnswerRequest, StudyTodayWordQuery, StudyTooEasyRequest,
    },
    mobile_vocabulary::{self, VocabularyListQuery},
    platform_error::PlatformError,
    platform_state::PlatformState,
};
use serde::Serialize;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
#[cfg(target_os = "android")]
use std::{path::PathBuf, sync::Arc, thread, time::Duration};
use tauri::Emitter;

mod data_storage_developer;
mod dictionary;
mod model;
mod online_speech;
mod platform;
mod reading;
mod study;
mod vocabulary;

pub use data_storage_developer::{
    clear_mobile_ai_text_cache, clear_mobile_developer_logs, clear_mobile_safe_cache,
    factory_reset_mobile, force_mobile_developer_next_study_day, get_mobile_developer_state,
    get_mobile_storage_report, open_mobile_app_storage_settings,
    reset_mobile_developer_study_progress, set_mobile_developer_enabled,
    set_mobile_developer_logging, share_mobile_diagnostic_bundle,
};
pub use dictionary::{
    cancel_mobile_dictionary_install, cancel_mobile_dictionary_query,
    delete_mobile_baidu_credentials, explain_mobile_dictionary_context,
    get_mobile_dictionary_center_status, get_mobile_dictionary_credential_status,
    get_mobile_dictionary_lexeme, get_mobile_dictionary_preferences, get_mobile_dictionary_status,
    get_mobile_lexeme_source, hydrate_mobile_study_examples, install_mobile_dictionary_online,
    list_mobile_dictionary_collections, lookup_mobile_dictionary,
    preflight_mobile_dictionary_install, remove_mobile_dictionary,
    remove_mobile_dictionary_full_extension, repair_mobile_dictionary,
    save_mobile_baidu_credentials, save_mobile_dictionary_preferences, search_mobile_dictionary,
    select_and_install_mobile_dictionary, test_mobile_baidu_connection,
};
pub use model::{
    MobileDictionaryCenterStatus, MobileDictionaryInstallResult, MobileDictionaryOnlineEnhancement,
    MobileLexemeSource, PlatformInfo,
};
pub use online_speech::{
    cancel_mobile_translation, delete_mobile_speech_api_key, delete_mobile_translation_api_key,
    delete_mobile_translation_model, get_mobile_contents_translation,
    get_mobile_speech_queue_state, get_mobile_speech_settings, get_mobile_translation_settings,
    pause_mobile_speech, play_mobile_speech, resume_mobile_speech, save_mobile_speech_api_key,
    save_mobile_speech_preferences, save_mobile_translation_api_key,
    save_mobile_translation_preferences, seek_mobile_speech_queue, start_mobile_speech_queue,
    stop_mobile_speech, test_mobile_speech_connection, test_mobile_translation_connection,
    translate_mobile_article, translate_mobile_contents,
};
pub use platform::get_platform_info;
pub use reading::{
    assign_mobile_publications, begin_epub_import, cancel_epub_import, commit_epub_import,
    create_mobile_library_category, delete_mobile_library_category, delete_mobile_publications,
    get_mobile_article, get_mobile_library_state, get_mobile_publication,
    get_mobile_reader_preferences, list_mobile_publications, read_epub_text_entry,
    reader_change_data, reader_get_data, reader_search_articles, rename_mobile_library_category,
    rename_mobile_publication, save_mobile_library_preferences, save_mobile_reader_preferences,
    save_mobile_reading_position,
};
pub use study::{
    add_mobile_study_extra_batch, commit_mobile_study_answer_v2, create_mobile_study_plan,
    delete_mobile_study_plan, force_mobile_next_study_day, get_mobile_review_transition_input,
    get_mobile_study_dashboard, get_mobile_study_debug_state, get_mobile_study_plan,
    get_mobile_study_preferences, list_mobile_study_plan_words, list_mobile_study_plans,
    list_mobile_study_today_words, mark_mobile_study_too_easy, open_mobile_today_v2,
    prepare_mobile_study_extra_batch, prepare_mobile_today_v2, reset_mobile_study_progress,
    save_mobile_study_preferences, set_mobile_study_developer_mode, set_mobile_study_plan_status,
    set_mobile_study_word_excluded, set_mobile_study_word_suspended, stage_mobile_study_answer,
    sync_mobile_study_sources, update_mobile_study_plan,
};
pub use vocabulary::{
    get_mobile_reader_vocabulary_state, list_mobile_saved_contexts,
    list_mobile_vocabulary_favorites, remove_mobile_vocabulary_favorite, set_mobile_context_saved,
    set_mobile_vocabulary_favorite,
};

use model::{MobileDictionaryInstallProgress, PlatformSelectedEpub, PlatformStorageInfo};
use platform::{
    download_dictionary_source_on_platform, emit_dictionary_install_progress,
    open_storage_settings_on_platform, package_storage_on_platform,
    select_dictionary_pack_on_platform, select_epub_on_platform,
};

#[allow(unused_imports)]
pub(crate) use self::platform::{__cmd__get_platform_info, __tauri_command_name_get_platform_info};
#[allow(unused_imports)]
pub(crate) use self::{
    data_storage_developer::*, dictionary::*, online_speech::*, reading::*, study::*, vocabulary::*,
};

#[cfg(test)]
mod facade_tests;
