-- Up Migration

ALTER TABLE config_updates
  ADD COLUMN IF NOT EXISTS old_settings JSONB,
  ADD COLUMN IF NOT EXISTS ledger_closed_at TIMESTAMPTZ;

UPDATE config_updates
SET ledger_closed_at = created_at
WHERE ledger_closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_config_updates_closed_at
  ON config_updates(ledger_closed_at DESC);

-- Down Migration

DROP INDEX IF EXISTS idx_config_updates_closed_at;

ALTER TABLE config_updates
  DROP COLUMN IF EXISTS ledger_closed_at,
  DROP COLUMN IF EXISTS old_settings;
