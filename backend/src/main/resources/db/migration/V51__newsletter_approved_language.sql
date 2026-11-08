-- V51: a released newsletter keeps the language the administrator approved.
--
-- V48 stores the subject and the excerpt that were approved, but the worker still read the language of the post when it split the
-- issue into mails, so an author who changed the language of a post between the release and the worker run (or while a released
-- issue waited for an unpublished post to be published again) changed who receives the mail. The release now stores the language
-- with the snapshot and the worker uses it. A row released before this migration has none and keeps reading the post.
ALTER TABLE newsletter_issues ADD COLUMN approved_language VARCHAR(8);

ALTER TABLE newsletter_issues
    ADD CONSTRAINT chk_newsletter_issues_approved_language CHECK (
        approved_language IS NULL OR (approved_language IN ('vi', 'en') AND approved_title IS NOT NULL));
