-- Comment upvotes and downvotes: one vote (+1 or -1) per person per comment; comments.score is the total.
CREATE TABLE comment_votes (
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value INTEGER NOT NULL CHECK (value IN (-1, 1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX comment_votes_user ON comment_votes(user_id);
ALTER TABLE comments ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
