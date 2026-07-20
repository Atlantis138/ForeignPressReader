use super::*;

pub(super) fn planning_input(
    order: String,
    quotas: Vec<MobileStudyPlanQuotaV2>,
    candidates: Vec<MobileStudyCandidateV2>,
) -> Result<TodayPlanningInputV2, PlatformError> {
    let state_value = serde_json::json!({"candidates": &candidates, "quotas": &quotas});
    let state_fingerprint = hex::encode(Sha256::digest(canonical_json(&state_value)?.as_bytes()));
    Ok(TodayPlanningInputV2 {
        order,
        state_fingerprint,
        quotas,
        candidates,
    })
}

pub fn prepare_today_v2(
    database: &mut AndroidDatabase,
    now: &str,
) -> Result<TodayPlanningInputV2, PlatformError> {
    parse_time(now)?;
    sync_sources(database, None)?;
    let preferences = get_preferences(database)?;
    let plans = list_plans(database, false)?
        .into_iter()
        .filter(|plan| plan.status == "active")
        .collect::<Vec<_>>();
    let quotas = plans
        .iter()
        .map(|plan| MobileStudyPlanQuotaV2 {
            plan_id: plan.plan_id.clone(),
            daily_new_limit: plan.daily_new_limit,
            daily_review_limit: plan.daily_review_limit,
        })
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();
    for plan in &plans {
        let mut statement=database.connection().prepare("SELECT DISTINCT o.lexeme_key,c.due_at,u.bnc_rank,u.frequency_rank,CASE WHEN c.lexeme_key IS NOT NULL AND c.state!=0 AND c.due_at<=?2 THEN 'review' WHEN c.lexeme_key IS NULL THEN 'new' ELSE NULL END kind FROM study_plan_lexeme_origins o JOIN study_plan_sources s ON s.source_id=o.plan_source_id JOIN user_lexemes u ON u.lexeme_key=o.lexeme_key LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key LEFT JOIN review_suspensions rs ON rs.lexeme_key=o.lexeme_key LEFT JOIN review_cards c ON c.lexeme_key=o.lexeme_key WHERE o.plan_id=?1 AND o.active=1 AND s.active=1 AND COALESCE(x.excluded,0)=0 AND COALESCE(rs.active,0)=0 ORDER BY o.lexeme_key").map_err(db_error)?;
        let rows = statement
            .query_map(params![plan.plan_id, now], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for (key, due, bnc, frequency, kind) in rows {
            if let Some(kind) = kind {
                candidates.push(MobileStudyCandidateV2 {
                    lexeme_key: key,
                    plan_id: plan.plan_id.clone(),
                    kind,
                    due_at: due,
                    rank: frequency.or(bnc),
                })
            }
        }
    }
    planning_input(preferences.queue_order, quotas, candidates)
}

pub fn open_today_v2(
    database: &mut AndroidDatabase,
    moment: StudyMomentProposal,
    proposal: MobileQueuePlanEnvelopeV2,
) -> Result<StudySessionState, PlatformError> {
    validate_moment(&moment)?;
    if let Some((id, rollover)) = latest_session(database.connection())? {
        if DateTime::parse_from_rfc3339(&moment.now).map_err(|_| invalid_proposal())?
            < DateTime::parse_from_rfc3339(&rollover).map_err(|_| invalid_proposal())?
        {
            return session_state(database, &id);
        }
    }
    let input = prepare_today_v2(database, &moment.now)?;
    validate_queue_envelope_v2(
        &proposal,
        &input,
        &format!("{}:regular", moment.logical_date),
    )?;
    let device = database.device_id().to_owned();
    let opened = moment.now.clone();
    let session_id = Uuid::new_v4().to_string();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let previous = tx
        .query_row(
            "SELECT session_id FROM study_sessions ORDER BY day_sequence DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let mut carryover = Vec::new();
    if let Some(previous_id) = previous.as_deref() {
        let mut statement=tx.prepare("SELECT item_id,lexeme_key,plan_id,status,had_failure,consecutive_known,attempt_count,version,proposed_answer,fsrs_committed FROM study_session_items WHERE session_id=?1 AND status IN ('pending','revealed') ORDER BY queue_position").map_err(db_error)?;
        carryover = statement
            .query_map([previous_id], |r| {
                Ok(QueueSeed {
                    carried_from: Some(r.get(0)?),
                    key: r.get(1)?,
                    plan_id: r.get(2)?,
                    kind: "carryover".into(),
                    status: r.get(3)?,
                    had_failure: r.get(4)?,
                    consecutive_known: r.get(5)?,
                    attempt_count: r.get(6)?,
                    version: r.get(7)?,
                    proposed_answer: r.get(8)?,
                    fsrs_committed: r.get(9)?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        drop(statement);
        tx.execute("UPDATE study_session_items SET status='carried',updated_at=?1 WHERE session_id=?2 AND status IN ('pending','revealed')",params![opened,previous_id]).map_err(db_error)?;
        tx.execute(
            "UPDATE study_sessions SET status='rolled_over',updated_at=?1 WHERE session_id=?2",
            params![opened, previous_id],
        )
        .map_err(db_error)?;
    }
    let sequence: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(day_sequence),0)+1 FROM study_sessions",
            [],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    tx.execute("INSERT INTO study_sessions(session_id,day_sequence,logical_date,timezone,cutoff_hour,next_rollover_at,status,extra_batch_count,opened_at,completed_at,updated_at,device_id,debug_forced) VALUES(?1,?2,?3,?4,?5,?6,'active',0,?7,NULL,?7,?8,0)",params![session_id,sequence,moment.logical_date,moment.timezone,moment.cutoff_hour,moment.next_rollover_at,opened,device]).map_err(db_error)?;
    let mut batch_by_plan = HashMap::new();
    for quota in &input.quotas {
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO study_session_batches VALUES(?1,?2,?3,'regular',?4,?5,?6)",
            params![
                id,
                session_id,
                quota.plan_id,
                quota.daily_new_limit,
                quota.daily_review_limit,
                opened
            ],
        )
        .map_err(db_error)?;
        batch_by_plan.insert(quota.plan_id.clone(), id);
    }
    let selected = proposal
        .selected
        .iter()
        .map(|item| (item.lexeme_key.as_str(), item))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::new();
    for item in carryover {
        if !ordered
            .iter()
            .any(|value: &QueueSeed| value.key == item.key)
        {
            ordered.push(item)
        }
    }
    for key in &proposal.ordered_keys {
        if ordered.iter().any(|item| item.key == *key) {
            continue;
        }
        let item = selected[key.as_str()];
        ordered.push(QueueSeed {
            key: key.clone(),
            plan_id: Some(item.plan_id.clone()),
            kind: item.kind.clone(),
            status: "pending".into(),
            had_failure: 0,
            consecutive_known: 0,
            attempt_count: 0,
            version: 1,
            proposed_answer: None,
            fsrs_committed: 0,
            carried_from: None,
        });
    }
    let carry_batch = if ordered.iter().any(|item| item.kind == "carryover") {
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO study_session_batches VALUES(?1,?2,NULL,'carryover',0,0,?3)",
            params![id, session_id, opened],
        )
        .map_err(db_error)?;
        Some(id)
    } else {
        None
    };
    for (index, item) in ordered.iter().enumerate() {
        let batch = if item.kind == "carryover" {
            carry_batch.as_ref()
        } else {
            item.plan_id.as_ref().and_then(|id| batch_by_plan.get(id))
        };
        tx.execute("INSERT OR IGNORE INTO study_session_items(item_id,session_id,batch_id,lexeme_key,plan_id,kind,queue_position,status,had_failure,consecutive_known,attempt_count,version,carried_from_item_id,created_at,updated_at,proposed_answer,fsrs_committed) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14,?15,?16)",params![Uuid::new_v4().to_string(),session_id,batch,item.key,item.plan_id,item.kind,index as i64+1,item.status,item.had_failure,item.consecutive_known,item.attempt_count,item.version,item.carried_from,opened,item.proposed_answer,item.fsrs_committed]).map_err(db_error)?;
    }
    if ordered.is_empty() {
        tx.execute(
            "UPDATE study_sessions SET status='completed',completed_at=?1 WHERE session_id=?2",
            params![opened, session_id],
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    session_state(database, &session_id)
}

pub fn stage_answer(
    database: &AndroidDatabase,
    request: StudyStageAnswerRequest,
) -> Result<StudySessionState, PlatformError> {
    if !matches!(request.answer.as_str(), "known" | "unknown") {
        return Err(invalid_proposal());
    }
    let changed = database.connection().execute("UPDATE study_session_items SET status='revealed',proposed_answer=?1,version=version+1,updated_at=?2 WHERE session_id=?3 AND item_id=?4 AND status='pending' AND version=?5", params![request.answer,now_string(),request.session_id,request.item_id,request.expected_version]).map_err(db_error)?;
    if changed != 1 {
        return Err(version_conflict());
    }
    session_state(database, &request.session_id)
}

pub fn review_input(
    database: &AndroidDatabase,
    session_id: &str,
    item_id: &str,
    expected_version: i64,
) -> Result<ReviewTransitionInput, PlatformError> {
    let (key, committed):(String,i64)=database.connection().query_row("SELECT lexeme_key,fsrs_committed FROM study_session_items WHERE session_id=?1 AND item_id=?2 AND status='revealed' AND version=?3", params![session_id,item_id,expected_version], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(db_error)?.ok_or_else(version_conflict)?;
    Ok(ReviewTransitionInput {
        stored: read_card(database.connection(), &key)?,
        preferences: get_preferences(database)?,
        fsrs_committed: committed == 1,
    })
}

pub fn commit_answer(
    database: &mut AndroidDatabase,
    request: StudyAnswerRequest,
    proposal: Option<MobileReviewTransitionProposal>,
) -> Result<StudySessionState, PlatformError> {
    commit_answer_internal(database, request, proposal, None, None)
}

pub(super) fn commit_answer_internal(
    database: &mut AndroidDatabase,
    request: StudyAnswerRequest,
    proposal: Option<MobileReviewTransitionProposal>,
    canonical_parameters: Option<&str>,
    reinforcement: Option<&MobileReinforcementPlanV2>,
) -> Result<StudySessionState, PlatformError> {
    if Uuid::parse_str(&request.command_id).is_err() {
        return Err(invalid_proposal());
    }
    if let Some(previous) = command_result(database.connection(), &request.command_id)? {
        if previous.1 != request.item_id || previous.2 != request.answer {
            return Err(command_replay());
        }
        return session_state(database, &previous.0);
    }
    let device_id = database.device_id().to_owned();
    let happened = now_string();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let row=tx.query_row("SELECT lexeme_key,plan_id,proposed_answer,fsrs_committed,had_failure,consecutive_known FROM study_session_items WHERE session_id=?1 AND item_id=?2 AND status='revealed' AND version=?3", params![request.session_id,request.item_id,request.expected_version], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?))).optional().map_err(db_error)?.ok_or_else(version_conflict)?;
    let proposed = row.2.as_deref();
    if !matches!(request.answer.as_str(), "known" | "unknown")
        || !matches!(
            (proposed, request.answer.as_str()),
            (Some("known"), "known") | (Some("known"), "unknown") | (Some("unknown"), "unknown")
        )
    {
        return Err(invalid_proposal());
    }
    if row.3 == 0 {
        let proposal = proposal.ok_or_else(invalid_proposal)?;
        let before = read_card(&tx, &row.0)?.unwrap_or_else(|| empty_card(&proposal.reviewed_at));
        validate_review_proposal(
            &proposal,
            &before,
            request.expected_version,
            &request.command_id,
        )?;
        if proposal.answer != request.answer {
            return Err(invalid_proposal());
        }
        save_card(&tx, &row.0, &proposal.after, &happened, &device_id)?;
        let profile_id = format!("fsrs_{}", &proposal.parameters_fingerprint[..24]);
        tx.execute(
            "INSERT OR IGNORE INTO scheduler_profiles VALUES(?1,'6.0/ts-fsrs-5.4.1',?2,?3,?4)",
            params![
                profile_id,
                canonical_parameters.unwrap_or("{}"),
                proposal.parameters_fingerprint,
                happened
            ],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO review_events VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                Uuid::new_v4().to_string(),
                request.command_id,
                row.0,
                request.session_id,
                request.item_id,
                row.1,
                request.answer,
                proposal.rating,
                profile_id,
                serde_json::to_string(&proposal.before).map_err(json_error)?,
                serde_json::to_string(&proposal.after).map_err(json_error)?,
                proposal.log.to_string(),
                proposal.reviewed_at,
                device_id
            ],
        )
        .map_err(db_error)?;
    } else {
        tx.execute(
            "INSERT INTO reinforcement_events VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                Uuid::new_v4().to_string(),
                request.command_id,
                row.0,
                request.session_id,
                request.item_id,
                row.1,
                request.answer,
                row.5,
                if request.answer == "known" {
                    row.5 + 1
                } else {
                    0
                },
                happened,
                device_id
            ],
        )
        .map_err(db_error)?;
    }
    let had_failure = row.4 == 1 || request.answer == "unknown";
    let consecutive = if request.answer == "known" {
        row.5 + 1
    } else {
        0
    };
    let completed = !had_failure && request.answer == "known" || had_failure && consecutive >= 2;
    let status = if completed { "completed" } else { "pending" };
    if status == "pending" && canonical_parameters.is_some() && reinforcement.is_none() {
        return Err(invalid_proposal());
    }
    let position: i64 = if status == "pending" {
        if let Some(plan) = reinforcement {
            reinforcement_position(&tx, &request.session_id, &request.item_id, plan)?
        } else {
            tx.query_row("SELECT COALESCE(MAX(queue_position),0)+1 FROM study_session_items WHERE session_id=?1",[&request.session_id],|r|r.get(0)).map_err(db_error)?
        }
    } else {
        tx.query_row(
            "SELECT queue_position FROM study_session_items WHERE item_id=?1",
            [&request.item_id],
            |r| r.get(0),
        )
        .map_err(db_error)?
    };
    tx.execute("UPDATE study_session_items SET status=?1,proposed_answer=NULL,fsrs_committed=1,had_failure=?2,consecutive_known=?3,attempt_count=attempt_count+1,version=version+1,queue_position=?4,updated_at=?5 WHERE item_id=?6",params![status,i64::from(had_failure),consecutive,position,happened,request.item_id]).map_err(db_error)?;
    let pending:i64=tx.query_row("SELECT COUNT(*) FROM study_session_items WHERE session_id=?1 AND status IN ('pending','revealed')",[&request.session_id],|r|r.get(0)).map_err(db_error)?;
    if pending == 0 {
        tx.execute("UPDATE study_sessions SET status='completed',completed_at=?1,updated_at=?1 WHERE session_id=?2",params![happened,request.session_id]).map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    session_state(database, &request.session_id)
}

pub fn commit_answer_v2(
    database: &mut AndroidDatabase,
    request: StudyAnswerRequest,
    envelope: Option<MobileReviewTransitionEnvelopeV2>,
) -> Result<StudySessionState, PlatformError> {
    let (proposal, parameters, reinforcement) = match envelope {
        None => (None, None, None),
        Some(value) => {
            let parameters = canonical_json(&value.parameters)?;
            let reinforcement = value.reinforcement.clone();
            (
                Some(validate_review_envelope_v2(value)?),
                Some(parameters),
                reinforcement,
            )
        }
    };
    commit_answer_internal(
        database,
        request,
        proposal,
        parameters.as_deref(),
        reinforcement.as_ref(),
    )
}

pub fn get_preferences(database: &AndroidDatabase) -> Result<StudyPreferences, PlatformError> {
    let raw = database
        .connection()
        .query_row(
            "SELECT value FROM settings WHERE key='study.preferences'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    match raw {
        None => Ok(default_preferences()),
        Some(value) => serde_json::from_str::<StudyPreferences>(&value)
            .ok()
            .filter(valid_preferences)
            .ok_or_else(invalid_preferences),
    }
}

pub fn save_preferences(
    database: &AndroidDatabase,
    value: StudyPreferences,
) -> Result<StudyPreferences, PlatformError> {
    if !valid_preferences(&value) {
        return Err(invalid_preferences());
    }
    let json = serde_json::to_string(&value).map_err(json_error)?;
    database.connection().execute("INSERT INTO settings(key,value,updated_at,device_id) VALUES('study.preferences',?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id",params![json,now_string(),database.device_id()]).map_err(db_error)?;
    Ok(value)
}

pub fn mark_too_easy(
    database: &mut AndroidDatabase,
    request: StudyTooEasyRequest,
) -> Result<StudySessionState, PlatformError> {
    if Uuid::parse_str(&request.command_id).is_err() {
        return Err(invalid_proposal());
    }
    if let Some(previous) = command_result(database.connection(), &request.command_id)? {
        if previous.1 != request.item_id || previous.2 != "too_easy" {
            return Err(command_replay());
        }
        return session_state(database, &previous.0);
    }
    let now = now_string();
    let device = database.device_id().to_owned();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let row=tx.query_row("SELECT lexeme_key,plan_id,attempt_count,had_failure FROM study_session_items WHERE session_id=?1 AND item_id=?2 AND status='pending' AND version=?3",params![request.session_id,request.item_id,request.expected_version],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?))).optional().map_err(db_error)?.ok_or_else(version_conflict)?;
    if row.2 != 0 || row.3 != 0 {
        return Err(invalid_proposal());
    }
    tx.execute("INSERT INTO review_suspensions(lexeme_key,active,reason,suspended_at,restored_at,updated_at,device_id) VALUES(?1,1,'too_easy',?2,NULL,?2,?3) ON CONFLICT(lexeme_key) DO UPDATE SET active=1,reason='too_easy',suspended_at=excluded.suspended_at,restored_at=NULL,updated_at=excluded.updated_at,device_id=excluded.device_id",params![row.0,now,device]).map_err(db_error)?;
    tx.execute(
        "INSERT INTO reinforcement_events VALUES(?1,?2,?3,?4,?5,?6,'too_easy',0,0,?7,?8)",
        params![
            Uuid::new_v4().to_string(),
            request.command_id,
            row.0,
            request.session_id,
            request.item_id,
            row.1,
            now,
            device
        ],
    )
    .map_err(db_error)?;
    tx.execute("UPDATE study_session_items SET status='completed',attempt_count=attempt_count+1,version=version+1,updated_at=?1 WHERE item_id=?2",params![now,request.item_id]).map_err(db_error)?;
    finish_session_if_empty(&tx, &request.session_id, &now)?;
    tx.commit().map_err(db_error)?;
    session_state(database, &request.session_id)
}

pub fn prepare_extra_batch_v2(
    database: &AndroidDatabase,
    plan_id: &str,
    now: &str,
) -> Result<ExtraBatchPlanningInputV2, PlatformError> {
    parse_time(now)?;
    let plan = get_plan(database, plan_id)?;
    if plan.status != "active" {
        return Err(invalid_proposal());
    }
    let session = database
        .connection()
        .query_row(
            "SELECT session_id,status FROM study_sessions ORDER BY day_sequence DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(missing_session)?;
    if session.1 != "completed" {
        return Err(PlatformError::new(
            "learningQueueNotCompleted",
            "请先完成当前队列。",
            false,
        ));
    }
    let count: i64 = database
        .connection()
        .query_row(
            "SELECT extra_batch_count FROM study_sessions WHERE session_id=?1",
            [&session.0],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    let mut candidates = Vec::new();
    {
        let mut statement = database.connection().prepare("SELECT DISTINCT o.lexeme_key,c.due_at,u.bnc_rank,u.frequency_rank FROM study_plan_lexeme_origins o JOIN study_plan_sources s ON s.source_id=o.plan_source_id JOIN user_lexemes u ON u.lexeme_key=o.lexeme_key JOIN review_cards c ON c.lexeme_key=o.lexeme_key LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key LEFT JOIN review_suspensions rs ON rs.lexeme_key=o.lexeme_key WHERE o.plan_id=?1 AND o.active=1 AND s.active=1 AND COALESCE(x.excluded,0)=0 AND COALESCE(rs.active,0)=0 AND c.state!=0 AND c.due_at<=?2 AND NOT EXISTS(SELECT 1 FROM study_session_items i WHERE i.session_id=?3 AND i.lexeme_key=o.lexeme_key) ORDER BY o.lexeme_key").map_err(db_error)?;
        let rows = statement
            .query_map(params![plan_id, now, session.0], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        candidates.extend(
            rows.into_iter().map(
                |(lexeme_key, due_at, bnc, frequency)| MobileStudyCandidateV2 {
                    lexeme_key,
                    plan_id: plan_id.into(),
                    kind: "review".into(),
                    due_at: Some(due_at),
                    rank: frequency.or(bnc),
                },
            ),
        );
    }
    {
        let mut statement = database.connection().prepare("SELECT DISTINCT o.lexeme_key,u.bnc_rank,u.frequency_rank FROM study_plan_lexeme_origins o JOIN study_plan_sources s ON s.source_id=o.plan_source_id JOIN user_lexemes u ON u.lexeme_key=o.lexeme_key LEFT JOIN review_cards c ON c.lexeme_key=o.lexeme_key LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key LEFT JOIN review_suspensions rs ON rs.lexeme_key=o.lexeme_key WHERE o.plan_id=?1 AND o.active=1 AND s.active=1 AND COALESCE(x.excluded,0)=0 AND COALESCE(rs.active,0)=0 AND c.lexeme_key IS NULL AND NOT EXISTS(SELECT 1 FROM study_session_items i WHERE i.session_id=?2 AND i.lexeme_key=o.lexeme_key) ORDER BY o.lexeme_key").map_err(db_error)?;
        let rows = statement
            .query_map(params![plan_id, session.0], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        candidates.extend(rows.into_iter().map(|(lexeme_key, bnc, frequency)| {
            MobileStudyCandidateV2 {
                lexeme_key,
                plan_id: plan_id.into(),
                kind: "new".into(),
                due_at: None,
                rank: frequency.or(bnc),
            }
        }));
    }
    Ok(ExtraBatchPlanningInputV2 {
        seed: format!("{}:extra:{}", session.0, count + 1),
        planning: planning_input(
            get_preferences(database)?.queue_order,
            vec![MobileStudyPlanQuotaV2 {
                plan_id: plan_id.into(),
                daily_new_limit: plan.daily_new_limit,
                daily_review_limit: plan.daily_review_limit,
            }],
            candidates,
        )?,
    })
}

pub fn add_extra_batch_v2(
    database: &mut AndroidDatabase,
    plan_id: &str,
    now: &str,
    proposal: MobileQueuePlanEnvelopeV2,
) -> Result<StudySessionState, PlatformError> {
    let preparation = prepare_extra_batch_v2(database, plan_id, now)?;
    validate_queue_envelope_v2(&proposal, &preparation.planning, &preparation.seed)?;
    let session_id = database
        .connection()
        .query_row(
            "SELECT session_id FROM study_sessions ORDER BY day_sequence DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .map_err(db_error)?;
    let selected = proposal
        .selected
        .iter()
        .map(|item| (item.lexeme_key.as_str(), item))
        .collect::<HashMap<_, _>>();
    let new_count = proposal
        .selected
        .iter()
        .filter(|item| item.kind == "new")
        .count() as i64;
    let review_count = proposal.selected.len() as i64 - new_count;
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let batch = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO study_session_batches VALUES(?1,?2,?3,'extra',?4,?5,?6)",
        params![batch, session_id, plan_id, new_count, review_count, now],
    )
    .map_err(db_error)?;
    for (index, key) in proposal.ordered_keys.iter().enumerate() {
        let item = selected.get(key.as_str()).ok_or_else(invalid_proposal)?;
        tx.execute("INSERT OR IGNORE INTO study_session_items(item_id,session_id,batch_id,lexeme_key,plan_id,kind,queue_position,status,had_failure,consecutive_known,attempt_count,version,carried_from_item_id,created_at,updated_at,proposed_answer,fsrs_committed) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',0,0,0,1,NULL,?8,?8,NULL,0)",params![Uuid::new_v4().to_string(),session_id,batch,key,item.plan_id,item.kind,index as i64+1,now]).map_err(db_error)?;
    }
    let pending:i64=tx.query_row("SELECT COUNT(*) FROM study_session_items WHERE session_id=?1 AND status IN ('pending','revealed')",[&session_id],|r|r.get(0)).map_err(db_error)?;
    tx.execute("UPDATE study_sessions SET status=?1,completed_at=?2,extra_batch_count=extra_batch_count+1,updated_at=?3 WHERE session_id=?4",params![if pending>0{"active"}else{"completed"},if pending>0{None}else{Some(now)},now,session_id]).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    session_state(database, &session_id)
}
