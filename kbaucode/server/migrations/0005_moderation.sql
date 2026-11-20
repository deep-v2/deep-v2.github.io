-- Moderation: ban reasons, IP addresses on accounts (admins only), IP bans, an activity log
-- and an admin-editable list of extra blocked words.
ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN banned_at INTEGER;
ALTER TABLE users ADD COLUMN banned_by TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN signup_ip TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_ip TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_login_at INTEGER;
CREATE INDEX users_signup_ip ON users(signup_ip);
CREATE INDEX users_last_ip ON users(last_ip);
CREATE INDEX users_created ON users(created_at);

-- Who did what, when. Names are copied so entries stay readable after an account is deleted.
CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_id INTEGER,
    actor_name TEXT NOT NULL DEFAULT '',
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX activity_log_time ON activity_log(created_at);
CREATE INDEX activity_log_action ON activity_log(action, created_at);

-- An exact address ("203.0.113.7") or a prefix ending in "*" ("203.0.113.*", "2001:db8:1:2:*").
CREATE TABLE ip_bans (
    id INTEGER PRIMARY KEY,
    pattern TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE TABLE blocked_words (
    word TEXT PRIMARY KEY,
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

-- A project's owner can pin one comment to the top.
ALTER TABLE comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
