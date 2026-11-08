-- V8b B9: outbox that syncs the Meilisearch index. One row = "sync this document according to the DB at processing time" (the worker chooses write or delete itself,
-- and a rerun still produces the same index); once done the row is deleted, FAILED rows stay for the status page. No foreign key to the source table: the row
-- for a deletion must outlive the source row.
CREATE TABLE search_outbox (
    id              BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_type        VARCHAR(16)  NOT NULL,
    source_id       VARCHAR(200) NOT NULL,
    state           VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    attempts        INTEGER      NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ  NOT NULL,
    -- Deadline of the processing run that holds the row: once it passes (the worker died), the next run takes the row back.
    locked_until    TIMESTAMPTZ,
    -- The Meilisearch task sent for this row, recorded BEFORE waiting: a restarted worker keeps polling that task and does not resend.
    task_uid        BIGINT,
    last_error_code VARCHAR(32),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Exactly the DocType the indexer understands (the value of the document's type field).
    CONSTRAINT chk_search_outbox_doc_type CHECK (
        doc_type IN ('post', 'category', 'tag', 'series', 'author', 'case-study', 'page')),
    -- Content in the DB is keyed by uuid (canonical form, lowercase), static content by slug: both become valid document ids.
    CONSTRAINT chk_search_outbox_source_id CHECK (CASE WHEN doc_type IN ('case-study', 'page')
        THEN source_id ~ '^[A-Za-z0-9_-]{1,200}$'
        ELSE source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' END),
    CONSTRAINT chk_search_outbox_state CHECK (state IN ('PENDING', 'PROCESSING', 'FAILED')),
    CONSTRAINT chk_search_outbox_attempts CHECK (attempts >= 0),
    CONSTRAINT chk_search_outbox_lease CHECK ((state = 'PROCESSING') = (locked_until IS NOT NULL)),
    CONSTRAINT chk_search_outbox_task CHECK (task_uid IS NULL OR (state = 'PROCESSING' AND task_uid >= 0)),
    -- Only a safe code (CONNECTION_FAILED…), never a message: Meilisearch's error body echoes the query back.
    CONSTRAINT chk_search_outbox_error CHECK (
        last_error_code ~ '^[A-Z_]{1,32}$' AND (state <> 'FAILED' OR last_error_code IS NOT NULL))
);
-- Event coalescing: each document has at most one row that is waiting or failed (INSERT … ON CONFLICT in SearchOutbox). A row being
-- processed sits outside the index: a change arriving in the meantime becomes a new waiting row and is not swallowed.
CREATE UNIQUE INDEX uq_search_outbox_waiting ON search_outbox (doc_type, source_id)
    WHERE state IN ('PENDING', 'FAILED');
CREATE INDEX idx_search_outbox_due ON search_outbox (next_attempt_at) WHERE state = 'PENDING';
