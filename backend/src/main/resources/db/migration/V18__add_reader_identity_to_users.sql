-- V5: reader accounts sign in with GitHub. The identity is github_id (immutable), not the login.
--
-- GitHub readers have neither an email nor a password: the blog does not store the GitHub email, and never links accounts by email.
-- The UNIQUE on email (V1) still stands: Postgres treats each NULL as distinct, so any number of readers without an email is fine.
--
-- status, github_*, last_login_at are only written by dedicated SQL statements (GitHub sign-in, temporary suspension), not through the entity:
-- User marks them updatable = false, so that saving an unrelated entity does not overwrite them with stale values.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN github_id BIGINT;
ALTER TABLE users ADD COLUMN github_login VARCHAR(100);
ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500);
ALTER TABLE users ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD CONSTRAINT uq_users_github_id UNIQUE (github_id);
ALTER TABLE users ADD CONSTRAINT chk_users_status CHECK (status IN ('ACTIVE', 'SUSPENDED'));
ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (role IN ('ADMIN', 'AUTHOR', 'USER'));
-- Every account must be able to sign in one way or another: GitHub, or email + password.
ALTER TABLE users ADD CONSTRAINT chk_users_has_credential
    CHECK (github_id IS NOT NULL OR (email IS NOT NULL AND password_hash IS NOT NULL));
