-- One row per applied Markdown post import. It answers who imported, when, how many files and what happened to each post,
-- and carries what "undo last import" needs: for each written post its id, the id of the revision that holds the previous
-- text (null when the import created the post or changed no text), the previous category and tag ids, the hash of the
-- state the import wrote and whether it created a translation link. It never holds file text or any value of a post:
-- only identifiers, hashes and counts.
CREATE TABLE post_import_log (
    id          BIGSERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    file_count  INTEGER NOT NULL,
    file_bytes  INTEGER NOT NULL,
    file_hashes JSONB NOT NULL,
    items       JSONB NOT NULL,
    undone_at   TIMESTAMPTZ,
    undone_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_post_import_log_file_count CHECK (file_count BETWEEN 1 AND 20),
    CONSTRAINT chk_post_import_log_file_bytes CHECK (file_bytes >= 0),
    CONSTRAINT chk_post_import_log_file_hashes CHECK (jsonb_typeof(file_hashes) = 'array'),
    CONSTRAINT chk_post_import_log_items CHECK (jsonb_typeof(items) = 'array')
);

-- "The latest import of one person" is the only lookup besides the primary key.
CREATE INDEX idx_post_import_log_created_by ON post_import_log (created_by, id DESC);
