// KbauBlocks database layer (SQLite via node:sqlite, no external dependencies).
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
    // 1: initial schema
    `
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL DEFAULT '',
        email TEXT,
        password_hash TEXT NOT NULL,
        bio TEXT NOT NULL DEFAULT '',
        working_on TEXT NOT NULL DEFAULT '',
        profile_color TEXT NOT NULL DEFAULT '#1fd1a0',
        has_avatar INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL DEFAULT 'user', -- user | moderator | admin
        banned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'Untitled',
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        shared INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0, -- hidden by moderation
        deleted INTEGER NOT NULL DEFAULT 0,
        remix_of INTEGER REFERENCES projects(id),
        current_version INTEGER NOT NULL DEFAULT 0,
        has_thumbnail INTEGER NOT NULL DEFAULT 0,
        view_count INTEGER NOT NULL DEFAULT 0,
        love_count INTEGER NOT NULL DEFAULT 0,
        favorite_count INTEGER NOT NULL DEFAULT 0,
        remix_count INTEGER NOT NULL DEFAULT 0,
        comment_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        shared_at INTEGER
    );
    CREATE INDEX projects_owner ON projects(owner_id);
    CREATE INDEX projects_shared ON projects(shared, hidden, deleted, shared_at);
    CREATE INDEX projects_remix ON projects(remix_of);
    CREATE TABLE project_versions (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, version)
    );
    CREATE TABLE loves (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, project_id)
    );
    CREATE TABLE favorites (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, project_id)
    );
    CREATE TABLE views (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        viewer_key TEXT NOT NULL,
        day INTEGER NOT NULL,
        PRIMARY KEY (project_id, viewer_key, day)
    );
    CREATE TABLE comments (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX comments_project ON comments(project_id, created_at);
    CREATE TABLE collections (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE collection_projects (
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        added_by INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (collection_id, project_id)
    );
    CREATE TABLE reports (
        id INTEGER PRIMARY KEY,
        reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL, -- project | comment | user
        target_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', -- open | resolved | dismissed
        resolved_by INTEGER REFERENCES users(id),
        resolution_note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
    );
    CREATE TABLE cloud_variables (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, name)
    );
    `
];

export const openDatabase = dataDir => {
    fs.mkdirSync(dataDir, {recursive: true});
    const db = new DatabaseSync(path.join(dataDir, 'kbaublocks.sqlite'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    for (let i = version; i < MIGRATIONS.length; i++) {
        db.exec('BEGIN');
        try {
            db.exec(MIGRATIONS[i]);
            db.exec(`PRAGMA user_version = ${i + 1}`);
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
    return db;
};

export const transaction = (db, fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
};
