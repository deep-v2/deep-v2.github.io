// Node database adapter: node:sqlite with the shared migrations/ folder.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const clean = params => params.map(p => (p === undefined ? null : p));

export const openDatabase = (dataDir, migrationsDir) => {
    fs.mkdirSync(dataDir, {recursive: true});
    const sqlite = new DatabaseSync(path.join(dataDir, 'kbaublocks.sqlite'));
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    // Same bookkeeping table name/shape as `wrangler d1 migrations`, so both backends track migrations alike.
    sqlite.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
    const applied = new Set(sqlite.prepare('SELECT name FROM d1_migrations').all().map(r => r.name));
    for (const name of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
        if (applied.has(name)) continue;
        sqlite.exec('BEGIN');
        try {
            sqlite.exec(fs.readFileSync(path.join(migrationsDir, name), 'utf8'));
            sqlite.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
            sqlite.exec('COMMIT');
            console.log(`Applied migration ${name}`);
        } catch (e) {
            sqlite.exec('ROLLBACK');
            throw e;
        }
    }
    const cache = new Map();
    const stmt = sql => {
        let s = cache.get(sql);
        if (!s) {
            s = sqlite.prepare(sql);
            cache.set(sql, s);
        }
        return s;
    };
    return {
        sqlite,
        get: async (sql, ...params) => stmt(sql).get(...clean(params)) ?? null,
        all: async (sql, ...params) => stmt(sql).all(...clean(params)),
        run: async (sql, ...params) => {
            const r = stmt(sql).run(...clean(params));
            return {changes: Number(r.changes), lastId: Number(r.lastInsertRowid)};
        },
        close: () => sqlite.close()
    };
};
