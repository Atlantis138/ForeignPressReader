use crate::{
    database::{stable_identity, AndroidDatabase},
    learning_contract::{
        validate_review_proposal, MobileReviewTransitionProposal, StoredReviewCardContract,
    },
    mobile_vocabulary::SavedContextItem,
    platform_error::PlatformError,
};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

mod model;
mod plans;
mod queries;
mod session_review;
mod sources;
mod validation;

pub use model::{
    ExtraBatchPlanningInputV2, MobileQueuePlanEnvelopeV2, MobileQueueSelectionV2,
    MobileReinforcementPlanV2, MobileReviewTransitionEnvelopeV2, MobileStudyCandidateV2,
    MobileStudyPlanQuotaV2, ReviewTransitionInput, StudyAnswerRequest, StudyCardView,
    StudyDashboard, StudyDebugState, StudyDistribution, StudyMomentProposal, StudyPlanDetail,
    StudyPlanInput, StudyPlanSourceInput, StudyPlanSourceView, StudyPlanWord, StudyPlanWordPage,
    StudyPlanWordQuery, StudyPreferences, StudyPreview, StudySessionState, StudySourceSnapshot,
    StudySourceSnapshotItem, StudySourceSyncResult, StudyStageAnswerRequest, StudyTodayContext,
    StudyTodaySummary, StudyTodayWord, StudyTodayWordPage, StudyTodayWordQuery,
    StudyTooEasyRequest, TodayPlanningInputV2,
};
pub use plans::{
    create_minimal_plan, create_plan, current_item_lexeme, delete_plan, force_next_study_day,
    get_debug_state, get_minimal_plan, list_plans, reset_all_progress, set_developer_mode,
    set_plan_status, set_word_excluded, set_word_suspended, update_plan,
};
pub use queries::{dashboard, get_plan, list_plan_words, list_today_words};
pub use session_review::{
    add_extra_batch_v2, commit_answer, commit_answer_v2, get_preferences, mark_too_easy,
    open_today_v2, prepare_extra_batch_v2, prepare_today_v2, review_input, save_preferences,
    stage_answer,
};
pub use sources::{apply_source_snapshot, sync_sources};

use model::{QueueSeed, StudyPlanStats};
use queries::session_state;
use sources::{
    refresh_learning_source_for_key, refresh_learning_sources, replace_sources, sync_source,
};
use validation::*;

#[cfg(test)]
mod tests;
