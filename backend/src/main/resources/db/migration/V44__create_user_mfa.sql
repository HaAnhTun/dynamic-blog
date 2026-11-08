-- Two-step verification (TOTP) for ADMIN and AUTHOR accounts: the enrollment, the recovery codes, the short-lived sign-in
-- challenge, and the proof a session carries.

-- One row per enrolled (or enrolling) account. The TOTP secret is encrypted with MFA_ENCRYPTION_KEY (AES-256-GCM, MfaSecretCipher);
-- key_id is a non-secret fingerprint of that key, stored from day one so a later key rotation needs no further migration.
CREATE TABLE user_mfa (
    user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status                VARCHAR(16)  NOT NULL CHECK (status IN ('PENDING', 'ACTIVE')),
    secret_cipher         BYTEA        NOT NULL,           -- iv(12) || AES-256-GCM ciphertext+tag
    key_id                SMALLINT     NOT NULL,           -- fingerprint of the encryption key
    pending_secret_cipher BYTEA,                           -- a replacement secret waiting for its first code
    pending_key_id        SMALLINT,
    last_used_step        BIGINT       NOT NULL DEFAULT 0, -- replay guard: the 30 s step of the last accepted code
    failed_attempts       INTEGER      NOT NULL DEFAULT 0, -- consecutive wrong second-step codes
    locked_until          TIMESTAMPTZ,
    confirmed_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT chk_user_mfa_pending CHECK ((pending_secret_cipher IS NULL) = (pending_key_id IS NULL))
);

-- Single-use recovery codes. Only the SHA-256 hex of the normalised 24-character code is stored (120 bits of entropy, so a plain
-- hash is enough; ASVS 5.0 6.5.2).
CREATE TABLE user_mfa_recovery_code (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  VARCHAR(64) NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_recovery_code UNIQUE (user_id, code_hash)
);
CREATE INDEX idx_recovery_code_user ON user_mfa_recovery_code (user_id);

-- The step between the first factor and the session: single use, an attempt counter that survives a restart, instant
-- invalidation. The raw challenge is 256 bits of SecureRandom; only its SHA-256 is stored.
CREATE TABLE mfa_challenge (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash    VARCHAR(64) NOT NULL UNIQUE,
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose       VARCHAR(8)  NOT NULL CHECK (purpose IN ('VERIFY', 'ENROLL')),
    first_factor  VARCHAR(8)  NOT NULL CHECK (first_factor IN ('PASSWORD', 'GITHUB')),
    attempts      INTEGER     NOT NULL DEFAULT 0,
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL            -- written by the application from the Clock, never by a default: it is compared with users.tokens_valid_after
);
CREATE INDEX idx_mfa_challenge_user ON mfa_challenge (user_id);

-- While in the future, the account may start its two-step enrollment without the operator's enrollment code (the first-run setup
-- opens it for an hour). Written only by dedicated SQL.
ALTER TABLE users ADD COLUMN mfa_enrollment_open_until TIMESTAMPTZ;

-- app_settings (V36) is ONE row with fixed columns, not a key-value store: the operator-reset marker is a column. It holds the
-- SHA-256 of the MFA_RESET_TOKEN already applied, so a forgotten variable cannot wipe a new enrollment at every restart.
ALTER TABLE app_settings ADD COLUMN mfa_reset_applied_hash VARCHAR(64);

-- The session carries the proof. mfa_verified_at: a second factor was verified for this session (null: none was). authenticated_at:
-- when the person last signed in with a first factor; never refreshed by rotation, it becomes the auth_time claim of the session's
-- access tokens. Both are copied unchanged on rotation, like session_id. Sessions that exist at upgrade count as "never recently
-- authenticated".
ALTER TABLE refresh_tokens
    ADD COLUMN mfa_verified_at  TIMESTAMPTZ,
    ADD COLUMN authenticated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE refresh_tokens SET authenticated_at = 'epoch';

-- Data step: every ADMIN session that exists at upgrade ends here. Without it an old refresh token (an old laptop, a stolen cookie, a
-- leaked backup) would come back as a live ADMIN session the moment the admin enrols, because the account then satisfies the policy
-- again. The sid-bound access tokens of those sessions die with them; the cut-off covers tokens that carry no sid. AUTHOR and USER
-- sessions are not touched.
UPDATE refresh_tokens SET revoked_at = now(), expires_at = LEAST(expires_at, now())
 WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE role = 'ADMIN');
UPDATE users SET tokens_valid_after = GREATEST(COALESCE(tokens_valid_after, now()), now()) WHERE role = 'ADMIN';
