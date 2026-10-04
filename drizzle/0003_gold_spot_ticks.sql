CREATE TABLE gold_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  bid REAL NOT NULL,
  ask REAL NOT NULL,
  mid REAL NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_gold_ticks_ts ON gold_ticks (ts);
