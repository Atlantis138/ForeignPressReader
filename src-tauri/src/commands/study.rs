use super::*;

#[tauri::command]
pub fn stage_mobile_study_answer(
    state: tauri::State<'_, PlatformState>,
    request: StudyStageAnswerRequest,
) -> Result<mobile_study::StudySessionState, PlatformError> {
    let database = state.database()?;
    mobile_study::stage_answer(&database, request)
}

#[tauri::command]
pub fn get_mobile_review_transition_input(
    state: tauri::State<'_, PlatformState>,
    session_id: String,
    item_id: String,
    expected_version: i64,
) -> Result<mobile_study::ReviewTransitionInput, PlatformError> {
    let database = state.database()?;
    mobile_study::review_input(&database, &session_id, &item_id, expected_version)
}

#[tauri::command]
pub fn get_mobile_study_dashboard(
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_study::StudyDashboard, PlatformError> {
    let database = state.database()?;
    mobile_study::dashboard(&database)
}

#[tauri::command]
pub fn list_mobile_study_plans(
    state: tauri::State<'_, PlatformState>,
    include_archived: Option<bool>,
) -> Result<Vec<mobile_study::StudyPlanDetail>, PlatformError> {
    let database = state.database()?;
    mobile_study::list_plans(&database, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn create_mobile_study_plan(
    state: tauri::State<'_, PlatformState>,
    input: StudyPlanInput,
) -> Result<mobile_study::StudyPlanDetail, PlatformError> {
    let mut database = state.database()?;
    mobile_study::create_plan(&mut database, input)
}

#[tauri::command]
pub fn update_mobile_study_plan(
    state: tauri::State<'_, PlatformState>,
    plan_id: String,
    input: StudyPlanInput,
) -> Result<mobile_study::StudyPlanDetail, PlatformError> {
    let mut database = state.database()?;
    mobile_study::update_plan(&mut database, &plan_id, input)
}

#[tauri::command]
pub fn set_mobile_study_plan_status(
    state: tauri::State<'_, PlatformState>,
    plan_id: String,
    status: String,
) -> Result<(), PlatformError> {
    let mut database = state.database()?;
    mobile_study::set_plan_status(&mut database, &plan_id, &status)
}

#[tauri::command]
pub fn get_mobile_study_plan(
    state: tauri::State<'_, PlatformState>,
    plan_id: String,
) -> Result<mobile_study::StudyPlanDetail, PlatformError> {
    let database = state.database()?;
    mobile_study::get_plan(&database, &plan_id)
}

#[tauri::command]
pub fn list_mobile_study_plan_words(
    state: tauri::State<'_, PlatformState>,
    plan_id: String,
    query: StudyPlanWordQuery,
) -> Result<mobile_study::StudyPlanWordPage, PlatformError> {
    let database = state.database()?;
    mobile_study::list_plan_words(&database, &plan_id, query)
}

#[tauri::command]
pub fn set_mobile_study_word_excluded(
    state: tauri::State<'_, PlatformState>,
    plan_id: String,
    lexeme_key: String,
    excluded: bool,
) -> Result<(), PlatformError> {
    let mut database = state.database()?;
    mobile_study::set_word_excluded(&mut database, &plan_id, &lexeme_key, excluded)
}

#[tauri::command]
pub fn set_mobile_study_word_suspended(
    state: tauri::State<'_, PlatformState>,
    lexeme_key: String,
    suspended: bool,
) -> Result<(), PlatformError> {
    let database = state.database()?;
    mobile_study::set_word_suspended(&database, &lexeme_key, suspended)
}

#[tauri::command]
pub fn list_mobile_study_today_words(
    state: tauri::State<'_, PlatformState>,
    session_id: String,
    query: StudyTodayWordQuery,
) -> Result<mobile_study::StudyTodayWordPage, PlatformError> {
    let database = state.database()?;
    mobile_study::list_today_words(&database, &session_id, query)
}

#[tauri::command]
pub fn prepare_mobile_today_v2(
    state: tauri::State<'_, PlatformState>,
    now: String,
) -> Result<mobile_study::TodayPlanningInputV2, PlatformError> {
    let mut database = state.database()?;
    mobile_study::prepare_today_v2(&mut database, &now)
}

#[tauri::command]
pub fn open_mobile_today_v2(
    state: tauri::State<'_, PlatformState>,
    moment: StudyMomentProposal,
    proposal: MobileQueuePlanEnvelopeV2,
) -> Result<mobile_study::StudySessionState, PlatformError> {
    let mut database = state.database()?;
    mobile_study::open_today_v2(&mut database, moment, proposal)
}

#[tauri::command]
pub fn commit_mobile_study_answer_v2(
    state: tauri::State<'_, PlatformState>,
    request: StudyAnswerRequest,
    proposal: Option<MobileReviewTransitionEnvelopeV2>,
) -> Result<mobile_study::StudySessionState, PlatformError> {
    let mut database = state.database()?;
    mobile_study::commit_answer_v2(&mut database, request, proposal)
}

#[tauri::command]
pub fn mark_mobile_study_too_easy(
    state: tauri::State<'_, PlatformState>,
    request: StudyTooEasyRequest,
) -> Result<mobile_study::StudySessionState, PlatformError> {
    let mut database = state.database()?;
    mobile_study::mark_too_easy(&mut database, request)
}

#[tauri::command]
pub fn prepare_mobile_study_extra_batch(
    state: tauri::State<'_, PlatformState>,
    plan_id: String,
    now: String,
) -> Result<mobile_study::ExtraBatchPlanningInputV2, PlatformError> {
    let database = state.database()?;
    mobile_study::prepare_extra_batch_v2(&database, &plan_id, &now)
}

#[tauri::command]
pub fn add_mobile_study_extra_batch(
    state: tauri::State<'_, PlatformState>,
    plan_id: String,
    now: String,
    proposal: MobileQueuePlanEnvelopeV2,
) -> Result<mobile_study::StudySessionState, PlatformError> {
    let mut database = state.database()?;
    mobile_study::add_extra_batch_v2(&mut database, &plan_id, &now, proposal)
}

#[tauri::command]
pub fn sync_mobile_study_sources(
    state: tauri::State<'_, PlatformState>,
    plan_id: Option<String>,
) -> Result<mobile_study::StudySourceSyncResult, PlatformError> {
    let mut database = state.database()?;
    let mut result = mobile_study::sync_sources(&mut database, plan_id.as_deref())?;
    let resource = match state.dictionary_runtime().fast_status(&state.paths) {
        Ok(value) if value.installed => value,
        _ => {
            let plans = mobile_study::list_plans(&database, true)?;
            result.failed_sources += plans
                .iter()
                .filter(|plan| plan_id.as_ref().map_or(true, |id| id == &plan.plan_id))
                .flat_map(|plan| plan.sources.iter())
                .filter(|source| source.active && source.source_type == "exam_collection")
                .count() as i64;
            return Ok(result);
        }
    };
    let plans = mobile_study::list_plans(&database, true)?;
    let sources = plans
        .iter()
        .filter(|plan| plan_id.as_ref().map_or(true, |id| id == &plan.plan_id))
        .flat_map(|plan| plan.sources.iter())
        .filter(|source| source.active && source.source_type == "exam_collection")
        .map(|source| (source.source_id.clone(), source.r#ref.clone()))
        .collect::<Vec<_>>();
    let base_path = dictionary_pack::installed_database_path(&state.paths);
    let full_path = resource
        .extension_compatible
        .then(|| dictionary_pack::installed_full_database_path(&state.paths));
    for (source_id, tag) in sources {
        let version = format!(
            "ecdict:{}:{}",
            resource.version.as_deref().unwrap_or("unknown"),
            tag
        );
        let unchanged = database
            .connection()
            .query_row(
                "SELECT sync_version,sync_status FROM study_plan_sources WHERE source_id=?1",
                [&source_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .map(|(current, status)| {
                current.as_deref() == Some(version.as_str()) && status == "ready"
            })
            .unwrap_or(false);
        if unchanged {
            continue;
        }
        let mut offset = 0;
        let mut items = Vec::new();
        let cancelled = AtomicBool::new(false);
        let snapshot = loop {
            let page = dictionary_query::search_with_extension(
                &base_path,
                full_path.as_deref(),
                MobileDictionarySearchQuery {
                    text: String::new(),
                    tags: vec![tag.clone()],
                    tag_match: dictionary_query::DictionaryTagMatch::Any,
                    oxford_only: false,
                    collins_min: None,
                    bnc_max: None,
                    contemporary_max: None,
                    sort: dictionary_query::DictionarySearchSort::Frequency,
                    offset,
                    limit: 100,
                },
                &cancelled,
            );
            let page = match page {
                Ok(value) => value,
                Err(_) => break None,
            };
            let count = page.items.len();
            items.extend(page.items.into_iter().map(|item| {
                mobile_study::StudySourceSnapshotItem {
                    lexeme_key: item.lexeme_key,
                    lemma: item.lemma,
                    phonetic: item.phonetic,
                    brief_meanings: item.brief_meanings,
                    senses: Vec::new(),
                    bnc: item.frequency.bnc,
                    frequency: item.frequency.contemporary,
                }
            }));
            offset += count as i64;
            if count == 0 || offset >= page.total {
                break Some(mobile_study::StudySourceSnapshot {
                    source_id: source_id.clone(),
                    version: version.clone(),
                    items,
                });
            }
        };
        match snapshot
            .and_then(|snapshot| mobile_study::apply_source_snapshot(&mut database, snapshot).ok())
        {
            Some(()) => result.synced_sources += 1,
            None => result.failed_sources += 1,
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn get_mobile_study_preferences(
    state: tauri::State<'_, PlatformState>,
) -> Result<StudyPreferences, PlatformError> {
    let database = state.database()?;
    mobile_study::get_preferences(&database)
}

#[tauri::command]
pub fn save_mobile_study_preferences(
    state: tauri::State<'_, PlatformState>,
    value: StudyPreferences,
) -> Result<StudyPreferences, PlatformError> {
    let database = state.database()?;
    mobile_study::save_preferences(&database, value)
}

#[tauri::command]
pub fn get_mobile_study_debug_state(
    state: tauri::State<'_, PlatformState>,
) -> Result<mobile_study::StudyDebugState, PlatformError> {
    let database = state.database()?;
    mobile_study::get_debug_state(&database)
}

#[tauri::command]
pub fn set_mobile_study_developer_mode(
    state: tauri::State<'_, PlatformState>,
    enabled: bool,
) -> Result<mobile_study::StudyDebugState, PlatformError> {
    let database = state.database()?;
    mobile_study::set_developer_mode(&database, enabled)
}

#[tauri::command]
pub fn delete_mobile_study_plan(
    state: tauri::State<'_, PlatformState>,
    plan_id: String,
    confirmation_name: String,
    reset_word_progress: bool,
) -> Result<(), PlatformError> {
    let mut database = state.database()?;
    mobile_study::delete_plan(
        &mut database,
        &plan_id,
        &confirmation_name,
        reset_word_progress,
    )
}

#[tauri::command]
pub fn reset_mobile_study_progress(
    state: tauri::State<'_, PlatformState>,
    confirmation_token: String,
) -> Result<(), PlatformError> {
    let mut database = state.database()?;
    mobile_study::reset_all_progress(&mut database, &confirmation_token)
}

#[tauri::command]
pub fn force_mobile_next_study_day(
    state: tauri::State<'_, PlatformState>,
    confirmation_token: String,
) -> Result<(), PlatformError> {
    let database = state.database()?;
    mobile_study::force_next_study_day(&database, &confirmation_token)
}
