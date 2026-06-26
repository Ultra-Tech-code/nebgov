-- Up Migration

CREATE TABLE webhook_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callback_url TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  event_filter TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE webhook_delivery_log (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_webhook_subscriptions_user ON webhook_subscriptions(user_id);
CREATE INDEX idx_webhook_delivery_log_webhook ON webhook_delivery_log(webhook_id);
CREATE INDEX idx_webhook_delivery_log_retry ON webhook_delivery_log(next_retry_at) WHERE status = 'pending';

-- Down Migration

DROP TABLE IF EXISTS webhook_delivery_log;
DROP TABLE IF EXISTS webhook_subscriptions;
