-- Add payment columns. Apply with:
--   wrangler d1 execute 30x30-subscribers --remote --file=migrations/0002_payments.sql

ALTER TABLE subscribers ADD COLUMN paid INTEGER DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN paid_at TEXT;
ALTER TABLE subscribers ADD COLUMN stripe_session_id TEXT;
ALTER TABLE subscribers ADD COLUMN signup_date TEXT;

CREATE INDEX IF NOT EXISTS idx_subscribers_session ON subscribers(stripe_session_id);
