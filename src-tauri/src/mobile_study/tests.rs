use super::*;
use crate::platform_paths::PlatformPaths;
use sha2::{Digest, Sha256};

fn database() -> (tempfile::TempDir, AndroidDatabase) {
    let root = tempfile::tempdir().expect("tempdir");
    let paths = PlatformPaths::new(
        root.path().join("data"),
        root.path().join("cache"),
        root.path().join("logs"),
    );
    let database = AndroidDatabase::open(&paths, "test").expect("database");
    let device = database.device_id().to_owned();
    database.connection().execute(
        "INSERT INTO user_lexemes(lexeme_key,lemma_snapshot,phonetic_snapshot,brief_meanings_json,sense_groups_json,created_at,updated_at,device_id) VALUES('lex_en_bef0f93b22ad080a29e3aa86','run','rʌn','[\"跑；运行\"]','[]','2026-07-12T00:00:00.000Z','2026-07-12T00:00:00.000Z',?1)",
        [&device],
    ).expect("lexeme");
    database.connection().execute(
        "INSERT INTO vocabulary_sources(source_id,lexeme_key,source_type,source_ref,active,added_at,removed_at,updated_at,device_id) VALUES('favorite-source','lex_en_bef0f93b22ad080a29e3aa86','reader_manual','favorite',1,'2026-07-12T00:00:00.000Z',NULL,'2026-07-12T00:00:00.000Z',?1)",
        [&device],
    ).expect("favorite");
    (root, database)
}

fn plan_input() -> StudyPlanInput {
    StudyPlanInput {
        name: "我的生词计划".into(),
        daily_new_limit: 20,
        daily_review_limit: 200,
        sources: vec![StudyPlanSourceInput {
            source_type: "reader_manual".into(),
            r#ref: "favorite".into(),
        }],
    }
}

fn moment(now: &str, logical_date: &str, next: &str) -> StudyMomentProposal {
    StudyMomentProposal {
        now: now.into(),
        logical_date: logical_date.into(),
        timezone: "Asia/Shanghai".into(),
        cutoff_hour: 4,
        next_rollover_at: next.into(),
    }
}

fn open_fixture(database: &mut AndroidDatabase) -> StudySessionState {
    create_minimal_plan(database, plan_input()).expect("plan");
    let now = "2026-07-12T02:00:00.000Z";
    let preparation = prepare_today_v2(database, now).expect("prepare");
    open_today_v2(
        database,
        moment(now, "2026-07-12", "2026-07-12T20:00:00.000Z"),
        queue_v2(&preparation, "2026-07-12"),
    )
    .expect("open")
}

fn queue_v2(input: &TodayPlanningInputV2, logical_date: &str) -> MobileQueuePlanEnvelopeV2 {
    queue_v2_for_seed(input, format!("{logical_date}:regular"))
}

fn queue_v2_for_seed(input: &TodayPlanningInputV2, seed: String) -> MobileQueuePlanEnvelopeV2 {
    let selected = input
        .candidates
        .iter()
        .map(|candidate| MobileQueueSelectionV2 {
            lexeme_key: candidate.lexeme_key.clone(),
            plan_id: candidate.plan_id.clone(),
            kind: candidate.kind.clone(),
        })
        .collect::<Vec<_>>();
    let expected = serde_json::json!({
        "version": 2,
        "seed": seed,
        "order": input.order,
        "stateFingerprint": input.state_fingerprint,
        "quotas": input.quotas,
        "candidates": input.candidates,
    });
    MobileQueuePlanEnvelopeV2 {
        contract_version: 2,
        engine_version: "learning-queue-v2".into(),
        seed,
        order: input.order.clone(),
        state_fingerprint: input.state_fingerprint.clone(),
        ordered_keys: selected
            .iter()
            .map(|candidate| candidate.lexeme_key.clone())
            .collect(),
        selected,
        input_fingerprint: hex::encode(Sha256::digest(
            canonical_json(&expected)
                .expect("canonical planning input")
                .as_bytes(),
        )),
    }
}

#[test]
fn opens_extra_batches_with_the_same_version_two_queue_contract() {
    let (_root, mut database) = database();
    database
        .connection()
        .execute("UPDATE vocabulary_sources SET active=0", [])
        .expect("hide initial favorite");
    let plan = create_minimal_plan(&mut database, plan_input()).expect("plan");
    let now = "2026-07-12T02:00:00.000Z";
    let preparation = prepare_today_v2(&mut database, now).expect("prepare empty day");
    let session = open_today_v2(
        &mut database,
        moment(now, "2026-07-12", "2026-07-12T20:00:00.000Z"),
        queue_v2(&preparation, "2026-07-12"),
    )
    .expect("open empty day");
    assert_eq!(session.status, "completed");

    database
        .connection()
        .execute("UPDATE vocabulary_sources SET active=1", [])
        .expect("restore favorite");
    sync_sources(&mut database, Some(&plan.plan_id)).expect("sync plan source");
    let preparation = prepare_extra_batch_v2(&database, &plan.plan_id, now).expect("prepare extra");
    assert_eq!(preparation.planning.candidates.len(), 1);
    let proposal = queue_v2_for_seed(&preparation.planning, preparation.seed.clone());
    let state =
        add_extra_batch_v2(&mut database, &plan.plan_id, now, proposal).expect("add extra batch");
    assert_eq!(state.extra_batch_count, 1);
    assert_eq!(state.status, "active");
    assert_eq!(state.remaining, 1);
}

#[test]
fn creates_syncs_and_commits_one_card_exactly_once() {
    let (_root, mut database) = database();
    let session = open_fixture(&mut database);
    let current = session.current.expect("current");
    database
        .connection()
        .execute(
            "UPDATE study_session_items SET version=2 WHERE item_id=?1",
            [&current.item_id],
        )
        .expect("align vector");
    let staged = stage_answer(
        &database,
        StudyStageAnswerRequest {
            session_id: session.session_id.clone(),
            item_id: current.item_id.clone(),
            expected_version: 2,
            answer: "known".into(),
        },
    )
    .expect("stage");
    assert!(staged.current.as_ref().expect("revealed").revealed);
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("../../../test-vectors/d0-learning.json"))
            .expect("vector");
    let proposal: MobileReviewTransitionProposal =
        serde_json::from_value(vector["study"]["reviewProposal"].clone()).expect("proposal");
    let request = StudyAnswerRequest {
        session_id: session.session_id.clone(),
        item_id: current.item_id,
        command_id: proposal.command_id.clone(),
        expected_version: 3,
        answer: "known".into(),
    };
    let completed = commit_answer(&mut database, request.clone(), Some(proposal)).expect("commit");
    assert_eq!(completed.status, "completed");
    let replay = commit_answer(&mut database, request.clone(), None).expect("replay");
    assert_eq!(replay.completed, 1);
    let mismatch = commit_answer(
        &mut database,
        StudyAnswerRequest {
            item_id: "different".into(),
            ..request
        },
        None,
    )
    .expect_err("mismatched replay");
    assert_eq!(mismatch.code, "learningCommandReplay");
    let events: i64 = database
        .connection()
        .query_row("SELECT COUNT(*) FROM review_events", [], |row| row.get(0))
        .expect("events");
    let cards: i64 = database
        .connection()
        .query_row("SELECT COUNT(*) FROM review_cards", [], |row| row.get(0))
        .expect("cards");
    assert_eq!((events, cards), (1, 1));
    let stale = commit_answer(
        &mut database,
        StudyAnswerRequest {
            session_id: session.session_id,
            item_id: "missing".into(),
            command_id: Uuid::new_v4().to_string(),
            expected_version: 3,
            answer: "known".into(),
        },
        None,
    )
    .expect_err("conflict");
    assert_eq!(stale.code, "learningVersionConflict");
}

#[test]
fn rolls_back_card_event_and_item_when_event_insert_fails() {
    let (_root, mut database) = database();
    let session = open_fixture(&mut database);
    let current = session.current.expect("current");
    database
        .connection()
        .execute(
            "UPDATE study_session_items SET version=2 WHERE item_id=?1",
            [&current.item_id],
        )
        .expect("align");
    stage_answer(
        &database,
        StudyStageAnswerRequest {
            session_id: session.session_id.clone(),
            item_id: current.item_id.clone(),
            expected_version: 2,
            answer: "known".into(),
        },
    )
    .expect("stage");
    database.connection().execute_batch("CREATE TRIGGER fail_review_event BEFORE INSERT ON review_events BEGIN SELECT RAISE(ABORT,'fault'); END;").expect("trigger");
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("../../../test-vectors/d0-learning.json"))
            .expect("vector");
    let proposal: MobileReviewTransitionProposal =
        serde_json::from_value(vector["study"]["reviewProposal"].clone()).expect("proposal");
    let error = commit_answer(
        &mut database,
        StudyAnswerRequest {
            session_id: session.session_id,
            item_id: current.item_id.clone(),
            command_id: proposal.command_id.clone(),
            expected_version: 3,
            answer: "known".into(),
        },
        Some(proposal),
    )
    .expect_err("fault");
    assert_eq!(error.code, "learningDatabaseUnavailable");
    let card_count: i64 = database
        .connection()
        .query_row("SELECT COUNT(*) FROM review_cards", [], |row| row.get(0))
        .expect("cards");
    let item: (String, i64) = database
        .connection()
        .query_row(
            "SELECT status,version FROM study_session_items WHERE item_id=?1",
            [&current.item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("item");
    assert_eq!(card_count, 0);
    assert_eq!(item, ("revealed".into(), 3));
}

#[test]
fn carries_an_uncommitted_revealed_card_across_the_learning_day() {
    let (_root, mut database) = database();
    let first = open_fixture(&mut database);
    let current = first.current.expect("current");
    stage_answer(
        &database,
        StudyStageAnswerRequest {
            session_id: first.session_id.clone(),
            item_id: current.item_id,
            expected_version: current.version,
            answer: "unknown".into(),
        },
    )
    .expect("stage");
    let now = "2026-07-13T02:00:00.000Z";
    let preparation = prepare_today_v2(&mut database, now).expect("prepare next");
    let next = open_today_v2(
        &mut database,
        moment(now, "2026-07-13", "2026-07-13T20:00:00.000Z"),
        queue_v2(&preparation, "2026-07-13"),
    )
    .expect("next");
    let carried = next.current.expect("carry");
    assert_eq!(carried.lexeme_key, "lex_en_bef0f93b22ad080a29e3aa86");
    assert!(carried.revealed);
    assert_eq!(carried.proposed_answer.as_deref(), Some("unknown"));
    let old: String = database
        .connection()
        .query_row(
            "SELECT status FROM study_sessions WHERE session_id=?1",
            [&first.session_id],
            |row| row.get(0),
        )
        .expect("old");
    assert_eq!(old, "rolled_over");
}

#[test]
fn manages_plans_sources_words_and_preferences_without_a_schema_change() {
    let (_root, mut database) = database();
    let plan = create_plan(
        &mut database,
        StudyPlanInput {
            name: "E3".into(),
            daily_new_limit: 5,
            daily_review_limit: 10,
            sources: vec![
                StudyPlanSourceInput {
                    source_type: "reader_manual".into(),
                    r#ref: "favorite".into(),
                },
                StudyPlanSourceInput {
                    source_type: "exam_collection".into(),
                    r#ref: "cet4".into(),
                },
            ],
        },
    )
    .expect("create");
    assert_eq!(plan.sources.len(), 2);
    let synced = sync_sources(&mut database, Some(&plan.plan_id)).expect("sync favorites");
    assert_eq!(synced.synced_sources, 1);
    let exam=database.connection().query_row("SELECT source_id FROM study_plan_sources WHERE plan_id=?1 AND source_type='exam_collection'",[&plan.plan_id],|r|r.get::<_,String>(0)).expect("exam");
    apply_source_snapshot(
        &mut database,
        StudySourceSnapshot {
            source_id: exam,
            version: "fixture-v1".into(),
            items: vec![StudySourceSnapshotItem {
                lexeme_key: "lex_en_bef0f93b22ad080a29e3aa86".into(),
                lemma: "run".into(),
                phonetic: Some("rʌn".into()),
                brief_meanings: vec!["跑；运行".into()],
                senses: Vec::new(),
                bnc: Some(100),
                frequency: Some(90),
            }],
        },
    )
    .expect("exam snapshot");
    let detail = get_plan(&database, &plan.plan_id).expect("detail");
    assert_eq!(detail.word_count, 1);
    assert_eq!(detail.sync_status, "ready");
    set_word_excluded(
        &mut database,
        &plan.plan_id,
        "lex_en_bef0f93b22ad080a29e3aa86",
        true,
    )
    .expect("exclude");
    let excluded = list_plan_words(
        &database,
        &plan.plan_id,
        StudyPlanWordQuery {
            text: String::new(),
            filter: "excluded".into(),
            offset: 0,
            limit: 50,
        },
    )
    .expect("words");
    assert_eq!(excluded.total, 1);
    set_word_excluded(
        &mut database,
        &plan.plan_id,
        "lex_en_bef0f93b22ad080a29e3aa86",
        false,
    )
    .expect("restore");
    set_word_suspended(&database, "lex_en_bef0f93b22ad080a29e3aa86", true).expect("suspend");
    let suspended = list_plan_words(
        &database,
        &plan.plan_id,
        StudyPlanWordQuery {
            text: "RUN".into(),
            filter: "suspended".into(),
            offset: 0,
            limit: 50,
        },
    )
    .expect("suspended");
    assert_eq!(suspended.total, 1);
    let preferences = save_preferences(
        &database,
        StudyPreferences {
            cutoff_hour: 3,
            request_retention: 0.92,
            maximum_interval: 1000,
            queue_order: "review_first".into(),
        },
    )
    .expect("save prefs");
    assert_eq!(
        get_preferences(&database).expect("prefs").queue_order,
        preferences.queue_order
    );
    set_plan_status(&mut database, &plan.plan_id, "paused").expect("pause");
    assert_eq!(
        get_plan(&database, &plan.plan_id).expect("paused").status,
        "paused"
    );
}

#[test]
fn accepts_known_then_unknown_correction_and_keeps_the_command_idempotent() {
    let (_root, mut database) = database();
    let session = open_fixture(&mut database);
    let current = session.current.expect("current");
    database
        .connection()
        .execute(
            "UPDATE study_session_items SET version=2 WHERE item_id=?1",
            [&current.item_id],
        )
        .expect("align");
    stage_answer(
        &database,
        StudyStageAnswerRequest {
            session_id: session.session_id.clone(),
            item_id: current.item_id.clone(),
            expected_version: 2,
            answer: "known".into(),
        },
    )
    .expect("stage known");
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("../../../test-vectors/d0-learning.json"))
            .expect("vector");
    let mut proposal: MobileReviewTransitionProposal =
        serde_json::from_value(vector["study"]["reviewProposal"].clone()).expect("proposal");
    proposal.answer = "unknown".into();
    proposal.rating = 1;
    let request = StudyAnswerRequest {
        session_id: session.session_id,
        item_id: current.item_id,
        command_id: proposal.command_id.clone(),
        expected_version: 3,
        answer: "unknown".into(),
    };
    let state = commit_answer(&mut database, request.clone(), Some(proposal)).expect("correct");
    assert!(state.current.expect("reinforcement").had_failure);
    let replay = commit_answer(&mut database, request, None).expect("replay");
    assert_eq!(replay.completed, 0);
}

#[test]
fn marks_too_easy_once_and_persists_the_global_suspension() {
    let (_root, mut database) = database();
    let session = open_fixture(&mut database);
    let item = session.current.expect("item");
    let command = Uuid::new_v4().to_string();
    let request = StudyTooEasyRequest {
        session_id: session.session_id,
        item_id: item.item_id.clone(),
        command_id: command,
        expected_version: item.version,
    };
    let completed = mark_too_easy(&mut database, request).expect("too easy");
    assert_eq!(completed.status, "completed");
    let active: i64 = database
        .connection()
        .query_row(
            "SELECT active FROM review_suspensions WHERE lexeme_key=?1",
            [item.lexeme_key],
            |r| r.get(0),
        )
        .expect("suspension");
    assert_eq!(active, 1);
}

#[test]
fn opens_and_commits_the_version_two_queue_and_scheduler_envelopes() {
    let (_root, mut database) = database();
    create_plan(&mut database, plan_input()).expect("plan");
    let now = "2026-07-12T02:00:00.000Z";
    let input = prepare_today_v2(&mut database, now).expect("planning input");
    let proposal = queue_v2(&input, "2026-07-12");
    let session = open_today_v2(
        &mut database,
        moment(now, "2026-07-12", "2026-07-12T20:00:00.000Z"),
        proposal,
    )
    .expect("open v2");
    let current = session.current.expect("current");
    database
        .connection()
        .execute(
            "UPDATE study_session_items SET version=2 WHERE item_id=?1",
            [&current.item_id],
        )
        .expect("align vector");
    stage_answer(
        &database,
        StudyStageAnswerRequest {
            session_id: session.session_id.clone(),
            item_id: current.item_id.clone(),
            expected_version: 2,
            answer: "known".into(),
        },
    )
    .expect("stage");
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("../../../test-vectors/d0-learning.json"))
            .expect("vector");
    let legacy: MobileReviewTransitionProposal =
        serde_json::from_value(vector["study"]["reviewProposal"].clone()).expect("legacy proposal");
    let parameters = serde_json::json!({
        "enable_fuzz": false,
        "maximum_interval": 36500,
        "request_retention": 0.9,
    });
    let parameters_fingerprint = hex::encode(Sha256::digest(
        canonical_json(&parameters)
            .expect("canonical parameters")
            .as_bytes(),
    ));
    let command_id = Uuid::new_v4().to_string();
    let request = StudyAnswerRequest {
        session_id: session.session_id,
        item_id: current.item_id,
        command_id: command_id.clone(),
        expected_version: 3,
        answer: "known".into(),
    };
    let state = commit_answer_v2(
        &mut database,
        request.clone(),
        Some(MobileReviewTransitionEnvelopeV2 {
            contract_version: 2,
            engine_version: "fsrs-6/ts-fsrs-5.4.1/mobile-v2".into(),
            expected_version: 3,
            command_id,
            answer: "known".into(),
            reviewed_at: legacy.reviewed_at,
            before_fingerprint: legacy.before_fingerprint,
            parameters_fingerprint: parameters_fingerprint.clone(),
            parameters,
            before: legacy.before,
            after: legacy.after,
            rating: legacy.rating,
            log: legacy.log,
            reinforcement: None,
        }),
    )
    .expect("commit v2");
    assert_eq!(state.status, "completed");
    assert_eq!(
        commit_answer_v2(&mut database, request, None)
            .expect("idempotent replay")
            .completed,
        1
    );
    let stored: (String, String) = database
        .connection()
        .query_row(
            "SELECT parameters_json,parameters_hash FROM scheduler_profiles",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("scheduler profile");
    assert_ne!(stored.0, "{}");
    assert_eq!(stored.1, parameters_fingerprint);
}

#[test]
fn developer_progress_controls_are_gated_and_transactional() {
    let (_root, mut database) = database();
    assert_eq!(
        reset_all_progress(&mut database, "RESET_ALL_STUDY_PROGRESS")
            .unwrap_err()
            .code,
        "featureDisabled"
    );
    assert!(
        set_developer_mode(&database, true)
            .expect("enable developer mode")
            .enabled
    );
    let session = open_fixture(&mut database);
    force_next_study_day(&database, "NEXT_STUDY_DAY").expect("force next day");
    let forced: i64 = database
        .connection()
        .query_row(
            "SELECT debug_forced FROM study_sessions WHERE session_id=?1",
            [&session.session_id],
            |row| row.get(0),
        )
        .expect("forced flag");
    assert_eq!(forced, 1);
    assert_eq!(
        reset_all_progress(&mut database, "wrong").unwrap_err().code,
        "invalidInput"
    );
    reset_all_progress(&mut database, "RESET_ALL_STUDY_PROGRESS").expect("reset progress");
    let session_count: i64 = database
        .connection()
        .query_row("SELECT COUNT(*) FROM study_sessions", [], |row| row.get(0))
        .expect("session count");
    let plan_count: i64 = database
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM study_plans WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .expect("plan count");
    assert_eq!(session_count, 0);
    assert_eq!(plan_count, 1);
    assert!(get_debug_state(&database)
        .expect("debug state")
        .last_reset_at
        .is_some());
}

#[test]
fn developer_plan_delete_requires_name_and_can_reset_related_words() {
    let (_root, mut database) = database();
    let session = open_fixture(&mut database);
    let plan = list_plans(&database, false).expect("plans").remove(0);
    set_word_suspended(&database, "lex_en_bef0f93b22ad080a29e3aa86", true).expect("suspend");
    set_developer_mode(&database, true).expect("developer mode");
    assert_eq!(
        delete_plan(&mut database, &plan.plan_id, "wrong", true)
            .unwrap_err()
            .code,
        "invalidInput"
    );
    delete_plan(&mut database, &plan.plan_id, &plan.name, true).expect("delete plan");
    assert!(get_plan(&database, &plan.plan_id).is_err());
    let reset_count: i64 = database
        .connection()
        .query_row("SELECT COUNT(*) FROM study_lexeme_resets", [], |row| {
            row.get(0)
        })
        .expect("reset count");
    let suspended_count: i64 = database
        .connection()
        .query_row("SELECT COUNT(*) FROM review_suspensions", [], |row| {
            row.get(0)
        })
        .expect("suspension count");
    let queued_count: i64 = database
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM study_session_items WHERE session_id=?1",
            [&session.session_id],
            |row| row.get(0),
        )
        .expect("queued count");
    assert_eq!(reset_count, 1);
    assert_eq!(suspended_count, 0);
    assert_eq!(queued_count, 0);
}
