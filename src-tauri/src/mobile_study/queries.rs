use super::*;

pub fn get_plan(database: &AndroidDatabase, id: &str) -> Result<StudyPlanDetail, PlatformError> {
    let c = database.connection();
    let row=c.query_row("SELECT name,status,daily_new_limit,daily_review_limit,created_at FROM study_plans WHERE plan_id=?1 AND deleted_at IS NULL",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?))).optional().map_err(db_error)?.ok_or_else(missing_plan)?;
    let mut statement=c.prepare("SELECT source_id,source_type,source_ref,active,sync_status,member_count,last_synced_at,sync_error FROM study_plan_sources WHERE plan_id=?1 ORDER BY added_at").map_err(db_error)?;
    let sources = statement
        .query_map([id], |r| {
            Ok(StudyPlanSourceView {
                source_id: r.get(0)?,
                source_type: r.get(1)?,
                r#ref: r.get(2)?,
                active: r.get::<_, i64>(3)? == 1,
                sync_status: r.get(4)?,
                member_count: r.get(5)?,
                last_synced_at: r.get(6)?,
                sync_error: r.get(7)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let active_sources = sources
        .iter()
        .filter(|source| source.active)
        .collect::<Vec<_>>();
    let words:i64=c.query_row("SELECT COUNT(DISTINCT o.lexeme_key) FROM study_plan_lexeme_origins o JOIN study_plan_sources s ON s.source_id=o.plan_source_id LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key WHERE o.plan_id=?1 AND o.active=1 AND s.active=1 AND COALESCE(x.excluded,0)=0",[id],|r|r.get(0)).map_err(db_error)?;
    let (unseen,learning,consolidating,mature,suspended):(i64,i64,i64,i64,i64)=c.query_row("SELECT COALESCE(SUM(c.lexeme_key IS NULL AND COALESCE(rs.active,0)=0),0),COALESCE(SUM(c.state IN (1,3) AND COALESCE(rs.active,0)=0),0),COALESCE(SUM(c.state=2 AND c.scheduled_days<21 AND COALESCE(rs.active,0)=0),0),COALESCE(SUM(c.state=2 AND c.scheduled_days>=21 AND COALESCE(rs.active,0)=0),0),COALESCE(SUM(COALESCE(rs.active,0)=1),0) FROM (SELECT DISTINCT o.lexeme_key FROM study_plan_lexeme_origins o JOIN study_plan_sources s ON s.source_id=o.plan_source_id LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key WHERE o.plan_id=?1 AND o.active=1 AND s.active=1 AND COALESCE(x.excluded,0)=0) e LEFT JOIN review_cards c ON c.lexeme_key=e.lexeme_key LEFT JOIN review_suspensions rs ON rs.lexeme_key=e.lexeme_key",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(db_error)?;
    let due:i64=c.query_row("SELECT COUNT(DISTINCT o.lexeme_key) FROM study_plan_lexeme_origins o JOIN study_plan_sources s ON s.source_id=o.plan_source_id JOIN review_cards c ON c.lexeme_key=o.lexeme_key LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key LEFT JOIN review_suspensions rs ON rs.lexeme_key=o.lexeme_key WHERE o.plan_id=?1 AND o.active=1 AND s.active=1 AND COALESCE(x.excluded,0)=0 AND COALESCE(rs.active,0)=0 AND c.state!=0 AND c.due_at<=?2",params![id,now_string()],|r|r.get(0)).map_err(db_error)?;
    let excluded: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM study_plan_exclusions WHERE plan_id=?1 AND excluded=1",
            [id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    let sync_status = if active_sources.iter().any(|s| s.sync_status == "error") {
        "error"
    } else if active_sources.iter().any(|s| s.sync_status == "syncing") {
        "syncing"
    } else if active_sources.iter().any(|s| s.sync_status == "pending") {
        "pending"
    } else {
        "ready"
    }
    .to_string();
    Ok(StudyPlanDetail {
        plan_id: id.into(),
        name: row.0,
        status: row.1,
        daily_new_limit: row.2,
        daily_review_limit: row.3,
        word_count: words,
        due_count: due,
        excluded_count: excluded,
        available_new_count: unseen,
        sync_status,
        source_labels: active_sources
            .iter()
            .map(|source| {
                if source.source_type == "reader_manual" {
                    "我的生词".into()
                } else {
                    source.r#ref.to_uppercase()
                }
            })
            .collect(),
        created_at: row.4,
        sources,
        distribution: StudyDistribution {
            unseen,
            learning,
            consolidating,
            mature,
            suspended,
        },
    })
}

pub fn list_plan_words(
    database: &AndroidDatabase,
    plan_id: &str,
    query: StudyPlanWordQuery,
) -> Result<StudyPlanWordPage, PlatformError> {
    get_plan(database, plan_id)?;
    if !matches!(
        query.filter.as_str(),
        "all"
            | "due"
            | "unseen"
            | "learning"
            | "consolidating"
            | "mature"
            | "suspended"
            | "excluded"
    ) {
        return Err(invalid_proposal());
    }
    let text = query.text.nfkc().collect::<String>().trim().to_lowercase();
    let now = now_string();
    let mut statement=database.connection().prepare("SELECT o.lexeme_key,u.lemma_snapshot,u.phonetic_snapshot,u.brief_meanings_json,COALESCE(x.excluded,0),COALESCE(rs.active,0),c.state,c.difficulty,c.stability,c.due_at,c.scheduled_days,COALESCE(c.reps,0),COALESCE(c.lapses,0),c.last_review_at,group_concat(DISTINCT s.source_ref) FROM study_plan_lexeme_origins o JOIN study_plan_sources s ON s.source_id=o.plan_source_id JOIN user_lexemes u ON u.lexeme_key=o.lexeme_key LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key LEFT JOIN review_cards c ON c.lexeme_key=o.lexeme_key LEFT JOIN review_suspensions rs ON rs.lexeme_key=o.lexeme_key WHERE o.plan_id=?1 AND o.active=1 AND s.active=1 GROUP BY o.lexeme_key ORDER BY u.lemma_snapshot COLLATE NOCASE").map_err(db_error)?;
    let mut items = statement
        .query_map([plan_id], |r| {
            let suspended = r.get::<_, i64>(5)? == 1;
            let state_value = r.get::<_, Option<i64>>(6)?;
            let scheduled = r.get::<_, Option<i64>>(10)?;
            let state = if suspended {
                "suspended"
            } else {
                match state_value {
                    None | Some(0) => "unseen",
                    Some(1) | Some(3) => "learning",
                    Some(2) if scheduled.unwrap_or(0) >= 21 => "mature",
                    _ => "consolidating",
                }
            }
            .to_string();
            Ok(StudyPlanWord {
                lexeme_key: r.get(0)?,
                lemma: r.get(1)?,
                phonetic: r.get(2)?,
                meanings: parse_string_array(&r.get::<_, String>(3)?),
                sources: r
                    .get::<_, Option<String>>(14)?
                    .unwrap_or_default()
                    .split(',')
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
                    .collect(),
                excluded: r.get::<_, i64>(4)? == 1,
                suspended,
                state,
                difficulty: r.get(7)?,
                stability: r.get(8)?,
                retrievability: None,
                due_at: r.get(9)?,
                scheduled_days: scheduled,
                reps: r.get(11)?,
                lapses: r.get(12)?,
                last_review_at: r.get(13)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    items.retain(|item| {
        let matches_text = text.is_empty()
            || item.lemma.to_lowercase().contains(&text)
            || item.meanings.iter().any(|meaning| meaning.contains(&text));
        let matches_filter = match query.filter.as_str() {
            "all" => !item.excluded,
            "excluded" => item.excluded,
            "due" => {
                !item.excluded
                    && !item.suspended
                    && item
                        .due_at
                        .as_deref()
                        .is_some_and(|due| due <= now.as_str())
            }
            value => !item.excluded && item.state == value,
        };
        matches_text && matches_filter
    });
    let total = items.len() as i64;
    let offset = query.offset.max(0);
    let limit = query.limit.clamp(1, 100);
    let items = items
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    Ok(StudyPlanWordPage {
        items,
        total,
        offset,
        limit,
    })
}

pub fn list_today_words(
    database: &AndroidDatabase,
    session_id: &str,
    query: StudyTodayWordQuery,
) -> Result<StudyTodayWordPage, PlatformError> {
    if !matches!(
        query.filter.as_str(),
        "all" | "new" | "review" | "known" | "unknown" | "too_easy"
    ) {
        return Err(invalid_proposal());
    }
    let mut statement=database.connection().prepare("SELECT i.item_id,i.lexeme_key,u.lemma_snapshot,u.phonetic_snapshot,u.brief_meanings_json,i.kind,i.attempt_count,i.status,(SELECT answer FROM review_events r WHERE r.session_item_id=i.item_id ORDER BY reviewed_at LIMIT 1),(SELECT answer FROM reinforcement_events r WHERE r.session_item_id=i.item_id AND answer='too_easy' LIMIT 1),(SELECT answer FROM (SELECT answer,reviewed_at happened FROM review_events WHERE session_item_id=i.item_id UNION ALL SELECT answer,created_at happened FROM reinforcement_events WHERE session_item_id=i.item_id) ORDER BY happened DESC LIMIT 1),(SELECT COUNT(*) FROM review_events r WHERE r.session_item_id=i.item_id AND answer='unknown')+(SELECT COUNT(*) FROM reinforcement_events r WHERE r.session_item_id=i.item_id AND answer='unknown'),(SELECT article_title_snapshot FROM saved_contexts c WHERE c.lexeme_key=i.lexeme_key AND c.active=1 ORDER BY saved_at DESC LIMIT 1),(SELECT sentence_snapshot FROM saved_contexts c WHERE c.lexeme_key=i.lexeme_key AND c.active=1 ORDER BY saved_at DESC LIMIT 1) FROM study_session_items i JOIN user_lexemes u ON u.lexeme_key=i.lexeme_key WHERE i.session_id=?1 ORDER BY i.queue_position").map_err(db_error)?;
    let mut items = statement
        .query_map([session_id], |r| {
            let too_easy = r.get::<_, Option<String>>(9)?.is_some();
            let first = if too_easy {
                Some("too_easy".into())
            } else {
                r.get(8)?
            };
            let final_answer = if too_easy {
                Some("too_easy".into())
            } else {
                r.get(10)?
            };
            let article: Option<String> = r.get(12)?;
            let sentence: Option<String> = r.get(13)?;
            Ok(StudyTodayWord {
                item_id: r.get(0)?,
                lexeme_key: r.get(1)?,
                lemma: r.get(2)?,
                phonetic: r.get(3)?,
                meanings: parse_string_array(&r.get::<_, String>(4)?),
                kind: r.get(5)?,
                first_answer: first,
                final_answer,
                attempt_count: r.get(6)?,
                unknown_count: r.get(11)?,
                too_easy,
                completed: r.get::<_, String>(7)? == "completed",
                context: sentence.map(|sentence| StudyTodayContext {
                    article_title: article.unwrap_or_default(),
                    sentence,
                }),
                examples: Vec::new(),
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    items.retain(|item| match query.filter.as_str() {
        "all" => true,
        "new" => item.kind == "new",
        "review" => matches!(item.kind.as_str(), "review" | "carryover"),
        "known" => item.first_answer.as_deref() == Some("known"),
        "unknown" => item.first_answer.as_deref() == Some("unknown"),
        "too_easy" => item.too_easy,
        _ => false,
    });
    let total = items.len() as i64;
    let offset = query.offset.max(0);
    let limit = query.limit.clamp(1, 100);
    let items = items
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    Ok(StudyTodayWordPage {
        items,
        total,
        offset,
        limit,
    })
}

pub fn dashboard(database: &AndroidDatabase) -> Result<StudyDashboard, PlatformError> {
    let plans = list_plans(database, true)?;
    let latest=database.connection().query_row("SELECT session_id,next_rollover_at FROM study_sessions ORDER BY day_sequence DESC LIMIT 1",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(db_error)?;
    let today = latest
        .filter(|(_, rollover)| rollover > &now_string())
        .map(|(id, _)| today_summary(database, &id))
        .transpose()?;
    let review_count = plans
        .iter()
        .filter(|plan| plan.status == "active")
        .map(|plan| plan.due_count)
        .sum();
    let new_quota: i64 = plans
        .iter()
        .filter(|plan| plan.status == "active")
        .map(|plan| plan.daily_new_limit)
        .sum();
    let available: i64 = plans
        .iter()
        .filter(|plan| plan.status == "active")
        .map(|plan| plan.available_new_count)
        .sum();
    Ok(StudyDashboard {
        plans,
        today,
        preview: StudyPreview {
            new_count: available.min(new_quota),
            review_count,
        },
        developer_mode: get_debug_state(database)?.enabled,
    })
}

pub(super) fn today_summary(
    database: &AndroidDatabase,
    session_id: &str,
) -> Result<StudyTodaySummary, PlatformError> {
    let row=database.connection().query_row("SELECT logical_date,status,extra_batch_count,opened_at,completed_at,next_rollover_at FROM study_sessions WHERE session_id=?1",[session_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,String>(5)?))).map_err(db_error)?;
    let all = list_today_words(
        database,
        session_id,
        StudyTodayWordQuery {
            filter: "all".into(),
            offset: 0,
            limit: 100,
        },
    )?;
    let completed = all.items.iter().filter(|item| item.completed).count() as i64;
    let opened = DateTime::parse_from_rfc3339(&row.3).map_err(|_| invalid_proposal())?;
    let end_text = row.4.clone().unwrap_or_else(now_string);
    let ended = DateTime::parse_from_rfc3339(&end_text)
        .unwrap_or_else(|_| chrono::Utc::now().fixed_offset());
    Ok(StudyTodaySummary {
        session_id: session_id.into(),
        logical_date: row.0,
        status: if row.1 == "completed" {
            "completed".into()
        } else {
            "active".into()
        },
        completed,
        total: all.total,
        new_count: all.items.iter().filter(|i| i.kind == "new").count() as i64,
        review_count: all.items.iter().filter(|i| i.kind == "review").count() as i64,
        carryover_count: all.items.iter().filter(|i| i.kind == "carryover").count() as i64,
        unknown_count: all
            .items
            .iter()
            .filter(|i| i.first_answer.as_deref() == Some("unknown"))
            .count() as i64,
        too_easy_count: all.items.iter().filter(|i| i.too_easy).count() as i64,
        extra_batch_count: row.2,
        opened_at: row.3,
        completed_at: row.4,
        duration_seconds: (ended - opened).num_seconds().max(0),
        next_rollover_at: row.5,
        recent_words: all
            .items
            .into_iter()
            .filter(|i| i.completed)
            .rev()
            .take(5)
            .collect(),
    })
}

pub(super) fn session_state(
    database: &AndroidDatabase,
    id: &str,
) -> Result<StudySessionState, PlatformError> {
    let c = database.connection();
    let s = c
        .query_row(
            "SELECT logical_date,status,extra_batch_count FROM study_sessions WHERE session_id=?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(db_error)?;
    let (total,completed):(i64,i64)=c.query_row("SELECT COUNT(*),COALESCE(SUM(status='completed'),0) FROM study_session_items WHERE session_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(db_error)?;
    let current=c.query_row("SELECT i.item_id,i.version,i.lexeme_key,u.lemma_snapshot,u.phonetic_snapshot,u.sense_groups_json,u.brief_meanings_json,i.status,i.proposed_answer,i.had_failure,i.consecutive_known,i.attempt_count,i.kind FROM study_session_items i JOIN user_lexemes u ON u.lexeme_key=i.lexeme_key WHERE i.session_id=?1 AND i.status IN ('pending','revealed') ORDER BY i.queue_position LIMIT 1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,String>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,i64>(9)?,r.get::<_,i64>(10)?,r.get::<_,i64>(11)?,r.get::<_,String>(12)?))).optional().map_err(db_error)?;
    let context = current.as_ref().and_then(|row| {
        crate::mobile_vocabulary::list_contexts(database, &row.2, 0)
            .ok()
            .and_then(|page| page.items.into_iter().next())
    });
    let current = current.map(|r| StudyCardView {
        item_id: r.0,
        kind: r.12,
        version: r.1,
        lexeme_key: r.2,
        lemma: r.3,
        phonetic: r.4,
        sense_groups: serde_json::from_str(&r.5).unwrap_or_default(),
        brief_meanings: serde_json::from_str(&r.6).unwrap_or_default(),
        context,
        examples: vec![],
        revealed: r.7 == "revealed",
        proposed_answer: r.8,
        had_failure: r.9 == 1,
        consecutive_known: r.10,
        attempt_count: r.11,
        can_mark_too_easy: r.11 == 0 && r.9 == 0 && r.7 == "pending",
    });
    Ok(StudySessionState {
        session_id: id.into(),
        logical_date: s.0,
        status: if s.1 == "completed" {
            "completed".into()
        } else {
            "active".into()
        },
        current,
        completed,
        total,
        remaining: total - completed,
        extra_batch_count: s.2,
    })
}
