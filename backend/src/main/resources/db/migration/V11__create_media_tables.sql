-- Uploaded images live in Postgres rather than on disk: the backend in compose has no volume and runs as a
-- non-root user that can only write to /tmp, and containers on Koyeb/Render lose their disk after every deploy. In the DB,
-- images travel in the same pg_dump as all the other data and moving to Neon needs no change.
--
-- Metadata and bytes are in two separate tables so that listings, cover lookups and the gallery page only read small rows: a
-- byte[] attribute cannot be lazy without bytecode enhancement, so with a single table every metadata load
-- would also pull in up to 4 MB.
CREATE TABLE media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type VARCHAR(50) NOT NULL,
    width INT NOT NULL,
    height INT NOT NULL,
    byte_size INT NOT NULL,
    -- SHA-256 hex of exactly the stored bytes; also the ETag when serving.
    sha256 VARCHAR(64) NOT NULL,
    dominant_color VARCHAR(7),
    alt_text VARCHAR(300),
    -- Visible to admins only, never part of a public DTO: the file name on the uploader's machine can leak
    -- personal information.
    original_filename VARCHAR(255),
    -- SET NULL: deleting an account must neither cascade to nor block the images that account uploaded.
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Every uploaded image is decoded and then re-encoded as JPEG/PNG, so only what the encoder writes can be
    -- stored: never an SVG, HTML or a polyglot file that a same-origin URL could serve.
    CONSTRAINT chk_media_content_type CHECK (content_type IN ('image/jpeg', 'image/png')),
    CONSTRAINT chk_media_dimensions CHECK (width > 0 AND height > 0),
    -- 4 MiB: the largest response a Vercel function can return, and /media runs as a function there.
    CONSTRAINT chk_media_byte_size CHECK (byte_size > 0 AND byte_size <= 4194304),
    CONSTRAINT chk_media_dominant_color CHECK (dominant_color IS NULL OR dominant_color ~ '^#[0-9a-f]{6}$')
);

-- Deleting the metadata takes the bytes with it: there is never a few orphaned MB that nothing references.
CREATE TABLE media_content (
    media_id UUID PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    data BYTEA NOT NULL
);

-- JPEG and PNG are already compressed: TOAST's pglz would cost CPU on every write without saving a single byte.
-- EXTERNAL keeps the value out of line and uncompressed.
ALTER TABLE media_content ALTER COLUMN data SET STORAGE EXTERNAL;
