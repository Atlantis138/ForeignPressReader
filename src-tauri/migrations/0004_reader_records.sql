CREATE TABLE reader_records (
  record_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('position','bookmark','read','translation','translation-selection')),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  updated_at TEXT NOT NULL,
  device_id TEXT NOT NULL
);
CREATE INDEX reader_records_article ON reader_records(article_id,kind);
CREATE INDEX reader_records_publication ON reader_records(publication_id,kind);
CREATE TRIGGER sync_track_reader_records_insert AFTER INSERT ON reader_records BEGIN
  UPDATE sync_clock SET current_revision=current_revision+1 WHERE singleton=1;
  INSERT INTO sync_entity_revisions(entity_type,entity_key,revision,changed_at)
  SELECT 'reader_records',NEW.record_id,current_revision,NEW.updated_at FROM sync_clock WHERE singleton=1
  ON CONFLICT(entity_type,entity_key) DO UPDATE SET revision=excluded.revision,changed_at=excluded.changed_at;
END;
CREATE TRIGGER sync_track_reader_records_update AFTER UPDATE ON reader_records BEGIN
  UPDATE sync_clock SET current_revision=current_revision+1 WHERE singleton=1;
  INSERT INTO sync_entity_revisions(entity_type,entity_key,revision,changed_at)
  SELECT 'reader_records',NEW.record_id,current_revision,NEW.updated_at FROM sync_clock WHERE singleton=1
  ON CONFLICT(entity_type,entity_key) DO UPDATE SET revision=excluded.revision,changed_at=excluded.changed_at;
END;
INSERT INTO reader_records(record_id,publication_id,article_id,kind,payload,updated_at,device_id)
SELECT 'position:'||article_id,publication_id,article_id,'position',
  json_object('scrollTop',scroll_top,'anchorBlockId',anchor_block_id,'anchorTokenIndex',anchor_token_index,'anchorFraction',coalesce(anchor_fraction,0)),updated_at,device_id
FROM reading_positions;

CREATE VIRTUAL TABLE reader_search USING fts5(text,content='blocks',content_rowid='rowid',tokenize='unicode61');
INSERT INTO reader_search(reader_search) VALUES('rebuild');
CREATE TRIGGER reader_search_insert AFTER INSERT ON blocks BEGIN
  INSERT INTO reader_search(rowid,text) VALUES(NEW.rowid,NEW.text);
END;
CREATE TRIGGER reader_search_delete AFTER DELETE ON blocks BEGIN
  INSERT INTO reader_search(reader_search,rowid,text) VALUES('delete',OLD.rowid,OLD.text);
END;
CREATE TRIGGER reader_search_update AFTER UPDATE OF text ON blocks BEGIN
  INSERT INTO reader_search(reader_search,rowid,text) VALUES('delete',OLD.rowid,OLD.text);
  INSERT INTO reader_search(rowid,text) VALUES(NEW.rowid,NEW.text);
END;

CREATE TRIGGER reader_position_insert AFTER INSERT ON reading_positions BEGIN
  INSERT INTO reader_records(record_id,publication_id,article_id,kind,payload,updated_at,device_id)
  VALUES('position:'||NEW.article_id,NEW.publication_id,NEW.article_id,'position',json_object('scrollTop',NEW.scroll_top,'anchorBlockId',NEW.anchor_block_id,'anchorTokenIndex',NEW.anchor_token_index,'anchorFraction',coalesce(NEW.anchor_fraction,0)),NEW.updated_at,NEW.device_id)
  ON CONFLICT(record_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,device_id=excluded.device_id
  WHERE excluded.updated_at>reader_records.updated_at OR (excluded.updated_at=reader_records.updated_at AND excluded.device_id>=reader_records.device_id);
END;

CREATE TRIGGER reader_position_update AFTER UPDATE ON reading_positions BEGIN
  INSERT INTO reader_records(record_id,publication_id,article_id,kind,payload,updated_at,device_id)
  VALUES('position:'||NEW.article_id,NEW.publication_id,NEW.article_id,'position',json_object('scrollTop',NEW.scroll_top,'anchorBlockId',NEW.anchor_block_id,'anchorTokenIndex',NEW.anchor_token_index,'anchorFraction',coalesce(NEW.anchor_fraction,0)),NEW.updated_at,NEW.device_id)
  ON CONFLICT(record_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,device_id=excluded.device_id
  WHERE excluded.updated_at>reader_records.updated_at OR (excluded.updated_at=reader_records.updated_at AND excluded.device_id>=reader_records.device_id);
END;

CREATE TRIGGER publication_digest_sections_insert BEFORE INSERT ON sections BEGIN
  DELETE FROM settings WHERE key='local.publication-digest.'||NEW.publication_id;
END;

CREATE TRIGGER publication_digest_sections_update BEFORE UPDATE ON sections BEGIN
  DELETE FROM settings WHERE key='local.publication-digest.'||NEW.publication_id;
END;

CREATE TRIGGER publication_digest_sections_delete BEFORE DELETE ON sections BEGIN
  DELETE FROM settings WHERE key='local.publication-digest.'||OLD.publication_id;
END;

CREATE TRIGGER publication_digest_articles_insert BEFORE INSERT ON articles BEGIN
  DELETE FROM settings WHERE key='local.publication-digest.'||NEW.publication_id;
END;

CREATE TRIGGER publication_digest_articles_update BEFORE UPDATE ON articles BEGIN
  DELETE FROM settings WHERE key='local.publication-digest.'||NEW.publication_id;
END;

CREATE TRIGGER publication_digest_articles_delete BEFORE DELETE ON articles BEGIN
  DELETE FROM settings WHERE key='local.publication-digest.'||OLD.publication_id;
END;

CREATE TRIGGER publication_digest_blocks_insert BEFORE INSERT ON blocks BEGIN
  DELETE FROM settings WHERE key='local.publication-digest.'||(SELECT publication_id FROM articles WHERE id=NEW.article_id);
END;

CREATE TRIGGER publication_digest_blocks_update BEFORE UPDATE ON blocks BEGIN
  DELETE FROM settings WHERE key='local.publication-digest.'||(SELECT publication_id FROM articles WHERE id=NEW.article_id);
END;

CREATE TRIGGER publication_digest_blocks_delete BEFORE DELETE ON blocks BEGIN
  DELETE FROM settings WHERE key='local.publication-digest.'||(SELECT publication_id FROM articles WHERE id=OLD.article_id);
END;
