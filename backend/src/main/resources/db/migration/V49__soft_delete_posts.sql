-- V49: an AUTHOR's delete of a post is a soft delete.
--
-- A hard delete of a post takes everything that hangs on it with it (ON DELETE CASCADE): the comments of readers with their
-- likes and notifications, post likes, saved posts, the revisions, the body images, the newsletter issue with its deliveries, the
-- view statistics. An AUTHOR may delete only their own posts, but the rows that go with a post belong to other people. So
-- PostService.delete(post, caller, admin) now hides the post for an AUTHOR and keeps all of it: the status becomes ARCHIVED (no
-- public query returns an ARCHIVED post), deleted_at and deleted_by say when and by whom, and the slug stays reserved. An ADMIN
-- still deletes for good, from the admin list where a hidden post shows as ARCHIVED.
ALTER TABLE posts
    ADD COLUMN deleted_at TIMESTAMPTZ,
    ADD COLUMN deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- A deleted post is never public: the database refuses a row that is both.
ALTER TABLE posts
    ADD CONSTRAINT chk_posts_deleted_not_published CHECK (deleted_at IS NULL OR status <> 'PUBLISHED');

-- The ADMIN list of hidden posts, and nothing else reads it.
CREATE INDEX idx_posts_deleted_at ON posts (deleted_at) WHERE deleted_at IS NOT NULL;
