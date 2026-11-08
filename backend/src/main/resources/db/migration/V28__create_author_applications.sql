-- V7a: applications to become an author. A USER submits; only an ADMIN approves or rejects, and an approval changes the role through
-- RoleChangeService (an application never assigns a role by itself). There is no withdrawal of an application.
CREATE TABLE author_applications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status      VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    motivation  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at  TIMESTAMPTZ,
    decided_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_author_applications_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT chk_author_applications_motivation CHECK (motivation IS NULL OR char_length(motivation) <= 500),
    -- A decided application has a decision time; a pending one does not.
    CONSTRAINT chk_author_applications_decided CHECK ((status = 'PENDING') = (decided_at IS NULL))
);
-- At most one pending application per person, even when two submissions run at the same time.
CREATE UNIQUE INDEX uq_author_applications_one_pending ON author_applications (user_id) WHERE status = 'PENDING';
-- A person's most recent application (the status on /profile, the wait time before resubmitting).
CREATE INDEX idx_author_applications_user ON author_applications (user_id, created_at DESC);
-- The admin's list of applications awaiting review.
CREATE INDEX idx_author_applications_pending ON author_applications (created_at) WHERE status = 'PENDING';
