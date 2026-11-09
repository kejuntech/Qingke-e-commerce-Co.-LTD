-- KEJUN V18 staged JSON-to-PostgreSQL migration table.
-- This preserves existing JSON records losslessly while a later release moves
-- each runtime API to PostgreSQL-backed repositories.
CREATE TABLE IF NOT EXISTS kejun_json_records (
  collection TEXT NOT NULL,
  record_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, record_key)
);
CREATE INDEX IF NOT EXISTS idx_kejun_json_records_collection ON kejun_json_records(collection);

-- Per-run manifest for auditable, repeatable migrations.
CREATE TABLE IF NOT EXISTS kejun_migration_runs (
  run_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_dir TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  manifest JSONB NOT NULL,
  applied BOOLEAN NOT NULL DEFAULT FALSE
);
ALTER TABLE kejun_json_records ADD COLUMN IF NOT EXISTS payload_sha256 TEXT;

ALTER TABLE kejun_json_records ADD COLUMN IF NOT EXISTS ordinal INTEGER NOT NULL DEFAULT 0;
