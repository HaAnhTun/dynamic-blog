package com.blog.common.exception;

public enum ErrorCode {
    VALIDATION_ERROR,
    POST_NOT_FOUND,
    POST_NOT_PUBLISHABLE,
    AUTHOR_NOT_FOUND,
    CATEGORY_NOT_FOUND,
    CATEGORY_ALREADY_EXISTS,
    // Deleting a category that posts still use, in any status (409). It does not detach the category from those posts
    // the way deleting a series does: a published post must have a category, and where to move the posts is the site
    // owner's decision.
    CATEGORY_IN_USE,
    // Linking or changing the language of a translation would put two posts of one language in the same group, or link
    // posts that already belong to other groups (409). The message never names a post that the caller may not see.
    TRANSLATION_CONFLICT,
    TAG_NOT_FOUND,
    TAG_ALREADY_EXISTS,
    RESOURCE_CONFLICT,
    INTERNAL_ERROR,
    ENDPOINT_NOT_FOUND,
    INVALID_CREDENTIALS,
    REFRESH_TOKEN_INVALID,
    REFRESH_TOKEN_EXPIRED,
    REFRESH_TOKEN_REVOKED,
    UNAUTHENTICATED,
    FORBIDDEN,
    // Uploaded images. Each code is a different cause the uploader can fix on their own:
    // change the format, pick another image, shrink it first, clear some old images, or simply retry.
    MEDIA_NOT_FOUND,
    MEDIA_UNSUPPORTED_TYPE,
    MEDIA_UNREADABLE,
    MEDIA_TOO_LARGE,
    MEDIA_DIMENSIONS_TOO_LARGE,
    MEDIA_QUOTA_EXCEEDED,
    MEDIA_BUSY,
    // Series. NOT_FOUND is also the public answer for a series with no published part yet: for the reader, that
    // series does not exist.
    SERIES_NOT_FOUND,
    SERIES_ALREADY_EXISTS,
    // Changing the language of a post that has a declared part in a series, when another post of the series already has
    // that part in the target language (409). The message never names a post or the series.
    SERIES_PART_CONFLICT,
    // Gallery: 404 when the id is in the path, 400 when it is in the body of a reorder request.
    GALLERY_PHOTO_NOT_FOUND,
    // The messages of the codes below never contain comment content, a login, an email or a token.
    // The comment does not exist, is no longer visible to readers, or its post is no longer published (404).
    COMMENT_NOT_FOUND,
    // A reply to a reply (only one level), or a top-level comment that already has 30 replies (422).
    COMMENT_NOT_REPLYABLE,
    // The same person sent exactly the same content to the same post or the same parent comment within 10 minutes
    // (409).
    COMMENT_DUPLICATE,
    // Per-user rate limit exceeded: comments, edits and deletes, post likes (429). It is also the answer of password
    // login when waiting too long for a password-check slot (LoginConcurrencyLimiter).
    RATE_LIMITED,
    // An AUTHOR reached a limit that an ADMIN does not have (AuthorQuotaProperties): posts per day (429), images per
    // post, the size of
    // the tag or category catalog (422). The message says which and the number.
    AUTHOR_QUOTA_EXCEEDED,
    // The old slug an ADMIN asked to release is not in the slug history (404).
    SLUG_HISTORY_NOT_FOUND,
    // The account is suspended: every write, /auth/me, refresh, password login and GitHub login (403).
    USER_SUSPENDED,
    // The user id in the admin API path does not exist (404).
    USER_NOT_FOUND,
    // Only reader accounts (role USER) can be suspended; ADMIN and AUTHOR cannot (409).
    USER_NOT_SUSPENDABLE,
    /** The role change would leave the site with no active admin. */
    LAST_ADMIN,
    /** The site owner's role (the seeded admin account) can only be changed by the site owner. */
    SITE_OWNER_PROTECTED,
    /** The account is suspended: reactivate it before granting the ADMIN or AUTHOR role. */
    ROLE_TARGET_SUSPENDED,
    /** The author application does not exist, or does not belong to the caller. */
    AUTHOR_APPLICATION_NOT_FOUND,
    /** An application is already waiting for review. */
    AUTHOR_APPLICATION_PENDING,
    /** The rejected application has not waited long enough to apply again. */
    AUTHOR_APPLICATION_COOLDOWN,
    /** Only reader accounts (USER) can apply. */
    AUTHOR_APPLICATION_NOT_ALLOWED,
    /** The application was already decided the other way (approving a rejected one, or the reverse). */
    AUTHOR_APPLICATION_DECIDED,
    // The user pressed "Deny" on GitHub's authorization page (401).
    OAUTH_ACCESS_DENIED,
    // A forged state, a missing or corrupt login-request cookie, or a callback replayed a second time (401).
    OAUTH_STATE_INVALID,
    // GitHub could not answer: a network error, a timeout, or a 5xx error (502).
    OAUTH_PROVIDER_UNAVAILABLE,
    // Every other GitHub login failure: a used or wrong code, a mismatched redirect_uri, a malformed profile (401).
    OAUTH_LOGIN_FAILED,
    // The notification does not exist, or is not the caller's (404): it does not reveal whether someone else's
    // notification exists.
    NOTIFICATION_NOT_FOUND,
    // The revision does not exist, or does not belong to the post in the path (404).
    REVISION_NOT_FOUND,
    // A newsletter confirmation or unsubscribe token that is malformed, unknown, expired or already used: one answer
    // for every case (400).
    NEWSLETTER_TOKEN_INVALID,
    // A held newsletter that does not exist: no such post, or its issue is not waiting for an administrator any more
    // (released or discarded already, or queued by an ADMIN) (404).
    NEWSLETTER_ISSUE_NOT_FOUND,
    // A release for text the administrator did not read: the post changed (address, subject, excerpt or language) after
    // the
    // held list was loaded, so nothing was released; reload the list and read it again (409).
    NEWSLETTER_ISSUE_CHANGED,
    // A real reindex while MEILI_URL or MEILI_MASTER_KEY is blank (409): a configuration problem, not a transient
    // failure, so not 503.
    SEARCH_NOT_CONFIGURED,
    // A reindex or a reconciliation is already running (409); it does not wait, retry when it finishes.
    SEARCH_REINDEX_RUNNING,
    // The reindex stopped before swapping the index (502): the engine failed, documents were rejected, or the document
    // count differs. The index being served is left untouched.
    SEARCH_REINDEX_FAILED,
    // Site content (the owner's profile, about, skills ... per language). NOT_FOUND: no row for that key and locale
    // (404; the public API never answers it, it falls back to the default locale). INVALID: the body does not match the
    // schema of the key, or its schema version is unknown (400); the message starts with the JSON pointer of the first
    // bad field. REVISION_NOT_FOUND: the revision does not exist for that key and locale (404).
    SITE_CONTENT_NOT_FOUND,
    SITE_CONTENT_INVALID,
    SITE_CONTENT_REVISION_NOT_FOUND,
    // First-run setup. CODE_INVALID: the setup code is wrong, one answer for every wrong code (403). CLOSED: setup is
    // already completed (404): there is nothing to claim and nothing to learn.
    SETUP_CODE_INVALID,
    SETUP_CLOSED,
    // Markdown profile import. INVALID_FILE: not UTF-8 text, NUL byte, wrong name or empty (400; too large is 413 with
    // VALIDATION_ERROR). INVALID: the file or a selected section has blocking problems (400). HASH_MISMATCH: the file
    // is not the one previewed (409). NOTHING_TO_UNDO: no import can be undone (404). UNDO_CONFLICT: a written section
    // was
    // changed after the import (409).
    SITE_IMPORT_INVALID_FILE,
    SITE_IMPORT_INVALID,
    SITE_IMPORT_HASH_MISMATCH,
    SITE_IMPORT_NOTHING_TO_UNDO,
    SITE_IMPORT_UNDO_CONFLICT,
    // Markdown post import. No message of these codes contains text from a file or from a post.
    // INVALID_FILE: not UTF-8 text, a control character, wrong name or empty, more than 20 files, a missing or
    // malformed
    // manifest (400; too large is 413 with VALIDATION_ERROR).
    // INVALID: the files or a selected file have blocking problems (400).
    // HASH_MISMATCH: a file is not the one previewed (409).
    // PREVIEW_OUT_OF_DATE: a post the import would write is no longer as the preview showed it (409, a count only).
    // NOTHING_TO_UNDO: no import can be undone (404).
    // UNDO_CONFLICT: a post the import wrote was changed since (409, a count only).
    // MEDIA_QUOTA_EXCEEDED: an image of a ZIP package would exceed the media storage quota (422; the message names the
    // file
    // and the entry by position). MEDIA_BUSY: the image pipeline did not give a turn in time (503; same naming).
    POST_IMPORT_INVALID_FILE,
    POST_IMPORT_INVALID,
    POST_IMPORT_HASH_MISMATCH,
    POST_IMPORT_PREVIEW_OUT_OF_DATE,
    POST_IMPORT_NOTHING_TO_UNDO,
    POST_IMPORT_UNDO_CONFLICT,
    POST_IMPORT_MEDIA_QUOTA_EXCEEDED,
    POST_IMPORT_MEDIA_BUSY,
    // POST_EXPORT_TOO_LARGE: the saved post does not fit a ZIP package within the limits the import reads (413).
    POST_EXPORT_TOO_LARGE,
    // A contact message that does not exist (404), in the admin inbox. The message never contains visitor text.
    CONTACT_MESSAGE_NOT_FOUND,
    // Two-step verification. No message of these codes contains a code, a secret, a challenge or an account.
    // MFA_CHALLENGE_INVALID: the sign-in challenge is unknown, expired, consumed, used up, of the wrong purpose or
    // older than the account's token cut-off: one answer for all of them (401).
    // MFA_CODE_INVALID: the code is wrong, was already used, or cannot be checked: one answer for all of them (401).
    // MFA_RATE_LIMITED: too many wrong codes, or too many sign-in steps waiting (429); details.retryAfterSeconds
    // says how long when the wait is known.
    // MFA_FROZEN: 100 wrong codes in a row; waiting does not help, the server owner has to reset it (403).
    // MFA_REQUIRED: the session has no verified second factor but the account needs one (401 at refresh), or the
    // second step cannot be removed (403).
    // ENROLLMENT_CODE_INVALID: the operator's enrollment code is missing or wrong, one answer for both (403); the
    // 202 of the login says beforehand whether a code is needed.
    // REAUTHENTICATION_REQUIRED: a change of two-step verification or password needs a sign-in within the last
    // minutes, and this session started longer ago, or its token carries no start time (401).
    // PASSWORD_MANAGED_BY_ENVIRONMENT: ADMIN_PASSWORD is set, so a password changed here would be undone at the next
    // start (409).
    MFA_CHALLENGE_INVALID,
    MFA_CODE_INVALID,
    MFA_RATE_LIMITED,
    MFA_FROZEN,
    MFA_REQUIRED,
    ENROLLMENT_CODE_INVALID,
    REAUTHENTICATION_REQUIRED,
    PASSWORD_MANAGED_BY_ENVIRONMENT
}
