-- V7c: two-step confirmed newsletter (D14–D16, D18, D19, D23). The address only lives in newsletter_subscribers, and only while
-- subscribed: unsubscribing deletes the row, keeping only the HMAC of the address in newsletter_suppressions. The confirmation token is stored only as a SHA-256 hash; the
-- unsubscribe token is derived with an HMAC and so is not stored. Duplicate writes go through ON CONFLICT: a unique violation error copies the address into the log.
CREATE TABLE newsletter_subscribers (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                     VARCHAR(254) NOT NULL UNIQUE,
    status                    VARCHAR(16)  NOT NULL,
    confirmation_requested_at TIMESTAMPTZ,
    confirmation_sent_at      TIMESTAMPTZ,
    confirmation_token_hash   CHAR(64) UNIQUE,
    confirmation_expires_at   TIMESTAMPTZ,
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
    confirmed_at              TIMESTAMPTZ,
    CONSTRAINT chk_newsletter_subscribers_email CHECK (email = lower(email)),
    CONSTRAINT chk_newsletter_subscribers_status CHECK (status IN ('PENDING', 'CONFIRMED')),
    -- Pending: always has the most recent request time (the cleanup job counts 7 days from it). Confirmed: no confirmation column remains.
    CONSTRAINT chk_newsletter_subscribers_state CHECK (
        (status = 'PENDING' AND confirmed_at IS NULL AND confirmation_requested_at IS NOT NULL)
        OR (status = 'CONFIRMED' AND confirmed_at IS NOT NULL AND confirmation_requested_at IS NULL
            AND confirmation_sent_at IS NULL AND confirmation_token_hash IS NULL)),
    -- The token only exists after the confirmation email has been sent, always comes with an expiry, and is a hash: the raw token never gets in here.
    CONSTRAINT chk_newsletter_subscribers_token CHECK (
        (confirmation_token_hash IS NULL) = (confirmation_expires_at IS NULL)
        AND (confirmation_token_hash IS NULL OR confirmation_sent_at IS NOT NULL)
        AND confirmation_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE newsletter_suppressions (
    email_hash CHAR(64)    PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_newsletter_suppressions_hash CHECK (email_hash ~ '^[0-9a-f]{64}$')
);

-- Outbox for the first publish: PostService.publish inserts the row in the same transaction, the worker splits it into deliveries.
CREATE TABLE newsletter_issues (
    post_id     UUID        PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    status      VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expanded_at TIMESTAMPTZ,
    CONSTRAINT chk_newsletter_issues_status CHECK (status IN ('PENDING', 'EXPANDED')),
    CONSTRAINT chk_newsletter_issues_expanded CHECK ((status = 'EXPANDED') = (expanded_at IS NOT NULL))
);

CREATE TABLE newsletter_deliveries (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id         UUID        NOT NULL REFERENCES newsletter_issues(post_id) ON DELETE CASCADE,
    subscriber_id   UUID        NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
    status          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    attempts        INTEGER     NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_error      VARCHAR(32),
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The duplicate-send guard: a retry, or expanding an issue a second time, creates no extra email for the same person.
    CONSTRAINT uq_newsletter_deliveries_post_subscriber UNIQUE (post_id, subscriber_id),
    CONSTRAINT chk_newsletter_deliveries_status CHECK (status IN ('PENDING', 'RETRYING', 'SENT', 'DEAD')),
    CONSTRAINT chk_newsletter_deliveries_attempts CHECK (attempts >= 0),
    CONSTRAINT chk_newsletter_deliveries_sent CHECK ((status = 'SENT') = (sent_at IS NOT NULL)),
    -- Only a safe code (CONNECTION_FAILED…), never the provider's message, which may contain the address.
    CONSTRAINT chk_newsletter_deliveries_error CHECK (
        last_error ~ '^[A-Z_]{1,32}$' AND (status NOT IN ('RETRYING', 'DEAD') OR last_error IS NOT NULL))
);
-- The rows due for the sending step. The post_id column already has a unique key above; subscriber_id is for the cascade on unsubscribe.
CREATE INDEX idx_newsletter_deliveries_due ON newsletter_deliveries (next_attempt_at)
    WHERE status IN ('PENDING', 'RETRYING');
CREATE INDEX idx_newsletter_deliveries_subscriber ON newsletter_deliveries (subscriber_id);
