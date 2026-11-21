-- Direct messages, message requests, pinned chats, blocking and private nicknames.

-- How many messages someone who isn't your friend may send before you accept their request (0 = friends only).
ALTER TABLE users ADD COLUMN dm_request_limit INTEGER NOT NULL DEFAULT 3;

CREATE TABLE blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked ON blocks(blocked_id);

-- Nicknames you give your friends. Only you see them.
CREATE TABLE nicknames (
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, target_id)
);

-- One conversation per pair of users (user_a < user_b).
-- status: 'request' (waiting for the other person), 'accepted', or 'declined'.
CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'request',
    requester_id INTEGER,
    created_at INTEGER NOT NULL,
    last_message_id INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_a, user_b)
);

-- Per-person state: pinned, read position, and "deleted the chat for me" (cleared_id).
CREATE TABLE conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pinned_at INTEGER,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    cleared_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members(user_id);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_conversation ON messages(conversation_id, id);
