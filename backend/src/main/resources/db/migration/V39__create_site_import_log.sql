-- V9D2: one row per applied Markdown profile import. It answers who imported what and when, and carries what "undo last
-- import" needs: for each written (key, locale) the id of the revision that holds the previous version (null when the
-- import created the row) and the hash of what the import wrote. It never holds file content or any field value.
CREATE TABLE site_import_log (
    id          BIGSERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    locale      VARCHAR(10) NOT NULL,
    mode        VARCHAR(20) NOT NULL,
    file_sha256 CHAR(64) NOT NULL,
    file_bytes  INTEGER NOT NULL,
    sections    JSONB NOT NULL,
    undone_at   TIMESTAMPTZ,
    undone_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_site_import_log_locale CHECK (locale IN ('vi', 'en')),
    CONSTRAINT chk_site_import_log_mode CHECK (mode IN ('create-only', 'update')),
    CONSTRAINT chk_site_import_log_sha CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_site_import_log_sections CHECK (jsonb_typeof(sections) = 'array')
);
