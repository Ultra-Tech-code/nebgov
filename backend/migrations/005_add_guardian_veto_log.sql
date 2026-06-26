-- Up Migration

CREATE TABLE IF NOT EXISTS proposal_cancellations (
  id SERIAL PRIMARY KEY,
  proposal_id BIGINT NOT NULL,
  cancelled_at_ledger INT NOT NULL,
  caller TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposal_cancellations_ledger ON proposal_cancellations(cancelled_at_ledger DESC);
CREATE INDEX IF NOT EXISTS idx_proposal_cancellations_caller ON proposal_cancellations(caller);

-- Down Migration

DROP TABLE IF EXISTS proposal_cancellations;
