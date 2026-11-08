-- V9D1, step 2 of 3: per-owner site content. One row per (key, locale); `data` is the validated JSON of that key and
-- `schema_version` says which shape it has (older versions are upgraded on read, unknown ones are rejected by the
-- application). The key set and the locale set are part of the schema, like the content languages of V35.
CREATE TABLE site_content (
    key            VARCHAR(30) NOT NULL,
    locale         VARCHAR(10) NOT NULL,
    schema_version INTEGER NOT NULL,
    data           JSONB NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (key, locale),
    CONSTRAINT chk_site_content_key CHECK (key IN
        ('site', 'profile', 'about', 'skills', 'now', 'timeline', 'contact', 'blogroll', 'case_studies')),
    CONSTRAINT chk_site_content_locale CHECK (locale IN ('vi', 'en')),
    CONSTRAINT chk_site_content_schema_version CHECK (schema_version >= 1),
    CONSTRAINT chk_site_content_data_object CHECK (jsonb_typeof(data) = 'object'),
    CONSTRAINT chk_site_content_data_size CHECK (octet_length(data::text) <= 262144)
);
