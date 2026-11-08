-- V48: the newsletter of a post published by an AUTHOR waits for an administrator.
--
-- PostService.publish records the issue as HELD when the person publishing is not an ADMIN. NewsletterRepository.pendingIssues
-- selects only PENDING, so a held issue is never split into mails. An ADMIN releases it (HELD -> PENDING, with a snapshot of the
-- subject and the excerpt that were approved, so that an edit made after the approval is not what subscribers receive) or
-- discards it (HELD -> DISCARDED, kept as a record, never sent). An issue that was already split into mails (EXPANDED) keeps its
-- status; one that is still PENDING at the upgrade, for a post written by anyone but an ADMIN, is held below.
ALTER TABLE newsletter_issues DROP CONSTRAINT chk_newsletter_issues_status;
ALTER TABLE newsletter_issues
    ADD CONSTRAINT chk_newsletter_issues_status CHECK (status IN ('PENDING', 'EXPANDED', 'HELD', 'DISCARDED'));

ALTER TABLE newsletter_issues
    ADD COLUMN decided_at TIMESTAMPTZ,
    ADD COLUMN decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN approved_title VARCHAR(255),
    ADD COLUMN approved_excerpt TEXT;

-- A held issue has no decision yet; a discarded one always has one; an approval snapshot exists only after a release.
ALTER TABLE newsletter_issues
    ADD CONSTRAINT chk_newsletter_issues_decision CHECK (
        (status <> 'HELD' OR decided_at IS NULL)
        AND (status <> 'DISCARDED' OR decided_at IS NOT NULL)
        AND (approved_title IS NULL OR decided_at IS NOT NULL));

-- An issue that is still PENDING has not been mailed. If its post was written by an AUTHOR it waits like every issue created from now
-- on: otherwise a post queued, or taken down and published again, around the upgrade would still mail every subscriber unseen. The
-- publisher is not recorded, so the author of the post decides (an administrator who published an author's post releases it in /admin).
UPDATE newsletter_issues i
SET status = 'HELD'
FROM posts p
         JOIN users u ON u.id = p.author_id
WHERE p.id = i.post_id
  AND i.status = 'PENDING'
  AND u.role <> 'ADMIN';
