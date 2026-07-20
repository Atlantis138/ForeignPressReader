use super::*;

pub(super) fn read_card(
    c: &Connection,
    key: &str,
) -> Result<Option<StoredReviewCardContract>, PlatformError> {
    c.query_row("SELECT due_at,stability,difficulty,elapsed_days,scheduled_days,learning_steps,reps,lapses,state,last_review_at FROM review_cards WHERE lexeme_key=?1",[key],|r|Ok(StoredReviewCardContract{due_at:r.get(0)?,stability:r.get(1)?,difficulty:r.get(2)?,elapsed_days:r.get(3)?,scheduled_days:r.get(4)?,learning_steps:r.get(5)?,reps:r.get(6)?,lapses:r.get(7)?,state:r.get(8)?,last_review_at:r.get(9)?})).optional().map_err(db_error)
}
pub(super) fn save_card(
    tx: &Transaction<'_>,
    key: &str,
    c: &StoredReviewCardContract,
    now: &str,
    device: &str,
) -> Result<(), PlatformError> {
    tx.execute("INSERT INTO review_cards VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(lexeme_key) DO UPDATE SET due_at=excluded.due_at,stability=excluded.stability,difficulty=excluded.difficulty,elapsed_days=excluded.elapsed_days,scheduled_days=excluded.scheduled_days,learning_steps=excluded.learning_steps,reps=excluded.reps,lapses=excluded.lapses,state=excluded.state,last_review_at=excluded.last_review_at,updated_at=excluded.updated_at,device_id=excluded.device_id",params![key,c.due_at,c.stability,c.difficulty,c.elapsed_days,c.scheduled_days,c.learning_steps,c.reps,c.lapses,c.state,c.last_review_at,now,device]).map_err(db_error)?;
    Ok(())
}
pub(super) fn empty_card(now: &str) -> StoredReviewCardContract {
    StoredReviewCardContract {
        due_at: now.into(),
        stability: 0.0,
        difficulty: 0.0,
        elapsed_days: 0,
        scheduled_days: 0,
        learning_steps: 0,
        reps: 0,
        lapses: 0,
        state: 0,
        last_review_at: None,
    }
}
pub(super) fn minimal_plan_id(c: &Connection) -> Result<Option<String>, PlatformError> {
    c.query_row("SELECT plan_id FROM study_plans WHERE deleted_at IS NULL AND status!='archived' AND EXISTS(SELECT 1 FROM study_plan_sources s WHERE s.plan_id=study_plans.plan_id AND s.source_type='reader_manual' AND s.source_ref='favorite' AND s.active=1) ORDER BY created_at LIMIT 1",[],|r|r.get(0)).optional().map_err(db_error)
}
pub(super) fn latest_session(c: &Connection) -> Result<Option<(String, String)>, PlatformError> {
    c.query_row(
        "SELECT session_id,next_rollover_at FROM study_sessions ORDER BY day_sequence DESC LIMIT 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(db_error)
}
pub(super) fn command_result(
    c: &Connection,
    command: &str,
) -> Result<Option<(String, String, String)>, PlatformError> {
    c.query_row("SELECT session_id,session_item_id,answer FROM review_events WHERE command_id=?1 UNION ALL SELECT session_id,session_item_id,answer FROM reinforcement_events WHERE command_id=?1 LIMIT 1",[command],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db_error)
}
pub(super) fn query_keys<P: rusqlite::Params>(
    c: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<String>, PlatformError> {
    let mut s = c.prepare(sql).map_err(db_error)?;
    let values = s
        .query_map(params, |r| r.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(values)
}
pub(super) fn parse_string_array(value: &str) -> Vec<String> {
    serde_json::from_str(value).unwrap_or_default()
}
pub(super) fn finish_session_if_empty(
    tx: &Transaction<'_>,
    session_id: &str,
    now: &str,
) -> Result<(), PlatformError> {
    let pending:i64=tx.query_row("SELECT COUNT(*) FROM study_session_items WHERE session_id=?1 AND status IN ('pending','revealed')",[session_id],|r|r.get(0)).map_err(db_error)?;
    if pending == 0 {
        tx.execute("UPDATE study_sessions SET status='completed',completed_at=?1,updated_at=?1 WHERE session_id=?2",params![now,session_id]).map_err(db_error)?;
    }
    Ok(())
}
pub(super) fn reinforcement_position(
    tx: &Transaction<'_>,
    session_id: &str,
    item_id: &str,
    plan: &MobileReinforcementPlanV2,
) -> Result<i64, PlatformError> {
    if plan.contract_version != 2
        || plan.engine_version != "learning-queue-v2"
        || plan.seed.is_empty()
        || plan.remaining_count < 0
        || plan.insertion_index < 0
        || plan.insertion_index > plan.remaining_count
    {
        return Err(invalid_proposal());
    }
    let positions=query_i64(tx,"SELECT queue_position FROM study_session_items WHERE session_id=?1 AND item_id!=?2 AND status IN ('pending','revealed') ORDER BY queue_position",params![session_id,item_id])?;
    if positions.len() as i64 != plan.remaining_count {
        return Err(version_conflict());
    }
    if plan.insertion_index >= plan.remaining_count {
        return tx.query_row("SELECT COALESCE(MAX(queue_position),0)+1 FROM study_session_items WHERE session_id=?1",[session_id],|r|r.get(0)).map_err(db_error);
    }
    let position = positions[plan.insertion_index as usize];
    tx.execute("UPDATE study_session_items SET queue_position=queue_position+1 WHERE session_id=?1 AND queue_position>=?2",params![session_id,position]).map_err(db_error)?;
    Ok(position)
}
pub(super) fn query_i64<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    parameters: P,
) -> Result<Vec<i64>, PlatformError> {
    let mut statement = connection.prepare(sql).map_err(db_error)?;
    let values = statement
        .query_map(parameters, |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(values)
}
pub(super) fn default_preferences() -> StudyPreferences {
    StudyPreferences {
        cutoff_hour: 4,
        request_retention: 0.9,
        maximum_interval: 36500,
        queue_order: "mixed".into(),
    }
}
pub(super) fn valid_preferences(value: &StudyPreferences) -> bool {
    (0..=23).contains(&value.cutoff_hour)
        && (0.8..=0.95).contains(&value.request_retention)
        && (30..=36500).contains(&value.maximum_interval)
        && matches!(
            value.queue_order.as_str(),
            "mixed" | "review_first" | "new_first"
        )
}
pub(super) fn invalid_preferences() -> PlatformError {
    PlatformError::new("invalidStudyPreferences", "学习设置无效。", false)
}

pub(super) fn require_debug(database: &AndroidDatabase) -> Result<(), PlatformError> {
    if get_debug_state(database)?.enabled {
        Ok(())
    } else {
        Err(PlatformError::new(
            "featureDisabled",
            "请先解锁开发工具。",
            false,
        ))
    }
}

pub(super) fn validate_review_envelope_v2(
    value: MobileReviewTransitionEnvelopeV2,
) -> Result<MobileReviewTransitionProposal, PlatformError> {
    if value.contract_version != 2
        || value.engine_version != "fsrs-6/ts-fsrs-5.4.1/mobile-v2"
        || !value.parameters.is_object()
    {
        return Err(invalid_proposal());
    }
    let canonical = canonical_json(&value.parameters)?;
    if hex::encode(Sha256::digest(canonical.as_bytes())) != value.parameters_fingerprint {
        return Err(invalid_proposal());
    }
    Ok(MobileReviewTransitionProposal {
        contract_version: 1,
        engine_version: "fsrs-6/ts-fsrs-5.4.1/mobile-v1".into(),
        expected_version: value.expected_version,
        command_id: value.command_id,
        answer: value.answer,
        reviewed_at: value.reviewed_at,
        before_fingerprint: value.before_fingerprint,
        parameters_fingerprint: value.parameters_fingerprint,
        before: value.before,
        after: value.after,
        rating: value.rating,
        log: value.log,
    })
}

pub(super) fn validate_queue_envelope_v2(
    proposal: &MobileQueuePlanEnvelopeV2,
    input: &TodayPlanningInputV2,
    expected_seed: &str,
) -> Result<(), PlatformError> {
    if proposal.contract_version != 2
        || proposal.engine_version != "learning-queue-v2"
        || proposal.seed != expected_seed
        || proposal.order != input.order
        || proposal.state_fingerprint != input.state_fingerprint
    {
        return Err(invalid_proposal());
    }
    let expected = serde_json::json!({"version":2,"seed":proposal.seed,"order":proposal.order,"stateFingerprint":input.state_fingerprint,"quotas":input.quotas,"candidates":input.candidates});
    if hex::encode(Sha256::digest(canonical_json(&expected)?.as_bytes()))
        != proposal.input_fingerprint
    {
        return Err(invalid_proposal());
    }
    let candidates = input
        .candidates
        .iter()
        .map(|item| {
            (
                (
                    item.lexeme_key.as_str(),
                    item.plan_id.as_str(),
                    item.kind.as_str(),
                ),
                item,
            )
        })
        .collect::<HashMap<_, _>>();
    let quotas = input
        .quotas
        .iter()
        .map(|quota| (quota.plan_id.as_str(), quota))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut counts = HashMap::<(&str, &str), i64>::new();
    for item in &proposal.selected {
        if !seen.insert(item.lexeme_key.as_str())
            || !candidates.contains_key(&(
                item.lexeme_key.as_str(),
                item.plan_id.as_str(),
                item.kind.as_str(),
            ))
        {
            return Err(invalid_proposal());
        }
        *counts
            .entry((item.plan_id.as_str(), item.kind.as_str()))
            .or_default() += 1;
    }
    for ((plan, kind), count) in counts {
        let quota = quotas.get(plan).ok_or_else(invalid_proposal)?;
        let limit = if kind == "new" {
            quota.daily_new_limit
        } else if kind == "review" {
            quota.daily_review_limit
        } else {
            return Err(invalid_proposal());
        };
        if count > limit {
            return Err(invalid_proposal());
        }
    }
    let ordered = proposal
        .ordered_keys
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if ordered != seen || ordered.len() != proposal.ordered_keys.len() {
        return Err(invalid_proposal());
    }
    Ok(())
}

pub(super) fn canonical_json(value: &serde_json::Value) -> Result<String, PlatformError> {
    match value {
        serde_json::Value::Null => Ok("null".into()),
        serde_json::Value::Bool(value) => Ok(value.to_string()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::String(value) => serde_json::to_string(value).map_err(json_error),
        serde_json::Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let fields = keys
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(json_error)?,
                        canonical_json(&values[key])?
                    ))
                })
                .collect::<Result<Vec<_>, PlatformError>>()?;
            Ok(format!("{{{}}}", fields.join(",")))
        }
    }
}
pub(super) fn validate_plan(v: &StudyPlanInput) -> Result<(), PlatformError> {
    if v.name.trim().is_empty()
        || v.name.trim().chars().count() > 40
        || !(0..=500).contains(&v.daily_new_limit)
        || !(1..=2000).contains(&v.daily_review_limit)
        || v.sources.is_empty()
        || v.sources.iter().any(|source| {
            !matches!(
                source.source_type.as_str(),
                "reader_manual" | "exam_collection"
            ) || source.r#ref.trim().is_empty()
                || (source.source_type == "reader_manual" && source.r#ref != "favorite")
        })
        || v.sources
            .iter()
            .map(|source| format!("{}:{}", source.source_type, source.r#ref))
            .collect::<HashSet<_>>()
            .len()
            != v.sources.len()
    {
        Err(invalid_proposal())
    } else {
        Ok(())
    }
}
pub(super) fn validate_moment(v: &StudyMomentProposal) -> Result<(), PlatformError> {
    let now = DateTime::parse_from_rfc3339(&v.now).map_err(|_| invalid_proposal())?;
    let next = DateTime::parse_from_rfc3339(&v.next_rollover_at).map_err(|_| invalid_proposal())?;
    if v.logical_date.len() != 10
        || v.timezone.is_empty()
        || !(0..=23).contains(&v.cutoff_hour)
        || next <= now
        || next.signed_duration_since(now).num_hours() > 25
    {
        Err(invalid_proposal())
    } else {
        #[cfg(not(test))]
        if (chrono::Utc::now().timestamp() - now.timestamp()).abs() > 300 {
            return Err(invalid_proposal());
        }
        Ok(())
    }
}
pub(super) fn parse_time(v: &str) -> Result<(), PlatformError> {
    DateTime::parse_from_rfc3339(v)
        .map(|_| ())
        .map_err(|_| invalid_proposal())
}
pub(super) fn now_string() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(super) fn missing_plan() -> PlatformError {
    PlatformError::new("learningEntityMissing", "请先创建最小学习计划。", false)
}
pub(super) fn missing_session() -> PlatformError {
    PlatformError::new("learningEntityMissing", "尚无今日学习会话。", false)
}
pub(super) fn version_conflict() -> PlatformError {
    PlatformError::new(
        "learningVersionConflict",
        "学习队列已变化，请刷新后重试。",
        false,
    )
}
pub(super) fn invalid_proposal() -> PlatformError {
    PlatformError::new("invalidLearningProposal", "学习状态转换提案无效。", false)
}
pub(super) fn command_replay() -> PlatformError {
    PlatformError::new("learningCommandReplay", "学习命令已用于其他回答。", false)
}
pub(super) fn db_error(_error: rusqlite::Error) -> PlatformError {
    #[cfg(test)]
    eprintln!("mobile study database error: {_error}");
    PlatformError::new(
        "learningDatabaseUnavailable",
        "学习数据库暂时不可用。",
        true,
    )
}

pub(super) fn json_error(_: serde_json::Error) -> PlatformError {
    invalid_proposal()
}
