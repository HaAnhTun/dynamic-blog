-- V6: reader notifications. One row per event: someone likes or comments on your post, replies to or likes your
-- comment. Rows are only added by the INSERT ... SELECT statement in NotificationRepository, in the same transaction as the like or the
-- comment; every later change (read, delete) is a SQL statement conditioned on the recipient.
--
-- No title, slug or content is stored: posts and comments are joined at read time, so changing a slug does not break links, and
-- when a comment is hidden or a post is taken down, their notifications are hidden too (filtered at read time, not deleted).
CREATE TABLE notifications (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type         VARCHAR(30) NOT NULL,
    post_id      UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    comment_id   UUID REFERENCES comments(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at      TIMESTAMPTZ,
    CONSTRAINT chk_notifications_type CHECK (type IN ('POST_LIKED','POST_COMMENTED','COMMENT_REPLIED','COMMENT_LIKED')),
    -- POST_LIKED has no comment; the other three types always have one.
    CONSTRAINT chk_notifications_comment CHECK ((type = 'POST_LIKED') = (comment_id IS NULL)),
    -- Never notify yourself.
    CONSTRAINT chk_notifications_not_self CHECK (recipient_id <> actor_id)
);
-- The recipient's list (keyset, newest first) and the unread count/filter.
CREATE INDEX idx_notifications_recipient ON notifications (recipient_id, created_at DESC, id DESC);
CREATE INDEX idx_notifications_recipient_unread ON notifications (recipient_id, created_at DESC, id DESC)
    WHERE read_at IS NULL;
-- For ON DELETE CASCADE when a post / comment is deleted (hard-deleting a post cascades to both). There is no index on actor_id, like
-- user_id in V20: only the admin account merge reads by it.
CREATE INDEX idx_notifications_post ON notifications (post_id);
CREATE INDEX idx_notifications_comment ON notifications (comment_id) WHERE comment_id IS NOT NULL;
-- Protection against like → unlike → like spam: at most one row per (recipient, liker, target). Unliking does not delete the row; at
-- read time, the row of an unliked like is hidden, and reappears intact when that person likes again.
CREATE UNIQUE INDEX uq_notifications_post_liked ON notifications (recipient_id, actor_id, post_id)
    WHERE type = 'POST_LIKED';
CREATE UNIQUE INDEX uq_notifications_comment_liked ON notifications (recipient_id, actor_id, comment_id)
    WHERE type = 'COMMENT_LIKED';
