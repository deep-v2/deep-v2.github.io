-- Profile banner image. Like has_avatar it counts uploads (used as a cache-busting version);
-- a negative value means the user removed it (keeps the counter so old cached URLs aren't reused).
ALTER TABLE users ADD COLUMN has_banner INTEGER NOT NULL DEFAULT 0;
