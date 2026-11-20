-- Follows (two people following each other are "friends") and the verified tick.
CREATE TABLE follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX follows_followee ON follows(followee_id, created_at);
CREATE INDEX follows_follower ON follows(follower_id, created_at);

-- Set by admins for well-known creators; staff (admins/moderators) show the tick automatically.
ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
