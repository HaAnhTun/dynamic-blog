package com.blog.common.ratelimit;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Rate limits on reader writes, bound from {@code app.rate-limit.*}, and the limit on how many login password checks
 * run at the same time.
 *
 * The default values live right here ({@code @DefaultValue}), not in application.yml: these are not knobs for
 * operators, they are only set by tests or when hand-tuning is needed. The time window is in the key name
 * ({@code per-minute}, {@code per-hour}...) so only the count can change. A non-positive number stops the application
 * from starting, like MediaProperties: a limit of 0 would block every write and nobody would understand why.
 *
 * @param comment     creating top-level comments and replies ({@code app.rate-limit.comment.*})
 * @param commentEdit editing and deleting your own comments ({@code app.rate-limit.comment-edit.*})
 * @param like        liking and unliking ({@code app.rate-limit.like.*})
 * @param login       the password check of login ({@code app.rate-limit.login.*})
 * @param bookmark    saving and unsaving posts ({@code app.rate-limit.bookmark.*})
 * @param newsletterSignup newsletter signups per address ({@code app.rate-limit.newsletter-signup.*})
 * @param newsletterToken  newsletter confirmations and unsubscribes per address
 *                         ({@code app.rate-limit.newsletter-token.*})
 * @param contactClient    contact messages per client address ({@code app.rate-limit.contact-client.*})
 * @param contactGlobal    contact messages from everyone together ({@code app.rate-limit.contact-global.*})
 * @param newsletterSignupClient newsletter signups per client address
 *                         ({@code app.rate-limit.newsletter-signup-client.*})
 * @param newsletterSignupGlobal newsletter signups from everyone together
 *                         ({@code app.rate-limit.newsletter-signup-global.*})
 * @param newsletterTokenClient  confirmations and unsubscribes per client address
 *                         ({@code app.rate-limit.newsletter-token-client.*})
 * @param newsletterConfirmGlobal  newsletter confirmations from everyone together; unsubscribes are not counted
 *                         ({@code app.rate-limit.newsletter-confirm-global.*})
 * @param loginClient      password login attempts per client address ({@code app.rate-limit.login-client.*})
 * @param mfaClient        second-step sign-in attempts per client address ({@code app.rate-limit.mfa-client.*})
 * @param refreshClient    token refreshes per client address ({@code app.rate-limit.refresh-client.*})
 * @param setupClient      first-run setup attempts per client address ({@code app.rate-limit.setup-client.*})
 * @param searchClient     searches per client address ({@code app.rate-limit.search-client.*})
 * @param postWrite        creating and saving posts by an AUTHOR ({@code app.rate-limit.post-write.*}); an ADMIN is exempt
 * @param taxonomyCreate   creating tags and categories by an AUTHOR ({@code app.rate-limit.taxonomy-create.*}); an ADMIN is exempt
 * @param mediaUpload      uploading cover and body images by an AUTHOR ({@code app.rate-limit.media-upload.*}); an ADMIN is exempt
 */
@ConfigurationProperties("app.rate-limit")
public record RateLimitProperties(
        @DefaultValue Comment comment,
        @DefaultValue CommentEdit commentEdit,
        @DefaultValue Like like,
        @DefaultValue Login login,
        @DefaultValue RoleChange roleChange,
        @DefaultValue AuthorApplication authorApplication,
        @DefaultValue Bookmark bookmark,
        @DefaultValue NewsletterSignup newsletterSignup,
        @DefaultValue NewsletterToken newsletterToken,
        @DefaultValue Search search,
        @DefaultValue SearchReindex searchReindex,
        @DefaultValue Setup setup,
        @DefaultValue SiteContentWrite siteContentWrite,
        @DefaultValue PostImportWrite postImportWrite,
        @DefaultValue ArticlePreview articlePreview,
        @DefaultValue MfaStepUp mfaStepUp,
        @DefaultValue PasswordChange passwordChange,
        @DefaultValue ContactClient contactClient,
        @DefaultValue ContactGlobal contactGlobal,
        @DefaultValue NewsletterSignupClient newsletterSignupClient,
        @DefaultValue NewsletterSignupGlobal newsletterSignupGlobal,
        @DefaultValue NewsletterTokenClient newsletterTokenClient,
        @DefaultValue NewsletterConfirmGlobal newsletterConfirmGlobal,
        @DefaultValue LoginClient loginClient,
        @DefaultValue MfaClient mfaClient,
        @DefaultValue RefreshClient refreshClient,
        @DefaultValue SetupClient setupClient,
        @DefaultValue SearchClient searchClient,
        @DefaultValue PostWrite postWrite,
        @DefaultValue TaxonomyCreate taxonomyCreate,
        @DefaultValue MediaUpload mediaUpload) {

    /**
     * Two limits at once: one stops a fast burst, the other stops a slow trickle across the hour.
     *
     * @param perMinute the count in any one minute
     * @param perHour   the count in any one hour
     */
    public record Comment(
            @DefaultValue("5") int perMinute,
            @DefaultValue("30") int perHour) {
        public Comment {
            requirePositive("comment.per-minute", perMinute);
            requirePositive("comment.per-hour", perHour);
        }
    }

    /** @param perTenMinutes edits and deletes combined, in any ten minutes */
    public record CommentEdit(@DefaultValue("20") int perTenMinutes) {
        public CommentEdit {
            requirePositive("comment-edit.per-ten-minutes", perTenMinutes);
        }
    }

    /** @param perMinute likes and unlikes combined, in any one minute */
    public record Like(@DefaultValue("30") int perMinute) {
        public Like {
            requirePositive("like.per-minute", perMinute);
        }
    }

    /**
     * How many login password checks (Argon2id, 19 MiB each) run at the same time, for the whole JVM
     * (LoginConcurrencyLimiter). It is not a per-person or per-IP limit: it keeps memory and CPU under control. The
     * per-address limit is {@link LoginClient} (and Next's login route).
     *
     * @param concurrent how many checks run at once
     * @param maxWait    how long a login waits for its turn; after that, 429 {@code RATE_LIMITED}
     */
    public record Login(
            @DefaultValue("2") int concurrent,
            @DefaultValue("5s") Duration maxWait) {
        public Login {
            requirePositive("login.concurrent", concurrent);
            if (maxWait == null || maxWait.isNegative() || maxWait.isZero()) {
                throw new IllegalArgumentException(
                        "app.rate-limit.login.max-wait is invalid: " + maxWait + " (must be longer than zero)");
            }
        }
    }

    /** Role changes in /admin/users: a stolen admin session cannot change roles in bulk. */
    public record RoleChange(@DefaultValue("20") int perTenMinutes) {
        public RoleChange {
            requirePositive("role-change.per-ten-minutes", perTenMinutes);
        }
    }

    /** Submitting author applications, per user. */
    public record AuthorApplication(@DefaultValue("5") int perHour) {
        public AuthorApplication {
            requirePositive("author-application.per-hour", perHour);
        }
    }

    /** @param perMinute saves and unsaves of posts combined, in any one minute */
    public record Bookmark(@DefaultValue("30") int perMinute) {
        public Bookmark {
            requirePositive("bookmark.per-minute", perMinute);
        }
    }

    /** @param perHour signups for the same address in any one hour; beyond that, no confirmation mail is queued */
    public record NewsletterSignup(@DefaultValue("3") int perHour) {
        public NewsletterSignup {
            requirePositive("newsletter-signup.per-hour", perHour);
        }
    }

    /** @param perHour confirmations or unsubscribes for the same address in any one hour */
    public record NewsletterToken(@DefaultValue("20") int perHour) {
        public NewsletterToken {
            requirePositive("newsletter-token.per-hour", perHour);
        }
    }

    /**
     * The shared ceiling of {@code GET /api/v1/search} for the whole process. The per-address quota
     * ({@link SearchClient}) is checked first; this is the last safety net keeping the engine and Postgres from a
     * flood.
     *
     * @param perMinute searches by everyone combined, in any one minute
     */
    public record Search(@DefaultValue("1200") int perMinute) {
        public Search {
            requirePositive("search.per-minute", perMinute);
        }
    }

    /** @param perTenMinutes index rebuilds (dry runs included) by one admin, in any ten minutes */
    public record SearchReindex(@DefaultValue("3") int perTenMinutes) {
        public SearchReindex {
            requirePositive("search-reindex.per-ten-minutes", perTenMinutes);
        }
    }

    /**
     * @param perMinute WRONG first-run setup codes for the whole process, in any minute; the per-address count of every
     *                  attempt is {@link SetupClient}. A right code is never counted here (issue 033), so this number
     *                  cannot lock the owner out; it only decides when a wrong code is answered 429 instead of 403.
     */
    public record Setup(@DefaultValue("120") int perMinute) {
        public Setup {
            requirePositive("setup.per-minute", perMinute);
        }
    }

    /** @param perTenMinutes site content saves, restores and imports by one admin, in any ten minutes */
    public record SiteContentWrite(@DefaultValue("60") int perTenMinutes) {
        public SiteContentWrite {
            requirePositive("site-content-write.per-ten-minutes", perTenMinutes);
        }
    }

    /**
     * @param perTenMinutes post import previews, applies and undos combined, by one person (admin or author), in any ten
     *                      minutes; a separate count from {@link SiteContentWrite}
     */
    public record PostImportWrite(@DefaultValue("60") int perTenMinutes) {
        public PostImportWrite {
            requirePositive("post-import-write.per-ten-minutes", perTenMinutes);
        }
    }

    /**
     * @param perTenMinutes article previews (the page makes one call per importable file of a preview, and one per article it
     *                      opens) by one person (admin or author), in any ten minutes; a separate count from
     *                      {@link PostImportWrite}, so that checking many files never uses up the previews and applies
     */
    public record ArticlePreview(@DefaultValue("300") int perTenMinutes) {
        public ArticlePreview {
            requirePositive("article-preview.per-ten-minutes", perTenMinutes);
        }
    }

    /** @param perTenMinutes signed-in two-step verification changes (and the admin reset of an author) by one person, in any ten minutes */
    public record MfaStepUp(@DefaultValue("10") int perTenMinutes) {
        public MfaStepUp {
            requirePositive("mfa-step-up.per-ten-minutes", perTenMinutes);
        }
    }

    /** @param perTenMinutes password changes by one person, in any ten minutes */
    public record PasswordChange(@DefaultValue("5") int perTenMinutes) {
        public PasswordChange {
            requirePositive("password-change.per-ten-minutes", perTenMinutes);
        }
    }

    /**
     * Contact messages from one client address (the trusted forwarded one, else the socket address; see
     * ClientAddressResolver). The same number as the frontend's own per-IP limit, so behind Next this limit never fires
     * first; it holds when the backend is reached directly or Next's in-memory counter is out of reach.
     *
     * @param perHour messages from one address in any one hour
     */
    public record ContactClient(@DefaultValue("5") int perHour) {
        public ContactClient {
            requirePositive("contact-client.per-hour", perHour);
        }
    }

    /** @param perHour contact messages from everyone together in any one hour; over it the answer is 429 */
    public record ContactGlobal(@DefaultValue("60") int perHour) {
        public ContactGlobal {
            requirePositive("contact-global.per-hour", perHour);
        }
    }

    /** @param perHour signups from one client address in any one hour; beyond that nothing is queued and the answer is still 202 */
    public record NewsletterSignupClient(@DefaultValue("5") int perHour) {
        public NewsletterSignupClient {
            requirePositive("newsletter-signup-client.per-hour", perHour);
        }
    }

    /** @param perHour confirmation mails queued for everyone together in any one hour; beyond that nothing is queued and the answer is still 202 */
    public record NewsletterSignupGlobal(
            @DefaultValue("120") int perHour) {
        public NewsletterSignupGlobal {
            requirePositive("newsletter-signup-global.per-hour", perHour);
        }
    }

    /** @param perHour confirmations and unsubscribes together from one client address in any one hour */
    public record NewsletterTokenClient(@DefaultValue("40") int perHour) {
        public NewsletterTokenClient {
            requirePositive("newsletter-token-client.per-hour", perHour);
        }
    }

    /**
     * The whole-site ceiling of newsletter confirmations. Unsubscribes do not use it, on purpose: a valid unsubscribe must
     * always be honored, so no flood of invalid tokens (or of anything else) may leave it without budget.
     *
     * @param perHour confirmations from everyone together in any one hour
     */
    public record NewsletterConfirmGlobal(
            @DefaultValue("300") int perHour) {
        public NewsletterConfirmGlobal {
            requirePositive("newsletter-confirm-global.per-hour", perHour);
        }
    }

    /**
     * Password login attempts from one client address, every attempt counted (wrong or right), before the Argon2 check.
     * Twice Next's own limit (10 per 10 minutes, which a successful sign-in clears), so behind Next this one only fires
     * when Next's counter is bypassed or the backend is reached directly.
     *
     * @param perTenMinutes attempts from one address in any ten minutes
     */
    public record LoginClient(@DefaultValue("20") int perTenMinutes) {
        public LoginClient {
            requirePositive("login-client.per-ten-minutes", perTenMinutes);
        }
    }

    /**
     * The second step of a sign-in from one client address: verifying a code, beginning and confirming an enrollment. Every
     * attempt is counted (wrong or right). Twice Next's own limit (10 per 10 minutes, which a successful sign-in clears),
     * so behind Next this one only fires when Next's counter is bypassed or the backend is reached directly. The
     * guarantee against guessing a code is the per-account counter, not this one.
     *
     * @param perTenMinutes attempts from one address in any ten minutes
     */
    public record MfaClient(@DefaultValue("20") int perTenMinutes) {
        public MfaClient {
            requirePositive("mfa-client.per-ten-minutes", perTenMinutes);
        }
    }

    /** @param perTenMinutes token refreshes from one client address in any ten minutes (one per signed-in reader and 15 minutes in normal use) */
    public record RefreshClient(@DefaultValue("60") int perTenMinutes) {
        public RefreshClient {
            requirePositive("refresh-client.per-ten-minutes", perTenMinutes);
        }
    }

    /** @param perMinute first-run setup attempts from one client address in any minute, checked before the global {@link Setup} count */
    public record SetupClient(@DefaultValue("5") int perMinute) {
        public SetupClient {
            requirePositive("setup-client.per-minute", perMinute);
        }
    }

    /**
     * Searches from one client address, checked before the process-wide {@link Search} ceiling: the same number as the
     * frontend's per-IP limit (120 per minute), so one address cannot spend more than a tenth of the ceiling.
     *
     * @param perMinute searches from one address in any one minute
     */
    public record SearchClient(@DefaultValue("120") int perMinute) {
        public SearchClient {
            requirePositive("search-client.per-minute", perMinute);
        }
    }

    /**
     * Creating a post and saving one (a PUT) by an AUTHOR, counted together. Writing is a human activity: the editor saves when the
     * author asks, so this is far above what a person does and far below a script. An ADMIN is exempt.
     *
     * @param perTenMinutes creates and saves by one author in any ten minutes
     */
    public record PostWrite(@DefaultValue("60") int perTenMinutes) {
        public PostWrite {
            requirePositive("post-write.per-ten-minutes", perTenMinutes);
        }
    }

    /**
     * Creating a tag or a category by an AUTHOR (the editor does it in place), counted together. Whatever is created is public
     * as soon as a published post uses it and is read whole by the public lists, so it is kept small. An ADMIN is exempt.
     *
     * @param perHour creations by one author in any one hour
     */
    public record TaxonomyCreate(@DefaultValue("10") int perHour) {
        public TaxonomyCreate {
            requirePositive("taxonomy-create.per-hour", perHour);
        }
    }

    /**
     * Uploading a cover image or a body image by an AUTHOR, before the image is decoded (the pipeline holds up to a hundred
     * MB of heap per image and one permit for the whole site). An ADMIN is exempt.
     *
     * @param perTenMinutes uploads by one author in any ten minutes
     */
    public record MediaUpload(@DefaultValue("30") int perTenMinutes) {
        public MediaUpload {
            requirePositive("media-upload.per-ten-minutes", perTenMinutes);
        }
    }

    private static void requirePositive(String name, int value) {
        if (value < 1) {
            throw new IllegalArgumentException(
                    "app.rate-limit." + name + " is invalid: " + value + " (must be at least 1)");
        }
    }
}
