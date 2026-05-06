-- Initial schema for 30x30-subscribers (already created on remote — kept here for repro)
-- Apply only if running against a fresh DB.

CREATE TABLE IF NOT EXISTS subscribers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT,
  email        TEXT NOT NULL UNIQUE,
  background   TEXT,
  formats      TEXT,
  time_per_day TEXT,
  tools        TEXT,
  goal         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
