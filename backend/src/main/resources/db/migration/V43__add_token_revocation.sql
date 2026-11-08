-- JWT revocation: an access token is rejected when it was issued before the account's tokens_valid_after, or when the
-- refresh-token session it is bound to (the sid claim) has no live refresh token left.
ALTER TABLE users ADD COLUMN tokens_valid_after TIMESTAMPTZ;

-- A session survives refresh-token rotation: every rotated token carries the session_id of the token it replaces.
-- Existing rows become sessions of their own.
ALTER TABLE refresh_tokens ADD COLUMN session_id UUID;
UPDATE refresh_tokens SET session_id = id;
ALTER TABLE refresh_tokens ALTER COLUMN session_id SET NOT NULL;
ALTER TABLE refresh_tokens ALTER COLUMN session_id SET DEFAULT gen_random_uuid();

-- The per-request liveness lookup of an access token: a partial index, so it only holds the live tokens.
CREATE INDEX idx_refresh_tokens_live_session ON refresh_tokens (session_id) WHERE revoked_at IS NULL;
