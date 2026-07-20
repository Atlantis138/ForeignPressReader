ALTER TABLE publications ADD COLUMN source_storage TEXT NOT NULL DEFAULT 'retained'
  CHECK(source_storage IN ('retained','parsed-only'));
