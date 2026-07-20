CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE migration_history (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, app_version TEXT NOT NULL
      );
      CREATE TABLE publications (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, source_key TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL, title TEXT NOT NULL, creator TEXT, language TEXT,
        cover_path TEXT, source_path TEXT NOT NULL, imported_at TEXT NOT NULL,
        article_count INTEGER NOT NULL, section_count INTEGER NOT NULL
      );
      CREATE TABLE sections (
        id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
        source_key TEXT NOT NULL, title TEXT NOT NULL, position INTEGER NOT NULL,
        UNIQUE(publication_id, source_key)
      );
      CREATE TABLE articles (
        id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
        section_id TEXT REFERENCES sections(id) ON DELETE SET NULL, source_key TEXT NOT NULL,
        title TEXT NOT NULL, rubric TEXT, published_at TEXT, position INTEGER NOT NULL, source_href TEXT NOT NULL,
        UNIQUE(publication_id, source_key)
      );
      CREATE TABLE blocks (
        id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        source_key TEXT NOT NULL, type TEXT NOT NULL, position INTEGER NOT NULL,
        text TEXT, html TEXT, asset_path TEXT, alt TEXT,
        UNIQUE(article_id, source_key)
      );
      CREATE TABLE translations (
        block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE, source_hash TEXT NOT NULL,
        target_language TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (block_id, source_hash, target_language, model, prompt_version)
      );
      CREATE TABLE reading_positions (
        publication_id TEXT PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        scroll_top REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
        anchor_block_id TEXT,
        anchor_token_index INTEGER CHECK(anchor_token_index IS NULL OR anchor_token_index>=0),
        anchor_fraction REAL CHECK(anchor_fraction IS NULL OR (anchor_fraction>=0 AND anchor_fraction<=1))
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT NOT NULL
      );
      CREATE TABLE context_definitions (
        cache_key TEXT PRIMARY KEY, lexeme_key TEXT NOT NULL, word TEXT NOT NULL, lemma TEXT NOT NULL,
        article_id TEXT REFERENCES articles(id) ON DELETE SET NULL, block_id TEXT, sentence_hash TEXT NOT NULL,
        dictionary_version TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
        result_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE user_lexemes (
        lexeme_key TEXT PRIMARY KEY, lemma_snapshot TEXT NOT NULL, phonetic_snapshot TEXT,
        brief_meanings_json TEXT NOT NULL, sense_groups_json TEXT NOT NULL DEFAULT '[]',
        bnc_rank INTEGER, frequency_rank INTEGER,
        manual_state TEXT NOT NULL DEFAULT 'unrated' CHECK(manual_state IN ('unrated','learning','known','ignored')),
        manual_familiarity INTEGER CHECK(manual_familiarity IS NULL OR manual_familiarity BETWEEN 0 AND 5),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
        snapshot_provider TEXT NOT NULL DEFAULT 'ecdict',
        snapshot_quality INTEGER NOT NULL DEFAULT 10
      );
      CREATE TABLE vocabulary_sources (
        source_id TEXT PRIMARY KEY, lexeme_key TEXT NOT NULL REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        source_type TEXT NOT NULL, source_ref TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
        added_at TEXT NOT NULL, removed_at TEXT, updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
        UNIQUE(lexeme_key, source_type, source_ref)
      );
      CREATE TABLE saved_contexts (
        context_id TEXT PRIMARY KEY, lexeme_key TEXT NOT NULL REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        surface TEXT NOT NULL, publication_id TEXT REFERENCES publications(id) ON DELETE SET NULL,
        publication_title_snapshot TEXT NOT NULL, article_id TEXT REFERENCES articles(id) ON DELETE SET NULL,
        article_title_snapshot TEXT NOT NULL, block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
        token_index INTEGER NOT NULL CHECK(token_index>=0), sentence_snapshot TEXT NOT NULL,
        paragraph_snapshot TEXT NOT NULL, sentence_hash TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1)), saved_at TEXT NOT NULL, removed_at TEXT,
        updated_at TEXT NOT NULL, device_id TEXT NOT NULL
      );
      CREATE TABLE study_plans (
        plan_id TEXT PRIMARY KEY, name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
        daily_new_limit INTEGER NOT NULL CHECK(daily_new_limit BETWEEN 0 AND 500),
        daily_review_limit INTEGER NOT NULL CHECK(daily_review_limit BETWEEN 1 AND 2000),
        new_order TEXT NOT NULL CHECK(new_order IN ('reader_first_frequency','deterministic_random')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT
      );
      CREATE UNIQUE INDEX idx_study_plan_name ON study_plans(lower(name)) WHERE status!='archived';
      CREATE TABLE study_plan_sources (
        source_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES study_plans(plan_id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK(source_type IN ('reader_manual','exam_collection')),
        source_ref TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
        added_at TEXT NOT NULL, removed_at TEXT, updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','syncing','ready','error')),
        sync_version TEXT, member_count INTEGER NOT NULL DEFAULT 0, last_synced_at TEXT, sync_error TEXT,
        UNIQUE(plan_id, source_type, source_ref)
      );
      CREATE TABLE study_plan_lexeme_origins (
        origin_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES study_plans(plan_id) ON DELETE CASCADE,
        plan_source_id TEXT NOT NULL REFERENCES study_plan_sources(source_id) ON DELETE CASCADE,
        lexeme_key TEXT NOT NULL REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        active INTEGER NOT NULL CHECK(active IN (0,1)), discovered_at TEXT NOT NULL, removed_at TEXT,
        updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
        UNIQUE(plan_source_id, lexeme_key)
      );
      CREATE TABLE study_plan_exclusions (
        plan_id TEXT NOT NULL REFERENCES study_plans(plan_id) ON DELETE CASCADE,
        lexeme_key TEXT NOT NULL REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        excluded INTEGER NOT NULL CHECK(excluded IN (0,1)), excluded_at TEXT, restored_at TEXT,
        updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
        PRIMARY KEY(plan_id, lexeme_key)
      );
      CREATE TABLE scheduler_profiles (
        profile_id TEXT PRIMARY KEY, fsrs_version TEXT NOT NULL, parameters_json TEXT NOT NULL,
        parameters_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE review_cards (
        lexeme_key TEXT PRIMARY KEY REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        due_at TEXT NOT NULL, stability REAL NOT NULL, difficulty REAL NOT NULL,
        elapsed_days INTEGER NOT NULL, scheduled_days INTEGER NOT NULL, learning_steps INTEGER NOT NULL,
        reps INTEGER NOT NULL, lapses INTEGER NOT NULL, state INTEGER NOT NULL CHECK(state BETWEEN 0 AND 3),
        last_review_at TEXT, updated_at TEXT NOT NULL, device_id TEXT NOT NULL
      );
      CREATE TABLE study_sessions (
        session_id TEXT PRIMARY KEY, day_sequence INTEGER NOT NULL UNIQUE, logical_date TEXT NOT NULL,
        timezone TEXT NOT NULL, cutoff_hour INTEGER NOT NULL, next_rollover_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','completed','rolled_over')),
        extra_batch_count INTEGER NOT NULL DEFAULT 0, opened_at TEXT NOT NULL, completed_at TEXT,
        updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
        debug_forced INTEGER NOT NULL DEFAULT 0 CHECK(debug_forced IN (0,1))
      );
      CREATE TABLE study_session_batches (
        batch_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES study_sessions(session_id) ON DELETE CASCADE,
        plan_id TEXT REFERENCES study_plans(plan_id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK(kind IN ('regular','extra','carryover','deferred_new')),
        new_limit INTEGER NOT NULL, review_limit INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE study_session_items (
        item_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES study_sessions(session_id) ON DELETE CASCADE,
        batch_id TEXT REFERENCES study_session_batches(batch_id) ON DELETE SET NULL,
        lexeme_key TEXT NOT NULL REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        plan_id TEXT REFERENCES study_plans(plan_id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK(kind IN ('new','review','carryover')),
        queue_position INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','revealed','completed','carried')),
        had_failure INTEGER NOT NULL DEFAULT 0 CHECK(had_failure IN (0,1)),
        consecutive_known INTEGER NOT NULL DEFAULT 0, attempt_count INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1, carried_from_item_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        proposed_answer TEXT CHECK(proposed_answer IN ('known','unknown')),
        fsrs_committed INTEGER NOT NULL DEFAULT 0 CHECK(fsrs_committed IN (0,1)),
        UNIQUE(session_id, lexeme_key)
      );
      CREATE TABLE review_events (
        event_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,
        lexeme_key TEXT NOT NULL REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        session_id TEXT REFERENCES study_sessions(session_id) ON DELETE SET NULL,
        session_item_id TEXT, plan_id TEXT REFERENCES study_plans(plan_id) ON DELETE SET NULL,
        answer TEXT NOT NULL CHECK(answer IN ('known','unknown')), rating INTEGER NOT NULL CHECK(rating IN (1,3)),
        profile_id TEXT NOT NULL REFERENCES scheduler_profiles(profile_id),
        pre_card_json TEXT NOT NULL, post_card_json TEXT NOT NULL, log_json TEXT NOT NULL,
        reviewed_at TEXT NOT NULL, device_id TEXT NOT NULL
      );
      CREATE TABLE reinforcement_events (
        event_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,
        lexeme_key TEXT NOT NULL REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        session_id TEXT REFERENCES study_sessions(session_id) ON DELETE SET NULL,
        session_item_id TEXT, plan_id TEXT REFERENCES study_plans(plan_id) ON DELETE SET NULL,
        answer TEXT NOT NULL CHECK(answer IN ('known','unknown','too_easy')),
        consecutive_before INTEGER NOT NULL, consecutive_after INTEGER NOT NULL,
        created_at TEXT NOT NULL, device_id TEXT NOT NULL
      );
      CREATE TABLE review_suspensions (
        lexeme_key TEXT PRIMARY KEY REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        active INTEGER NOT NULL CHECK(active IN (0,1)), reason TEXT NOT NULL,
        suspended_at TEXT NOT NULL, restored_at TEXT, updated_at TEXT NOT NULL, device_id TEXT NOT NULL
      );
      CREATE TABLE study_progress_state (
        state_id TEXT PRIMARY KEY CHECK(state_id='global'), reset_at TEXT,
        updated_at TEXT NOT NULL, device_id TEXT NOT NULL
      );
      CREATE TABLE publication_lifecycle (
        publication_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL UNIQUE,
        format_id TEXT NOT NULL,
        title_snapshot TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('present','deleted')),
        changed_at TEXT NOT NULL,
        device_id TEXT NOT NULL
      );
      CREATE TABLE study_lexeme_resets (
        lexeme_key TEXT PRIMARY KEY, source_plan_id TEXT, reset_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, device_id TEXT NOT NULL
      );
      CREATE TABLE sync_clock (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        current_revision INTEGER NOT NULL DEFAULT 0 CHECK(current_revision>=0)
      );
      INSERT INTO sync_clock (singleton,current_revision) VALUES (1,0);
      CREATE TABLE sync_entity_revisions (
        entity_type TEXT NOT NULL, entity_key TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0), changed_at TEXT NOT NULL,
        PRIMARY KEY(entity_type,entity_key)
      );
      CREATE TABLE sync_peer_state (
        peer_device_id TEXT PRIMARY KEY,
        outbound_acked_revision INTEGER NOT NULL DEFAULT 0 CHECK(outbound_acked_revision>=0),
        inbound_applied_revision INTEGER NOT NULL DEFAULT 0 CHECK(inbound_applied_revision>=0),
        peer_inspected_revision INTEGER NOT NULL DEFAULT 0 CHECK(peer_inspected_revision>=0),
        last_sync_at TEXT
      );
      CREATE TABLE sync_receipts (
        sender_device_id TEXT NOT NULL, batch_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
        sender_through_revision INTEGER NOT NULL CHECK(sender_through_revision>=0),
        applied_at TEXT NOT NULL,
        PRIMARY KEY(sender_device_id,batch_id)
      );
      CREATE TABLE lexeme_examples (
        example_id TEXT PRIMARY KEY,
        lexeme_key TEXT NOT NULL REFERENCES user_lexemes(lexeme_key) ON DELETE CASCADE,
        text TEXT NOT NULL, translation_zh TEXT, part_of_speech TEXT, definition TEXT,
        provider_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
        UNIQUE(lexeme_key, position)
      );

      CREATE INDEX idx_sections_publication ON sections(publication_id, position);
      CREATE INDEX idx_articles_publication ON articles(publication_id, position);
      CREATE INDEX idx_blocks_article ON blocks(article_id, position);
      CREATE INDEX idx_context_definitions_block ON context_definitions(block_id);
      CREATE INDEX idx_vocabulary_sources_active ON vocabulary_sources(source_type, active, added_at DESC);
      CREATE INDEX idx_saved_contexts_lexeme ON saved_contexts(lexeme_key, active, saved_at DESC);
      CREATE INDEX idx_plan_sources ON study_plan_sources(plan_id, active);
      CREATE INDEX idx_plan_origins ON study_plan_lexeme_origins(plan_id, lexeme_key, active);
      CREATE INDEX idx_review_cards_due ON review_cards(due_at, state);
      CREATE INDEX idx_session_items_queue ON study_session_items(session_id, status, queue_position);
      CREATE INDEX idx_review_events_lexeme ON review_events(lexeme_key, reviewed_at);
      CREATE INDEX idx_reinforcement_events_session ON reinforcement_events(session_id,created_at);
      CREATE INDEX idx_review_suspensions_active ON review_suspensions(active,lexeme_key);
      CREATE INDEX idx_plan_sources_sync ON study_plan_sources(sync_status,active);
      CREATE INDEX idx_sync_entity_revisions_revision ON sync_entity_revisions(revision);
      CREATE INDEX idx_lexeme_examples_key ON lexeme_examples(lexeme_key, position);
