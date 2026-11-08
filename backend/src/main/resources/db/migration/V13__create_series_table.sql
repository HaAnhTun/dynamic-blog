-- A set of posts read in order (for example a multi-part series). Same mould as
-- categories (V3): a unique slug for the public URL /series/{slug}, and the name must not repeat even when the case
-- differs, so that two series never appear as one on the /series page.
--
-- This table only holds the name, slug and description. Which posts belong to a series and at which position lives on the posts table itself (V14):
-- a post belongs to at most one series, so no join table is needed.
CREATE TABLE series (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_series_title_lower ON series (LOWER(title));
