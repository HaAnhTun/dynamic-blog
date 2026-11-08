-- V9D1, step 3 of 3: previous versions of a site content row. The application keeps the last 10 per (key, locale) and
-- writes a row here before every change; the Markdown import (D2) uses it to undo an import.
CREATE TABLE site_content_revision (
    id             BIGSERIAL PRIMARY KEY,
    key            VARCHAR(30) NOT NULL,
    locale         VARCHAR(10) NOT NULL,
    schema_version INTEGER NOT NULL,
    data           JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_site_content_revision_key CHECK (key IN
        ('site', 'profile', 'about', 'skills', 'now', 'timeline', 'contact', 'blogroll', 'case_studies')),
    CONSTRAINT chk_site_content_revision_locale CHECK (locale IN ('vi', 'en')),
    CONSTRAINT chk_site_content_revision_schema_version CHECK (schema_version >= 1),
    CONSTRAINT chk_site_content_revision_data_object CHECK (jsonb_typeof(data) = 'object'),
    CONSTRAINT chk_site_content_revision_data_size CHECK (octet_length(data::text) <= 262144)
);

CREATE INDEX idx_site_content_revision_lookup ON site_content_revision (key, locale, id DESC);
