import Database from "better-sqlite3";

const db = new Database("bets.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  commence_time_utc TEXT NOT NULL,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  selection TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'h2h',
  fair_odds REAL,
  soft_odds REAL,
  ev_pct REAL,
  best_book TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming',
  score_home INTEGER,
  score_away INTEGER,
  sharp_sources TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_event ON picks(event_id);
CREATE INDEX IF NOT EXISTS idx_status ON picks(status);
`);

export default db;
