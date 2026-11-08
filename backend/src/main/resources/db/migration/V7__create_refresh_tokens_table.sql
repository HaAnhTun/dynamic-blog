CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 hex of the raw token, not Argon2id. The raw token is 256 bits of
    -- SecureRandom, so guessing is not the threat and Argon2's deliberate slowness would
    -- be paid on every refresh for nothing. users.password_hash stays Argon2id, where the
    -- input is human-chosen and guessing IS the threat.
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens (user_id);
