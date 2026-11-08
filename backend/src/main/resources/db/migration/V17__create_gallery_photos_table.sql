-- The site owner's gallery photos. The image metadata and bytes live in media/media_content (V11); this table only holds what is
-- specific to the gallery: caption, date taken, order, shown or hidden.
--
-- media_id UNIQUE: a gallery image is only uploaded through the gallery itself, so it belongs to exactly one gallery photo (like a cover image,
-- V12). ON DELETE CASCADE: deleting a gallery photo deletes exactly one media row, and the foreign key cascades to this row (the bytes follow
-- through media_content): there is never a gallery photo pointing at a lost image, or bytes that nothing points to.
--
-- published = false means "hidden from the page", not private: the image URL is still served to anyone who has it (spec §2.2).
CREATE TABLE gallery_photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    media_id UUID NOT NULL UNIQUE REFERENCES media(id) ON DELETE CASCADE,
    caption TEXT,
    -- Date taken, without a time zone: a photo taken on "14 Sep" is still 14 Sep wherever it was taken.
    taken_on DATE,
    -- Not named "position": that is a function name in HQL. A new photo receives MIN(sort_order) - 1 to go first; reordering
    -- writes 1..n. No unique constraint: two uploads at exactly the same moment simply tie and created_at breaks the tie.
    sort_order INT NOT NULL,
    published BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly the order the /gallery page reads, only over the photos that are shown.
CREATE INDEX idx_gallery_photos_published_order ON gallery_photos (sort_order, created_at DESC) WHERE published;
