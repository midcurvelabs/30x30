-- Plans table — stores generated 30-day plans with a shareable access token
-- Apply: wrangler d1 execute 30x30-subscribers --remote --file=migrations/0003_plans.sql

CREATE TABLE IF NOT EXISTS plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL,
  ideas_json      TEXT,
  plan_json       TEXT NOT NULL,
  token           TEXT NOT NULL UNIQUE,
  email_count     INTEGER NOT NULL DEFAULT 0,
  last_emailed_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plans_token ON plans(token);
CREATE INDEX IF NOT EXISTS idx_plans_email ON plans(email);
