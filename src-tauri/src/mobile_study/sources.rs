use super::*;

pub(super) fn sync_source(
    tx: &Transaction<'_>,
    plan_id: &str,
    source_id: &str,
    device_id: &str,
    now: &str,
) -> Result<(), PlatformError> {
    let keys=query_keys(tx,"SELECT u.lexeme_key FROM user_lexemes u JOIN vocabulary_sources s ON s.lexeme_key=u.lexeme_key WHERE s.source_type='reader_manual' AND s.source_ref='favorite' AND s.active=1 ORDER BY u.lexeme_key",[])?;
    let active: HashSet<_> = keys.iter().collect();
    tx.execute("UPDATE study_plan_lexeme_origins SET active=0,removed_at=?1,updated_at=?1,device_id=?2 WHERE plan_source_id=?3 AND active=1",params![now,device_id,source_id]).map_err(db_error)?;
    for key in &keys {
        let id = stable_identity(&[source_id, key]);
        tx.execute("INSERT INTO study_plan_lexeme_origins(origin_id,plan_id,plan_source_id,lexeme_key,active,discovered_at,removed_at,updated_at,device_id) VALUES(?1,?2,?3,?4,1,?5,NULL,?5,?6) ON CONFLICT(plan_source_id,lexeme_key) DO UPDATE SET active=1,removed_at=NULL,updated_at=excluded.updated_at,device_id=excluded.device_id",params![id,plan_id,source_id,key,now,device_id]).map_err(db_error)?;
    }
    let _ = active;
    let version = format!("reader:{}:{}", keys.len(), now);
    tx.execute("UPDATE study_plan_sources SET sync_status='ready',sync_version=?1,member_count=?2,last_synced_at=?3,sync_error=NULL,updated_at=?3,device_id=?4 WHERE source_id=?5",params![version,keys.len() as i64,now,device_id,source_id]).map_err(db_error)?;
    Ok(())
}

pub fn sync_sources(
    database: &mut AndroidDatabase,
    plan_id: Option<&str>,
) -> Result<StudySourceSyncResult, PlatformError> {
    let mut sql="SELECT source_id,plan_id,source_type,sync_status,COALESCE(sync_version,'') FROM study_plan_sources WHERE active=1".to_string();
    if plan_id.is_some() {
        sql.push_str(" AND plan_id=?1");
    }
    let mut statement = database.connection().prepare(&sql).map_err(db_error)?;
    let rows = if let Some(id) = plan_id {
        statement
            .query_map([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    } else {
        statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    };
    drop(statement);
    let revision = reader_source_revision(database.connection())?;
    let device = database.device_id().to_owned();
    let now = now_string();
    let mut synced = 0;
    let mut failed = 0;
    for (source_id, source_plan, source_type, status, version) in rows {
        if source_type != "reader_manual" {
            continue;
        }
        if status == "ready" && version == revision {
            continue;
        }
        let tx = database
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        match sync_source(&tx, &source_plan, &source_id, &device, &now) {
            Ok(()) => {
                tx.execute(
                    "UPDATE study_plan_sources SET sync_version=?1 WHERE source_id=?2",
                    params![revision, source_id],
                )
                .map_err(db_error)?;
                tx.commit().map_err(db_error)?;
                synced += 1
            }
            Err(_) => {
                failed += 1;
            }
        }
    }
    Ok(StudySourceSyncResult {
        synced_sources: synced,
        failed_sources: failed,
    })
}

pub fn apply_source_snapshot(
    database: &mut AndroidDatabase,
    snapshot: StudySourceSnapshot,
) -> Result<(), PlatformError> {
    if snapshot.version.trim().is_empty() {
        return Err(invalid_proposal());
    }
    let now = now_string();
    let device = database.device_id().to_owned();
    let tx = database
        .connection_mut()
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let source=tx.query_row("SELECT plan_id,active,sync_version,sync_status FROM study_plan_sources WHERE source_id=?1",[&snapshot.source_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?))).optional().map_err(db_error)?.ok_or_else(missing_plan)?;
    if source.1 != 1 {
        return Err(missing_plan());
    }
    if source.2.as_deref() == Some(snapshot.version.as_str()) && source.3 == "ready" {
        tx.commit().map_err(db_error)?;
        return Ok(());
    }
    let unique = snapshot
        .items
        .iter()
        .map(|item| item.lexeme_key.as_str())
        .collect::<HashSet<_>>();
    if unique.len() != snapshot.items.len()
        || snapshot
            .items
            .iter()
            .any(|item| item.lexeme_key.is_empty() || item.lemma.trim().is_empty())
    {
        return Err(invalid_proposal());
    }
    tx.execute("UPDATE study_plan_lexeme_origins SET active=0,removed_at=?1,updated_at=?1,device_id=?2 WHERE plan_source_id=?3 AND active=1",params![now,device,snapshot.source_id]).map_err(db_error)?;
    for item in &snapshot.items {
        tx.execute("INSERT INTO user_lexemes(lexeme_key,lemma_snapshot,phonetic_snapshot,brief_meanings_json,sense_groups_json,bnc_rank,frequency_rank,manual_state,manual_familiarity,created_at,updated_at,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7,'unrated',NULL,?8,?8,?9) ON CONFLICT(lexeme_key) DO UPDATE SET lemma_snapshot=excluded.lemma_snapshot,phonetic_snapshot=COALESCE(excluded.phonetic_snapshot,user_lexemes.phonetic_snapshot),brief_meanings_json=excluded.brief_meanings_json,sense_groups_json=CASE WHEN excluded.sense_groups_json='[]' THEN user_lexemes.sense_groups_json ELSE excluded.sense_groups_json END,bnc_rank=COALESCE(excluded.bnc_rank,user_lexemes.bnc_rank),frequency_rank=COALESCE(excluded.frequency_rank,user_lexemes.frequency_rank),updated_at=excluded.updated_at,device_id=excluded.device_id",params![item.lexeme_key,item.lemma,item.phonetic,serde_json::to_string(&item.brief_meanings).map_err(json_error)?,serde_json::to_string(&item.senses).map_err(json_error)?,item.bnc,item.frequency,now,device]).map_err(db_error)?;
        let origin = stable_identity(&[&snapshot.source_id, &item.lexeme_key]);
        tx.execute("INSERT INTO study_plan_lexeme_origins(origin_id,plan_id,plan_source_id,lexeme_key,active,discovered_at,removed_at,updated_at,device_id) VALUES(?1,?2,?3,?4,1,?5,NULL,?5,?6) ON CONFLICT(plan_source_id,lexeme_key) DO UPDATE SET active=1,removed_at=NULL,updated_at=excluded.updated_at,device_id=excluded.device_id",params![origin,source.0,snapshot.source_id,item.lexeme_key,now,device]).map_err(db_error)?;
    }
    tx.execute("UPDATE study_plan_sources SET sync_status='ready',sync_version=?1,member_count=?2,last_synced_at=?3,sync_error=NULL,updated_at=?3,device_id=?4 WHERE source_id=?5",params![snapshot.version,snapshot.items.len() as i64,now,device,snapshot.source_id]).map_err(db_error)?;
    refresh_learning_sources(&tx, &source.0, &now, &device)?;
    tx.commit().map_err(db_error)
}

pub(super) fn reader_source_revision(connection: &Connection) -> Result<String, PlatformError> {
    let row=connection.query_row("SELECT COUNT(*),COALESCE(MAX(updated_at),'') FROM vocabulary_sources WHERE source_type='reader_manual' AND source_ref='favorite' AND active=1",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).map_err(db_error)?;
    Ok(format!("reader:{}:{}", row.0, row.1))
}

pub(super) fn replace_sources(
    tx: &Transaction<'_>,
    plan_id: &str,
    sources: &[StudyPlanSourceInput],
    now: &str,
    device: &str,
) -> Result<(), PlatformError> {
    let desired = sources
        .iter()
        .map(|source| format!("{}:{}", source.source_type, source.r#ref))
        .collect::<HashSet<_>>();
    let mut statement = tx
        .prepare("SELECT source_id,source_type,source_ref FROM study_plan_sources WHERE plan_id=?1")
        .map_err(db_error)?;
    let existing = statement
        .query_map([plan_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(statement);
    for (id, kind, reference) in existing {
        if !desired.contains(&format!("{}:{}", kind, reference)) {
            tx.execute("UPDATE study_plan_sources SET active=0,removed_at=?1,updated_at=?1,device_id=?2 WHERE source_id=?3",params![now,device,id]).map_err(db_error)?;
            tx.execute("UPDATE study_plan_lexeme_origins SET active=0,removed_at=?1,updated_at=?1,device_id=?2 WHERE plan_source_id=?3",params![now,device,id]).map_err(db_error)?;
        }
    }
    for source in sources {
        let id = stable_identity(&[plan_id, &source.source_type, &source.r#ref]);
        tx.execute("INSERT INTO study_plan_sources(source_id,plan_id,source_type,source_ref,active,added_at,removed_at,updated_at,device_id,sync_status,sync_version,member_count,last_synced_at,sync_error) VALUES(?1,?2,?3,?4,1,?5,NULL,?5,?6,'pending',NULL,0,NULL,NULL) ON CONFLICT(plan_id,source_type,source_ref) DO UPDATE SET active=1,removed_at=NULL,sync_status=CASE WHEN study_plan_sources.active=0 THEN 'pending' ELSE study_plan_sources.sync_status END,updated_at=excluded.updated_at,device_id=excluded.device_id",params![id,plan_id,source.source_type,source.r#ref,now,device]).map_err(db_error)?;
    }
    refresh_learning_sources(tx, plan_id, now, device)
}

pub(super) fn refresh_learning_sources(
    tx: &Transaction<'_>,
    plan_id: &str,
    now: &str,
    device: &str,
) -> Result<(), PlatformError> {
    tx.execute("UPDATE vocabulary_sources SET active=0,removed_at=?1,updated_at=?1,device_id=?2 WHERE source_type='learning_plan' AND source_ref=?3 AND active=1",params![now,device,plan_id]).map_err(db_error)?;
    let status = tx
        .query_row(
            "SELECT status FROM study_plans WHERE plan_id=?1",
            [plan_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(db_error)?;
    if status == "archived" {
        return Ok(());
    }
    let keys=query_keys(tx,"SELECT DISTINCT o.lexeme_key FROM study_plan_lexeme_origins o JOIN study_plan_sources s ON s.source_id=o.plan_source_id LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key WHERE o.plan_id=?1 AND o.active=1 AND s.active=1 AND COALESCE(x.excluded,0)=0",[plan_id])?;
    for key in keys {
        let id = stable_identity(&[&key, "learning_plan", plan_id]);
        tx.execute("INSERT INTO vocabulary_sources(source_id,lexeme_key,source_type,source_ref,active,added_at,removed_at,updated_at,device_id) VALUES(?1,?2,'learning_plan',?3,1,?4,NULL,?4,?5) ON CONFLICT(lexeme_key,source_type,source_ref) DO UPDATE SET active=1,removed_at=NULL,updated_at=excluded.updated_at,device_id=excluded.device_id",params![id,key,plan_id,now,device]).map_err(db_error)?;
    }
    Ok(())
}
pub(super) fn refresh_learning_source_for_key(
    tx: &Transaction<'_>,
    plan_id: &str,
    key: &str,
    now: &str,
    device: &str,
) -> Result<(), PlatformError> {
    let eligible=tx.query_row("SELECT EXISTS(SELECT 1 FROM study_plan_lexeme_origins o JOIN study_plan_sources s ON s.source_id=o.plan_source_id LEFT JOIN study_plan_exclusions x ON x.plan_id=o.plan_id AND x.lexeme_key=o.lexeme_key WHERE o.plan_id=?1 AND o.lexeme_key=?2 AND o.active=1 AND s.active=1 AND COALESCE(x.excluded,0)=0)",params![plan_id,key],|r|r.get::<_,bool>(0)).map_err(db_error)?;
    if eligible {
        let id = stable_identity(&[key, "learning_plan", plan_id]);
        tx.execute("INSERT INTO vocabulary_sources(source_id,lexeme_key,source_type,source_ref,active,added_at,removed_at,updated_at,device_id) VALUES(?1,?2,'learning_plan',?3,1,?4,NULL,?4,?5) ON CONFLICT(lexeme_key,source_type,source_ref) DO UPDATE SET active=1,removed_at=NULL,updated_at=excluded.updated_at,device_id=excluded.device_id",params![id,key,plan_id,now,device]).map_err(db_error)?;
    } else {
        tx.execute("UPDATE vocabulary_sources SET active=0,removed_at=?1,updated_at=?1,device_id=?2 WHERE source_type='learning_plan' AND source_ref=?3 AND lexeme_key=?4 AND active=1",params![now,device,plan_id,key]).map_err(db_error)?;
    }
    Ok(())
}
