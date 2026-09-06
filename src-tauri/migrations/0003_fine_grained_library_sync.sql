DROP TRIGGER sync_track_settings_insert;
DROP TRIGGER sync_track_settings_update;

CREATE TRIGGER sync_track_settings_insert
AFTER INSERT ON settings
WHEN NEW.key IN ('reader.preferences','dictionary.preferences','study.preferences','speech.preferences','translation.preferences')
  OR NEW.key LIKE 'library.category.%' OR NEW.key LIKE 'library.item.%'
BEGIN
  UPDATE sync_clock SET current_revision=current_revision+1 WHERE singleton=1;
  INSERT INTO sync_entity_revisions (entity_type,entity_key,revision,changed_at)
  SELECT 'settings',NEW.key,current_revision,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM sync_clock WHERE singleton=1
  ON CONFLICT(entity_type,entity_key) DO UPDATE SET
    revision=excluded.revision,changed_at=excluded.changed_at;
END;

CREATE TRIGGER sync_track_settings_update
AFTER UPDATE ON settings
WHEN NEW.key IN ('reader.preferences','dictionary.preferences','study.preferences','speech.preferences','translation.preferences')
  OR NEW.key LIKE 'library.category.%' OR NEW.key LIKE 'library.item.%'
BEGIN
  UPDATE sync_clock SET current_revision=current_revision+1 WHERE singleton=1;
  INSERT INTO sync_entity_revisions (entity_type,entity_key,revision,changed_at)
  SELECT 'settings',NEW.key,current_revision,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM sync_clock WHERE singleton=1
  ON CONFLICT(entity_type,entity_key) DO UPDATE SET
    revision=excluded.revision,changed_at=excluded.changed_at;
END;

INSERT INTO settings(key,value,updated_at,device_id)
SELECT 'library.category.'||json_extract(category.value,'$.id'),
  json_object(
    'id',json_extract(category.value,'$.id'),
    'name',trim(json_extract(category.value,'$.name')),
    'createdAt',COALESCE(json_extract(category.value,'$.createdAt'),'1970-01-01T00:00:00.000Z'),
    'state','present','deletedAt',NULL
  ), management.updated_at,management.device_id
FROM settings AS management,
  json_each(CASE WHEN json_valid(management.value) THEN management.value ELSE '{}' END,'$.categories') AS category
WHERE management.key='library.management'
  AND json_type(category.value)='object'
  AND length(json_extract(category.value,'$.id'))=41
  AND substr(json_extract(category.value,'$.id'),1,9)='category_'
  AND substr(json_extract(category.value,'$.id'),10) NOT GLOB '*[^0-9a-f]*'
  AND length(trim(COALESCE(json_extract(category.value,'$.name'),'')))>0
ON CONFLICT(key) DO NOTHING;

INSERT INTO settings(key,value,updated_at,device_id)
SELECT 'library.item.'||item.key,
  json_object(
    'publicationId',item.key,
    'customTitle',json_extract(item.value,'$.customTitle'),
    'categoryId',json_extract(item.value,'$.categoryId'),
    'state','present','deletedAt',NULL
  ), management.updated_at,management.device_id
FROM settings AS management,
  json_each(CASE WHEN json_valid(management.value) THEN management.value ELSE '{}' END,'$.items') AS item
WHERE management.key='library.management'
  AND json_type(item.value)='object'
  AND length(item.key) BETWEEN 8 AND 80
  AND item.key NOT GLOB '*[^A-Za-z0-9_-]*'
  AND (json_extract(item.value,'$.customTitle') IS NOT NULL
    OR json_extract(item.value,'$.categoryId') IS NOT NULL)
ON CONFLICT(key) DO NOTHING;

DELETE FROM sync_entity_revisions
WHERE entity_type='settings' AND entity_key='library.management';
