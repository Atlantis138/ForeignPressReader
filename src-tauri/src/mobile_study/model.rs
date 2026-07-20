use super::*;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyPlanInput {
    pub name: String,
    pub daily_new_limit: i64,
    pub daily_review_limit: i64,
    pub sources: Vec<StudyPlanSourceInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyPlanSourceInput {
    #[serde(rename = "type")]
    pub source_type: String,
    pub r#ref: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyPlanSourceView {
    pub source_id: String,
    #[serde(rename = "type")]
    pub source_type: String,
    pub r#ref: String,
    pub active: bool,
    pub sync_status: String,
    pub member_count: i64,
    pub last_synced_at: Option<String>,
    pub sync_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyDistribution {
    pub unseen: i64,
    pub learning: i64,
    pub consolidating: i64,
    pub mature: i64,
    pub suspended: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyPlanDetail {
    pub plan_id: String,
    pub name: String,
    pub status: String,
    pub daily_new_limit: i64,
    pub daily_review_limit: i64,
    pub word_count: i64,
    pub due_count: i64,
    pub excluded_count: i64,
    pub available_new_count: i64,
    pub sync_status: String,
    pub source_labels: Vec<String>,
    pub created_at: String,
    pub sources: Vec<StudyPlanSourceView>,
    pub distribution: StudyDistribution,
}

#[derive(Default)]
pub(super) struct StudyPlanStats {
    pub(super) word_count: i64,
    pub(super) unseen: i64,
    pub(super) learning: i64,
    pub(super) consolidating: i64,
    pub(super) mature: i64,
    pub(super) suspended: i64,
    pub(super) due_count: i64,
    pub(super) excluded_count: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyPreferences {
    pub cutoff_hour: i64,
    pub request_retention: f64,
    pub maximum_interval: i64,
    pub queue_order: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyDashboard {
    pub plans: Vec<StudyPlanDetail>,
    pub today: Option<StudyTodaySummary>,
    pub preview: StudyPreview,
    pub developer_mode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyDebugState {
    pub enabled: bool,
    pub last_reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyPreview {
    pub new_count: i64,
    pub review_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyPlanWordQuery {
    pub text: String,
    pub filter: String,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyPlanWord {
    pub lexeme_key: String,
    pub lemma: String,
    pub phonetic: Option<String>,
    pub meanings: Vec<String>,
    pub sources: Vec<String>,
    pub excluded: bool,
    pub suspended: bool,
    pub state: String,
    pub difficulty: Option<f64>,
    pub stability: Option<f64>,
    pub retrievability: Option<f64>,
    pub due_at: Option<String>,
    pub scheduled_days: Option<i64>,
    pub reps: i64,
    pub lapses: i64,
    pub last_review_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyPlanWordPage {
    pub items: Vec<StudyPlanWord>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyTodayWordQuery {
    pub filter: String,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyTodayWord {
    pub item_id: String,
    pub lexeme_key: String,
    pub lemma: String,
    pub phonetic: Option<String>,
    pub meanings: Vec<String>,
    pub kind: String,
    pub first_answer: Option<String>,
    pub final_answer: Option<String>,
    pub attempt_count: i64,
    pub unknown_count: i64,
    pub too_easy: bool,
    pub completed: bool,
    pub context: Option<StudyTodayContext>,
    pub examples: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyTodayContext {
    pub article_title: String,
    pub sentence: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyTodayWordPage {
    pub items: Vec<StudyTodayWord>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyTodaySummary {
    pub session_id: String,
    pub logical_date: String,
    pub status: String,
    pub completed: i64,
    pub total: i64,
    pub new_count: i64,
    pub review_count: i64,
    pub carryover_count: i64,
    pub unknown_count: i64,
    pub too_easy_count: i64,
    pub extra_batch_count: i64,
    pub opened_at: String,
    pub completed_at: Option<String>,
    pub duration_seconds: i64,
    pub next_rollover_at: String,
    pub recent_words: Vec<StudyTodayWord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyTooEasyRequest {
    pub session_id: String,
    pub item_id: String,
    pub command_id: String,
    pub expected_version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudySourceSyncResult {
    pub synced_sources: i64,
    pub failed_sources: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudySourceSnapshot {
    pub source_id: String,
    pub version: String,
    pub items: Vec<StudySourceSnapshotItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudySourceSnapshotItem {
    pub lexeme_key: String,
    pub lemma: String,
    pub phonetic: Option<String>,
    pub brief_meanings: Vec<String>,
    pub senses: Vec<serde_json::Value>,
    pub bnc: Option<i64>,
    pub frequency: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileReviewTransitionEnvelopeV2 {
    pub contract_version: u32,
    pub engine_version: String,
    pub expected_version: i64,
    pub command_id: String,
    pub answer: String,
    pub reviewed_at: String,
    pub before_fingerprint: String,
    pub parameters_fingerprint: String,
    pub parameters: serde_json::Value,
    pub before: StoredReviewCardContract,
    pub after: StoredReviewCardContract,
    pub rating: i64,
    pub log: serde_json::Value,
    pub reinforcement: Option<MobileReinforcementPlanV2>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileReinforcementPlanV2 {
    pub contract_version: u32,
    pub engine_version: String,
    pub seed: String,
    pub remaining_count: i64,
    pub insertion_index: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileStudyCandidateV2 {
    pub lexeme_key: String,
    pub plan_id: String,
    pub kind: String,
    pub due_at: Option<String>,
    pub rank: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileStudyPlanQuotaV2 {
    pub plan_id: String,
    pub daily_new_limit: i64,
    pub daily_review_limit: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayPlanningInputV2 {
    pub order: String,
    pub state_fingerprint: String,
    pub quotas: Vec<MobileStudyPlanQuotaV2>,
    pub candidates: Vec<MobileStudyCandidateV2>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraBatchPlanningInputV2 {
    pub seed: String,
    #[serde(flatten)]
    pub planning: TodayPlanningInputV2,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileQueueSelectionV2 {
    pub lexeme_key: String,
    pub plan_id: String,
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileQueuePlanEnvelopeV2 {
    pub contract_version: u32,
    pub engine_version: String,
    pub seed: String,
    pub order: String,
    pub state_fingerprint: String,
    pub selected: Vec<MobileQueueSelectionV2>,
    pub ordered_keys: Vec<String>,
    pub input_fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyMomentProposal {
    pub now: String,
    pub logical_date: String,
    pub timezone: String,
    pub cutoff_hour: i64,
    pub next_rollover_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyCardView {
    pub item_id: String,
    pub kind: String,
    pub version: i64,
    pub lexeme_key: String,
    pub lemma: String,
    pub phonetic: Option<String>,
    pub sense_groups: Vec<serde_json::Value>,
    pub brief_meanings: Vec<String>,
    pub context: Option<SavedContextItem>,
    pub examples: Vec<serde_json::Value>,
    pub revealed: bool,
    pub proposed_answer: Option<String>,
    pub had_failure: bool,
    pub consecutive_known: i64,
    pub attempt_count: i64,
    pub can_mark_too_easy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudySessionState {
    pub session_id: String,
    pub logical_date: String,
    pub status: String,
    pub current: Option<StudyCardView>,
    pub completed: i64,
    pub total: i64,
    pub remaining: i64,
    pub extra_batch_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyStageAnswerRequest {
    pub session_id: String,
    pub item_id: String,
    pub expected_version: i64,
    pub answer: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyAnswerRequest {
    pub session_id: String,
    pub item_id: String,
    pub command_id: String,
    pub expected_version: i64,
    pub answer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTransitionInput {
    pub stored: Option<StoredReviewCardContract>,
    pub preferences: StudyPreferences,
    pub fsrs_committed: bool,
}

pub(super) struct QueueSeed {
    pub(super) key: String,
    pub(super) plan_id: Option<String>,
    pub(super) kind: String,
    pub(super) status: String,
    pub(super) had_failure: i64,
    pub(super) consecutive_known: i64,
    pub(super) attempt_count: i64,
    pub(super) version: i64,
    pub(super) proposed_answer: Option<String>,
    pub(super) fsrs_committed: i64,
    pub(super) carried_from: Option<String>,
}
