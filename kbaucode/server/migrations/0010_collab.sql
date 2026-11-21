-- Live collaboration: people the owner invited to edit a project with them.
CREATE TABLE project_collaborators (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_collaborators_user ON project_collaborators(user_id, created_at);

-- Assets in the shared collaboration store (assets/<md5ext> in blob storage), so "which are missing?" is one query.
CREATE TABLE collab_assets (
    md5ext TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
