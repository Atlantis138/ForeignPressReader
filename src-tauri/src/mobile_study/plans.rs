use super::*;

pub fn create_minimal_plan(
    database: &mut AndroidDatabase,
    input: StudyPlanInput,
) -> Result<StudyPlanDetail, PlatformError> {
    validate_plan(&input)?;
    if let Some(existing) = minimal_plan_id(database.connection())? {
        return get_plan(database, &existing);
    }
    let now = now_string();
    let plan_id = format!("plan_{}", Uuid::new_v4());
    let source_id = stable_identity(&[&plan_id, "reader_manual", "favorite"]);
    let device_id = database.device_id().to_owned();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    tx.execute("INSERT INTO study_plans(plan_id,name,status,daily_new_limit,daily_review_limit,new_order,created_at,updated_at,device_id,deleted_at) VALUES(?1,?2,'active',?3,?4,'deterministic_random',?5,?5,?6,NULL)", params![plan_id,input.name.trim(),input.daily_new_limit,input.daily_review_limit,now,device_id]).map_err(db_error)?;
    tx.execute("INSERT INTO study_plan_sources(source_id,plan_id,source_type,source_ref,active,added_at,removed_at,updated_at,device_id,sync_status,sync_version,member_count,last_synced_at,sync_error) VALUES(?1,?2,'reader_manual','favorite',1,?3,NULL,?3,?4,'pending',NULL,0,NULL,NULL)", params![source_id,plan_id,now,device_id]).map_err(db_error)?;
    sync_source(&tx, &plan_id, &source_id, &device_id, &now)?;
    tx.commit().map_err(db_error)?;
    get_plan(database, &plan_id)
}

pub fn get_minimal_plan(
    database: &AndroidDatabase,
) -> Result<Option<StudyPlanDetail>, PlatformError> {
    minimal_plan_id(database.connection())?
        .map(|id| get_plan(database, &id))
        .transpose()
}

pub fn list_plans(
    database: &AndroidDatabase,
    include_archived: bool,
) -> Result<Vec<StudyPlanDetail>, PlatformError> {
    let connection = database.connection();
    let plans = {
        let mut statement = connection
            .prepare(
                "SELECT plan_id,name,status,daily_new_limit,daily_review_limit,created_at \
                 FROM study_plans WHERE deleted_at IS NULL AND (?1=1 OR status!='archived') \
                 ORDER BY created_at",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([i64::from(include_archived)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };
    let mut sources_by_plan: HashMap<String, Vec<StudyPlanSourceView>> = HashMap::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT s.plan_id,s.source_id,s.source_type,s.source_ref,s.active,s.sync_status,\
                 s.member_count,s.last_synced_at,s.sync_error \
                 FROM study_plan_sources s JOIN study_plans p ON p.plan_id=s.plan_id \
                 WHERE p.deleted_at IS NULL AND (?1=1 OR p.status!='archived') ORDER BY s.added_at",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([i64::from(include_archived)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    StudyPlanSourceView {
                        source_id: row.get(1)?,
                        source_type: row.get(2)?,
                        r#ref: row.get(3)?,
                        active: row.get::<_, i64>(4)? == 1,
                        sync_status: row.get(5)?,
                        member_count: row.get(6)?,
                        last_synced_at: row.get(7)?,
                        sync_error: row.get(8)?,
                    },
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (plan_id, source) = row.map_err(db_error)?;
            sources_by_plan.entry(plan_id).or_default().push(source);
        }
    }
    let mut stats_by_plan: HashMap<String, StudyPlanStats> = HashMap::new();
    {
        let mut statement = connection
            .prepare(
                "WITH eligible AS (\
                   SELECT DISTINCT o.plan_id,o.lexeme_key \
                   FROM study_plan_lexeme_origins o \
                   JOIN study_plan_sources s ON s.source_id=o.plan_source_id \
                   LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key \
                   WHERE o.active=1 AND s.active=1 AND COALESCE(x.excluded,0)=0\
                 ), stats AS (\
                   SELECT e.plan_id,COUNT(*) AS word_count,\
                     COALESCE(SUM(c.lexeme_key IS NULL AND COALESCE(rs.active,0)=0),0) AS unseen,\
                     COALESCE(SUM(c.state IN (1,3) AND COALESCE(rs.active,0)=0),0) AS learning,\
                     COALESCE(SUM(c.state=2 AND c.scheduled_days<21 AND COALESCE(rs.active,0)=0),0) AS consolidating,\
                     COALESCE(SUM(c.state=2 AND c.scheduled_days>=21 AND COALESCE(rs.active,0)=0),0) AS mature,\
                     COALESCE(SUM(COALESCE(rs.active,0)=1),0) AS suspended,\
                     COALESCE(SUM(c.lexeme_key IS NOT NULL AND COALESCE(rs.active,0)=0 AND c.state!=0 AND c.due_at<=?1),0) AS due_count \
                   FROM eligible e LEFT JOIN review_cards c ON c.lexeme_key=e.lexeme_key \
                   LEFT JOIN review_suspensions rs ON rs.lexeme_key=e.lexeme_key GROUP BY e.plan_id\
                 ), excluded AS (\
                   SELECT plan_id,COUNT(*) AS excluded_count FROM study_plan_exclusions WHERE excluded=1 GROUP BY plan_id\
                 ) \
                 SELECT p.plan_id,COALESCE(s.word_count,0),COALESCE(s.unseen,0),COALESCE(s.learning,0),\
                   COALESCE(s.consolidating,0),COALESCE(s.mature,0),COALESCE(s.suspended,0),\
                   COALESCE(s.due_count,0),COALESCE(x.excluded_count,0) \
                 FROM study_plans p LEFT JOIN stats s ON s.plan_id=p.plan_id \
                 LEFT JOIN excluded x ON x.plan_id=p.plan_id \
                 WHERE p.deleted_at IS NULL AND (?2=1 OR p.status!='archived')",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![now_string(), i64::from(include_archived)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    StudyPlanStats {
                        word_count: row.get(1)?,
                        unseen: row.get(2)?,
                        learning: row.get(3)?,
                        consolidating: row.get(4)?,
                        mature: row.get(5)?,
                        suspended: row.get(6)?,
                        due_count: row.get(7)?,
                        excluded_count: row.get(8)?,
                    },
                ))
            })
            .map_err(db_error)?;
        for row in rows {
            let (plan_id, stats) = row.map_err(db_error)?;
            stats_by_plan.insert(plan_id, stats);
        }
    }
    Ok(plans
        .into_iter()
        .map(
            |(plan_id, name, status, daily_new_limit, daily_review_limit, created_at)| {
                let sources = sources_by_plan.remove(&plan_id).unwrap_or_default();
                let active_sources = sources
                    .iter()
                    .filter(|source| source.active)
                    .collect::<Vec<_>>();
                let sync_status = if active_sources
                    .iter()
                    .any(|source| source.sync_status == "error")
                {
                    "error"
                } else if active_sources
                    .iter()
                    .any(|source| source.sync_status == "syncing")
                {
                    "syncing"
                } else if active_sources
                    .iter()
                    .any(|source| source.sync_status == "pending")
                {
                    "pending"
                } else {
                    "ready"
                }
                .to_string();
                let stats = stats_by_plan.remove(&plan_id).unwrap_or_default();
                StudyPlanDetail {
                    plan_id,
                    name,
                    status,
                    daily_new_limit,
                    daily_review_limit,
                    word_count: stats.word_count,
                    due_count: stats.due_count,
                    excluded_count: stats.excluded_count,
                    available_new_count: stats.unseen,
                    sync_status,
                    source_labels: active_sources
                        .iter()
                        .map(|source| {
                            if source.source_type == "reader_manual" {
                                "\u{6211}\u{7684}\u{751f}\u{8bcd}".into()
                            } else {
                                source.r#ref.to_uppercase()
                            }
                        })
                        .collect(),
                    created_at,
                    sources,
                    distribution: StudyDistribution {
                        unseen: stats.unseen,
                        learning: stats.learning,
                        consolidating: stats.consolidating,
                        mature: stats.mature,
                        suspended: stats.suspended,
                    },
                }
            },
        )
        .collect())
}

pub fn create_plan(
    database: &mut AndroidDatabase,
    input: StudyPlanInput,
) -> Result<StudyPlanDetail, PlatformError> {
    validate_plan(&input)?;
    let now = now_string();
    let plan_id = format!("plan_{}", Uuid::new_v4());
    let device_id = database.device_id().to_owned();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    tx.execute("INSERT INTO study_plans(plan_id,name,status,daily_new_limit,daily_review_limit,new_order,created_at,updated_at,device_id,deleted_at) VALUES(?1,?2,'active',?3,?4,'deterministic_random',?5,?5,?6,NULL)", params![plan_id,input.name.nfkc().collect::<String>().trim(),input.daily_new_limit,input.daily_review_limit,now,device_id]).map_err(db_error)?;
    replace_sources(&tx, &plan_id, &input.sources, &now, &device_id)?;
    tx.commit().map_err(db_error)?;
    get_plan(database, &plan_id)
}

pub fn update_plan(
    database: &mut AndroidDatabase,
    plan_id: &str,
    input: StudyPlanInput,
) -> Result<StudyPlanDetail, PlatformError> {
    validate_plan(&input)?;
    let now = now_string();
    let device_id = database.device_id().to_owned();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let changed=tx.execute("UPDATE study_plans SET name=?1,daily_new_limit=?2,daily_review_limit=?3,updated_at=?4,device_id=?5 WHERE plan_id=?6 AND deleted_at IS NULL",params![input.name.nfkc().collect::<String>().trim(),input.daily_new_limit,input.daily_review_limit,now,device_id,plan_id]).map_err(db_error)?;
    if changed != 1 {
        return Err(missing_plan());
    }
    replace_sources(&tx, plan_id, &input.sources, &now, &device_id)?;
    tx.commit().map_err(db_error)?;
    get_plan(database, plan_id)
}

pub fn set_plan_status(
    database: &mut AndroidDatabase,
    plan_id: &str,
    status: &str,
) -> Result<(), PlatformError> {
    if !matches!(status, "active" | "paused" | "archived") {
        return Err(invalid_proposal());
    }
    let now = now_string();
    let device = database.device_id().to_owned();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let changed=tx.execute("UPDATE study_plans SET status=?1,updated_at=?2,device_id=?3 WHERE plan_id=?4 AND deleted_at IS NULL",params![status,now,device,plan_id]).map_err(db_error)?;
    if changed != 1 {
        return Err(missing_plan());
    }
    refresh_learning_sources(&tx, plan_id, &now, &device)?;
    tx.commit().map_err(db_error)
}

pub fn set_word_excluded(
    database: &mut AndroidDatabase,
    plan_id: &str,
    lexeme_key: &str,
    excluded: bool,
) -> Result<(), PlatformError> {
    let now = now_string();
    let device = database.device_id().to_owned();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if !tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM study_plans WHERE plan_id=?1 AND deleted_at IS NULL)",
            [plan_id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(db_error)?
    {
        return Err(missing_plan());
    }
    tx.execute("INSERT INTO study_plan_exclusions(plan_id,lexeme_key,excluded,excluded_at,restored_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(plan_id,lexeme_key) DO UPDATE SET excluded=excluded.excluded,excluded_at=excluded.excluded_at,restored_at=excluded.restored_at,updated_at=excluded.updated_at,device_id=excluded.device_id",params![plan_id,lexeme_key,i64::from(excluded),if excluded{Some(now.clone())}else{None},if excluded{None}else{Some(now.clone())},now,device]).map_err(db_error)?;
    refresh_learning_source_for_key(&tx, plan_id, lexeme_key, &now, &device)?;
    tx.commit().map_err(db_error)
}

pub fn set_word_suspended(
    database: &AndroidDatabase,
    lexeme_key: &str,
    suspended: bool,
) -> Result<(), PlatformError> {
    let exists = database
        .connection()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM user_lexemes WHERE lexeme_key=?1)",
            [lexeme_key],
            |r| r.get::<_, bool>(0),
        )
        .map_err(db_error)?;
    if !exists {
        return Err(PlatformError::new(
            "learningEntityMissing",
            "词条不存在。",
            false,
        ));
    }
    let now = now_string();
    database.connection().execute("INSERT INTO review_suspensions(lexeme_key,active,reason,suspended_at,restored_at,updated_at,device_id) VALUES(?1,?2,'too_easy',?3,?4,?3,?5) ON CONFLICT(lexeme_key) DO UPDATE SET active=excluded.active,restored_at=excluded.restored_at,updated_at=excluded.updated_at,device_id=excluded.device_id",params![lexeme_key,i64::from(suspended),now,if suspended{None}else{Some(now.clone())},database.device_id()]).map_err(db_error)?;
    Ok(())
}

pub fn current_item_lexeme(
    database: &AndroidDatabase,
    session_id: &str,
    item_id: &str,
    expected_version: i64,
) -> Result<String, PlatformError> {
    database
        .connection()
        .query_row(
            "SELECT lexeme_key FROM study_session_items WHERE session_id=?1 AND item_id=?2 AND status='revealed' AND version=?3",
            params![session_id, item_id, expected_version],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(version_conflict)
}

pub fn get_debug_state(database: &AndroidDatabase) -> Result<StudyDebugState, PlatformError> {
    let enabled = database
        .connection()
        .query_row(
            "SELECT value FROM settings WHERE key='study.developer-mode'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
        .is_some_and(|value| value == "true");
    let last_reset_at = database
        .connection()
        .query_row(
            "SELECT reset_at FROM study_progress_state WHERE state_id='global'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(db_error)?
        .flatten();
    Ok(StudyDebugState {
        enabled,
        last_reset_at,
    })
}

pub fn set_developer_mode(
    database: &AndroidDatabase,
    enabled: bool,
) -> Result<StudyDebugState, PlatformError> {
    database.connection().execute(
        "INSERT INTO settings(key,value,updated_at,device_id) VALUES('study.developer-mode',?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,device_id=excluded.device_id",
        params![if enabled { "true" } else { "false" }, now_string(), database.device_id()],
    ).map_err(db_error)?;
    get_debug_state(database)
}

pub fn delete_plan(
    database: &mut AndroidDatabase,
    plan_id: &str,
    confirmation_name: &str,
    reset_word_progress: bool,
) -> Result<(), PlatformError> {
    require_debug(database)?;
    let plan_name = database
        .connection()
        .query_row(
            "SELECT name FROM study_plans WHERE plan_id=?1 AND deleted_at IS NULL",
            [plan_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(missing_plan)?;
    if plan_name != confirmation_name.nfkc().collect::<String>().trim() {
        return Err(PlatformError::new(
            "invalidInput",
            "计划名称确认不匹配。",
            false,
        ));
    }
    let lexeme_keys = if reset_word_progress {
        query_keys(
            database.connection(),
            "SELECT DISTINCT lexeme_key FROM study_plan_lexeme_origins WHERE plan_id=?1",
            [plan_id],
        )?
    } else {
        Vec::new()
    };
    let now = now_string();
    let device = database.device_id().to_owned();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let mut sessions = HashSet::new();
    {
        let mut statement = tx
            .prepare(
                "SELECT DISTINCT session_id FROM study_session_items WHERE plan_id=?1 AND status IN ('pending','revealed')",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([plan_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        for row in rows {
            sessions.insert(row.map_err(db_error)?);
        }
    }
    tx.execute(
        "DELETE FROM study_session_items WHERE plan_id=?1 AND status IN ('pending','revealed')",
        [plan_id],
    )
    .map_err(db_error)?;
    if reset_word_progress {
        for key in &lexeme_keys {
            {
                let mut statement = tx
                    .prepare(
                        "SELECT DISTINCT session_id FROM study_session_items WHERE lexeme_key=?1",
                    )
                    .map_err(db_error)?;
                let rows = statement
                    .query_map([key], |row| row.get::<_, String>(0))
                    .map_err(db_error)?;
                for row in rows {
                    sessions.insert(row.map_err(db_error)?);
                }
            }
            tx.execute(
                "INSERT INTO study_lexeme_resets(lexeme_key,source_plan_id,reset_at,updated_at,device_id) VALUES(?1,?2,?3,?3,?4) ON CONFLICT(lexeme_key) DO UPDATE SET source_plan_id=excluded.source_plan_id,reset_at=excluded.reset_at,updated_at=excluded.updated_at,device_id=excluded.device_id",
                params![key, plan_id, now, device],
            ).map_err(db_error)?;
            tx.execute(
                "DELETE FROM reinforcement_events WHERE lexeme_key=?1",
                [key],
            )
            .map_err(db_error)?;
            tx.execute("DELETE FROM review_events WHERE lexeme_key=?1", [key])
                .map_err(db_error)?;
            tx.execute("DELETE FROM review_cards WHERE lexeme_key=?1", [key])
                .map_err(db_error)?;
            tx.execute("DELETE FROM review_suspensions WHERE lexeme_key=?1", [key])
                .map_err(db_error)?;
            tx.execute("DELETE FROM study_session_items WHERE lexeme_key=?1", [key])
                .map_err(db_error)?;
        }
        tx.execute(
            "DELETE FROM scheduler_profiles WHERE profile_id NOT IN (SELECT DISTINCT profile_id FROM review_events)",
            [],
        )
        .map_err(db_error)?;
    }
    tx.execute(
        "UPDATE study_plans SET status='archived',deleted_at=?1,updated_at=?1,device_id=?2 WHERE plan_id=?3",
        params![now, device, plan_id],
    )
    .map_err(db_error)?;
    tx.execute(
        "UPDATE study_plan_sources SET active=0,removed_at=?1,updated_at=?1,device_id=?2 WHERE plan_id=?3",
        params![now, device, plan_id],
    )
    .map_err(db_error)?;
    tx.execute(
        "UPDATE study_plan_lexeme_origins SET active=0,removed_at=?1,updated_at=?1,device_id=?2 WHERE plan_id=?3",
        params![now, device, plan_id],
    )
    .map_err(db_error)?;
    tx.execute(
        "UPDATE vocabulary_sources SET active=0,removed_at=?1,updated_at=?1,device_id=?2 WHERE source_type='learning_plan' AND source_ref=?3",
        params![now, device, plan_id],
    )
    .map_err(db_error)?;
    for session_id in sessions {
        tx.execute(
            "UPDATE study_sessions SET status='completed',completed_at=COALESCE(completed_at,?1),updated_at=?1 WHERE session_id=?2 AND NOT EXISTS(SELECT 1 FROM study_session_items WHERE session_id=?2 AND status IN ('pending','revealed'))",
            params![now, session_id],
        ).map_err(db_error)?;
    }
    tx.commit().map_err(db_error)
}

pub fn reset_all_progress(
    database: &mut AndroidDatabase,
    confirmation_token: &str,
) -> Result<(), PlatformError> {
    require_debug(database)?;
    if confirmation_token != "RESET_ALL_STUDY_PROGRESS" {
        return Err(PlatformError::new("invalidInput", "重置确认无效。", false));
    }
    let now = now_string();
    let device = database.device_id().to_owned();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    tx.execute_batch(
        "DELETE FROM reinforcement_events;
         DELETE FROM review_events;
         DELETE FROM study_session_items;
         DELETE FROM study_session_batches;
         DELETE FROM study_sessions;
         DELETE FROM review_cards;
         DELETE FROM scheduler_profiles;",
    )
    .map_err(db_error)?;
    tx.execute(
        "INSERT INTO study_progress_state(state_id,reset_at,updated_at,device_id) VALUES('global',?1,?1,?2) ON CONFLICT(state_id) DO UPDATE SET reset_at=excluded.reset_at,updated_at=excluded.updated_at,device_id=excluded.device_id",
        params![now, device],
    ).map_err(db_error)?;
    tx.commit().map_err(db_error)
}

pub fn force_next_study_day(
    database: &AndroidDatabase,
    confirmation_token: &str,
) -> Result<(), PlatformError> {
    require_debug(database)?;
    if confirmation_token != "NEXT_STUDY_DAY" {
        return Err(PlatformError::new(
            "invalidInput",
            "推进学习日确认无效。",
            false,
        ));
    }
    let now = Utc::now();
    let changed = database.connection().execute(
        "UPDATE study_sessions SET next_rollover_at=?1,debug_forced=1,updated_at=?2 WHERE session_id=(SELECT session_id FROM study_sessions ORDER BY day_sequence DESC LIMIT 1)",
        params![(now - Duration::seconds(1)).to_rfc3339(), now.to_rfc3339()],
    ).map_err(db_error)?;
    if changed != 1 {
        return Err(missing_session());
    }
    Ok(())
}
