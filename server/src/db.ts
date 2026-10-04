// SQLite database for Stragis, using better-sqlite3 + drizzle-orm.
//
// - DB file path: env STRAGIS_DB_PATH, default ./data/stragis.db
//   (Electron points STRAGIS_DB_PATH at <userData>/stragis.db).
// - Migrations: the SQL files in drizzle/ are applied at startup in the
//   order given by drizzle/meta/_journal.json. Applied tags are recorded
//   in a _stragis_migrations table so restarts are idempotent.

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

export type StragisDb = BetterSQLite3Database<typeof schema>;

function drizzleDir(): string {
  // Works from server/src (dev, unbundled) and from server/dist (bundled):
  // both are exactly two levels below the project root, which holds drizzle/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = path.resolve(here, "../../drizzle");
  if (fs.existsSync(path.join(fromModule, "meta/_journal.json"))) return fromModule;
  const fromCwd = path.resolve(process.cwd(), "drizzle");
  if (fs.existsSync(path.join(fromCwd, "meta/_journal.json"))) return fromCwd;
  // Packaged Electron: extraResources / app root relative to process.cwd() fallback.
  return fromModule;
}

function runMigrations(sqlite: Database.Database): void {
  const dir = drizzleDir();
  const journalPath = path.join(dir, "meta/_journal.json");
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Drizzle migrations not found (looked for ${journalPath})`);
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS _stragis_migrations (
       tag TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );
  const applied = new Set(
    (sqlite.prepare(`SELECT tag FROM _stragis_migrations`).all() as { tag: string }[]).map(
      (r) => r.tag,
    ),
  );
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  for (const entry of entries) {
    if (applied.has(entry.tag)) continue;
    const sqlPath = path.join(dir, `${entry.tag}.sql`);
    const raw = fs.readFileSync(sqlPath, "utf8");
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    const apply = sqlite.transaction(() => {
      for (const stmt of statements) sqlite.exec(stmt);
      sqlite
        .prepare(`INSERT INTO _stragis_migrations (tag, applied_at) VALUES (?, ?)`)
        .run(entry.tag, Date.now());
    });
    apply();
  }
}

export function createDb(dbPath?: string): { db: StragisDb; sqlite: Database.Database } {
  const resolved =
    dbPath ?? process.env.STRAGIS_DB_PATH ?? path.resolve(process.cwd(), "data/stragis.db");
  if (resolved !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(resolved)), { recursive: true });
  }
  const sqlite = new Database(resolved);
  sqlite.pragma("journal_mode = WAL");
  runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
