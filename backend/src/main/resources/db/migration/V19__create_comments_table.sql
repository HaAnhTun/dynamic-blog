-- Comments: a root plus replies exactly one level deep (checked in the service). Soft delete through status; the content is kept for moderation.
-- status/content/edited_at are only changed by conditional UPDATEs (CommentRepository), not through the entity.
CREATE TABLE comments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,   -- deleting a post (hard delete V4) cascades
    user_id    UUID NOT NULL REFERENCES users(id),                     -- NO ACTION, like posts.author_id
    parent_id  UUID,
    content    TEXT NOT NULL,
    status     VARCHAR(20) NOT NULL DEFAULT 'VISIBLE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at  TIMESTAMPTZ,
    CONSTRAINT uq_comments_id_post UNIQUE (id, post_id),
    -- A reply must be on the same post as its parent comment.
    CONSTRAINT fk_comments_parent_same_post FOREIGN KEY (parent_id, post_id)
        REFERENCES comments (id, post_id) ON DELETE CASCADE,
    CONSTRAINT chk_comments_status CHECK (status IN ('VISIBLE', 'HIDDEN', 'DELETED')),
    CONSTRAINT chk_comments_content_length CHECK (char_length(content) BETWEEN 2 AND 2000),
    CONSTRAINT chk_comments_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
-- In order: the root comments page (keyset), the reply batch and the reply count, duplicate-submission protection and the user_id foreign key,
-- filtering by status on the moderation page.
CREATE INDEX idx_comments_post_roots ON comments (post_id, created_at, id) WHERE parent_id IS NULL;
CREATE INDEX idx_comments_replies ON comments (parent_id, created_at, id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_comments_user_created ON comments (user_id, created_at DESC);
CREATE INDEX idx_comments_status_created ON comments (status, created_at DESC);
