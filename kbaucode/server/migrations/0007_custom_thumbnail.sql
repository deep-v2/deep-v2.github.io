-- 1 when the owner uploaded their own thumbnail; editor saves then leave it alone.
ALTER TABLE projects ADD COLUMN custom_thumbnail INTEGER NOT NULL DEFAULT 0;
