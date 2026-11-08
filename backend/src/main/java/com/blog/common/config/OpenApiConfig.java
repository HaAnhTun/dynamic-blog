package com.blog.common.config;

import static java.util.Map.entry;

import com.blog.analytics.service.ViewSource;
import com.blog.auth.dto.MfaChallengeResponse;
import com.blog.author.entity.AuthorApplicationStatus;
import com.blog.comment.entity.CommentStatus;
import com.blog.common.exception.ErrorCode;
import com.blog.notification.entity.NotificationType;
import com.blog.post.entity.PostStatus;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import io.swagger.v3.core.converter.ModelConverters;
import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.Operation;
import io.swagger.v3.oas.models.PathItem;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.media.Content;
import io.swagger.v3.oas.models.media.MediaType;
import io.swagger.v3.oas.models.media.Schema;
import io.swagger.v3.oas.models.responses.ApiResponse;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.springdoc.core.customizers.OpenApiCustomizer;
import org.springdoc.core.properties.SpringDocConfigProperties;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The OpenAPI documentation ({@code /v3/api-docs}, Swagger UI). springdoc builds paths and schemas from the controllers
 * themselves, so the documentation cannot declare a path that has no handler. This class adds what springdoc cannot
 * see:
 * <ul>
 *   <li>the bearer token (JWT) and which operations need it: a copy of the login-required part of SecurityConfig,
 *       because the URL rules cannot be read from the documentation. OpenApiConfigIT really calls every operation
 *       without a token, so the copy cannot drift;</li>
 *   <li>the shared error body ({@code ErrorResponse}) and the error codes of each operation for auth, comments, post
 *       and comment likes, notifications, moderation, users, author applications, the old-slug lookup path, and the
 *       editorial operations;</li>
 *   <li>which fields may be null and which values a status string accepts: Java types carry neither, yet the frontend
 *       relies on them.</li>
 * </ul>
 * The two GitHub login paths ({@code /api/v1/auth/oauth2/**}) are filters of the {@code @Order(2)} chain, not
 * controllers: they are deliberately absent here, backend/README.md describes them.
 */
@Configuration
public class OpenApiConfig {

    /** Name of the security scheme in the documentation; Swagger UI's "Authorize" button sends the token for every operation that declares it. */
    public static final String BEARER = "bearerAuth";

    private static final String ERROR_SCHEMA = "ErrorResponse";

    private static final String DESCRIPTION = """
            REST API for the personal blog platform. Every path is under `/api/v1`. A success is \
            `{"data": ...}` (lists add `"pagination"`); a failure is `{"error": {"code", "message", "traceId"}}` \
            (schema `ErrorResponse`), whatever produced it.

            Operations with a lock take an access token as `Authorization: Bearer <token>`. Get one from \
            `POST /api/v1/auth/login` (accounts with a password) or `POST /api/v1/auth/refresh`. Readers sign in with \
            GitHub through the frontend, which drives two backend paths under `/api/v1/auth/oauth2/`; those are \
            Spring Security filters rather than API operations, so backend/README.md describes them instead of this \
            document. A token that is sent must be valid, even on a public read: an expired one is a 401. For any \
            token, the current role and status of the account are read from the database on every request, so a \
            demotion or a suspension applies at once (403). A token issued before a logout, a sign out everywhere, \
            a password or role change or a suspension is revoked: 401.

            Comment, like and bookmark writes, role changes and author applications are limited per user (429 \
            `RATE_LIMITED`, no `Retry-After` header). Password login is limited by how many password checks run at \
            once, server-wide (429 \
            `RATE_LIMITED` after a short wait). Newsletter confirmations and unsubscribes are limited per address.""";

    /** Operations needing a token besides {@code /api/v1/admin/**} (the {@code authenticated()} rules of SecurityConfig). */
    private static final Set<String> TOKEN_REQUIRED = Set.of(
            "GET /api/v1/auth/me",
            "POST /api/v1/auth/sessions/revoke-all",
            "GET /api/v1/me/mfa",
            "POST /api/v1/me/mfa/enroll/begin",
            "POST /api/v1/me/mfa/enroll/confirm",
            "POST /api/v1/me/mfa/recovery-codes/regenerate",
            "POST /api/v1/me/mfa/replace/begin",
            "POST /api/v1/me/mfa/replace/confirm",
            "DELETE /api/v1/me/mfa",
            "POST /api/v1/me/password",
            "POST /api/v1/posts/{slug}/comments",
            "POST /api/v1/comments/{id}/replies",
            "PUT /api/v1/comments/{id}",
            "DELETE /api/v1/comments/{id}",
            "PUT /api/v1/posts/{slug}/like",
            "DELETE /api/v1/posts/{slug}/like",
            "PUT /api/v1/comments/{id}/like",
            "DELETE /api/v1/comments/{id}/like",
            "GET /api/v1/notifications",
            "GET /api/v1/notifications/unread-count",
            "POST /api/v1/notifications/{id}/read",
            "POST /api/v1/notifications/read-all",
            "DELETE /api/v1/notifications/{id}",
            "GET /api/v1/me/author-application",
            "POST /api/v1/me/author-application",
            "GET /api/v1/me/bookmarks",
            "GET /api/v1/me/bookmarks/{slug}",
            "PUT /api/v1/me/bookmarks/{slug}",
            "DELETE /api/v1/me/bookmarks/{slug}");

    /** Public reads where a token, if present, changes the answer ({@code mine}, {@code liked}). */
    private static final Set<String> TOKEN_OPTIONAL =
            Set.of("GET /api/v1/posts/{slug}/comments", "GET /api/v1/posts/{slug}/like");

    /** The sentence every mutation of two-step verification or password shares. */
    private static final String STEP_UP_NOTE = "A sign-in within the last 10 minutes is required first "
            + "(`REAUTHENTICATION_REQUIRED` otherwise: the session started longer ago; sign in again for a new one).";

    private static final String UNAUTHENTICATED = "`UNAUTHENTICATED`: no token, or an expired or invalid one.";
    private static final String UNAUTHENTICATED_OPTIONAL = "`UNAUTHENTICATED`: a token was sent but is expired or "
            + "invalid. Without a token the call is anonymous.";
    private static final String SUSPENDED = "`USER_SUSPENDED`: the account is suspended.";
    private static final String NOT_ADMIN = "`FORBIDDEN`: not an ADMIN token.";
    private static final String MALFORMED_ID = "`VALIDATION_ERROR`: malformed id.";
    private static final String COMMENT_INVALID = "`VALIDATION_ERROR`: `content` missing, not 2–2000 characters "
            + "after cleaning, or without a visible character.";
    /** Replying and editing also take {@code {id}} in the path: a malformed id is also 400 VALIDATION_ERROR, as for DELETE. */
    private static final String COMMENT_OR_ID_INVALID = "`VALIDATION_ERROR`: malformed id, `content` missing, not "
            + "2–2000 characters after cleaning, or without a visible character.";

    private static final String RATE_LIMITED = "`RATE_LIMITED`: too many writes by this user; retry later.";
    private static final String POST_NOT_FOUND = "`POST_NOT_FOUND`: no published post with this slug.";
    private static final String COMMENT_NOT_FOUND =
            "`COMMENT_NOT_FOUND`: no such comment, it is not visible any " + "more, or its post is not published.";
    private static final String NOTIFICATION_NOT_FOUND =
            "`NOTIFICATION_NOT_FOUND`: no such notification, or it is " + "someone else's.";
    private static final String UNREAD_COUNT =
            " Answers the unread count after the change, as " + "`GET /api/v1/notifications/unread-count` would.";
    private static final String REFRESH_REJECTED = "`REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_EXPIRED` (also every "
            + "session ended at once: a suspension, a role change, a new admin password; or the one session of a "
            + "detected reuse) or "
            + "`REFRESH_TOKEN_REVOKED` (already used: a replay, or a client that lost a rotation race).";
    /** The "owner or ADMIN" rule of every route that names a post (CAN_MANAGE of AdminPostController). */
    private static final String NOT_OWNER = "`FORBIDDEN`: neither the post's author nor an ADMIN. For an AUTHOR this "
            + "is also the answer for a post that does not exist, so post ids cannot be probed.";

    private static final String NO_POST = "`POST_NOT_FOUND`: no such post (an ADMIN's answer).";
    private static final String REVISION_MISSING = NO_POST + " `REVISION_NOT_FOUND`: no such revision of this post, "
            + "including a revision of another post.";
    private static final String MERGE_INVALID = "`VALIDATION_ERROR`: malformed id, `targetId` missing or malformed, "
            + "or `targetId` equal to the id in the path.";
    private static final String ROLE_CHANGES_LIMITED =
            "`RATE_LIMITED`: this administrator changed roles too often; " + "retry later.";
    private static final String APPLICATION_NOT_FOUND = "`AUTHOR_APPLICATION_NOT_FOUND`: no such application.";
    private static final String NEWSLETTER_TOKEN_LIMITED =
            "`RATE_LIMITED`: more than 20 confirmations and " + "unsubscribes for this address in an hour.";

    /** Error answers of every token-requiring operation that the table below does not describe separately (the CMS). */
    private static final Map<Integer, String> TOKEN_ERRORS = Map.of(
            401,
            UNAUTHENTICATED,
            403,
            "`FORBIDDEN`: the token's role, or for a single post its ownership, does not allow this.");

    private record Described(String summary, String description, Map<Integer, String> errors) {}

    /**
     * Operations for auth, comments, post and comment likes, notifications, moderation and users, the old post slug
     * lookup path, the editorial operations (images in the post body, revisions, merging tags and categories, image
     * storage usage), author applications, filtered search and bookmarks, views, analytics and the newsletter, keyed by
     * {@code "METHOD /path"}. It also covers public profiles and the public post list (the {@code author} filter), plus
     * search across all content types, reindex and the admin search status.
     */
    private static final Map<String, Described> OPERATIONS = Map.ofEntries(
            entry(
                    "POST /api/v1/auth/login",
                    new Described(
                            "Password login: the first factor",
                            "For accounts with a password: the admin and authors. Readers sign in with GitHub through the "
                                    + "frontend; their accounts have no password and are refused like an unknown email. "
                                    + "`200` with the token pair when no second factor applies (an author without two-step "
                                    + "verification). `202 Accepted` with a challenge and no token when one does: every admin, "
                                    + "and an author who turned it on. Hand the challenge back with the code to "
                                    + "`POST /api/v1/auth/mfa/verify` (purpose `VERIFY`), or set an authenticator up first "
                                    + "(purpose `ENROLL`: `enroll/begin`, `enroll/confirm`). A client that knows nothing about "
                                    + "two-step verification finds no `accessToken` in a 202 and fails closed. A challenge is "
                                    + "created only after a correct password, so nothing about an account's two-step "
                                    + "verification is visible without it. Only a few password checks run at once for the "
                                    + "whole server (2 by default); a login waits up to 5 seconds for its turn. There is no "
                                    + "per-account lockout of the password step. When `SITE_URL` is a public address, the "
                                    + "development password documented in the README is always refused.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `email` or `password` missing.",
                                    401,
                                    "`INVALID_CREDENTIALS`: the same answer for an unknown email, a wrong password, "
                                            + "an account without a password and, on a public site, the development password.",
                                    403,
                                    "`USER_SUSPENDED`: the password matched but the account is suspended; said before any "
                                            + "challenge exists.",
                                    429,
                                    "`RATE_LIMITED`: too many logins are being checked right now and this one waited "
                                            + "too long for its turn; retry in a moment. Or `MFA_RATE_LIMITED`: the account "
                                            + "already holds 20 sign-in steps that are waiting. No `Retry-After` header."))),
            entry(
                    "POST /api/v1/auth/refresh",
                    new Described(
                            "Exchange a refresh token for a new pair",
                            "Rotates: the token sent is revoked, so each refresh token works once.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `refreshToken` missing.",
                                    401,
                                    REFRESH_REJECTED,
                                    403,
                                    SUSPENDED))),
            entry(
                    "POST /api/v1/auth/logout",
                    new Described(
                            "Revoke a refresh token",
                            "Works for a suspended account too.",
                            Map.of(400, "`VALIDATION_ERROR`: `refreshToken` missing.", 401, REFRESH_REJECTED))),
            entry(
                    "POST /api/v1/auth/mfa/verify",
                    new Described(
                            "Second step of a sign-in",
                            "Takes the `challenge` of a `202` login of purpose `VERIFY` and a `code`: the 6 digits of the "
                                    + "authenticator app, or a recovery code (24 characters, shown in groups of four). The "
                                    + "server tells them apart by shape. The answer carries the token pair like a login does, "
                                    + "plus how many recovery codes are left and whether this sign-in used one (the "
                                    + "authenticator stays enrolled). A code is accepted for the current 30-second step and the "
                                    + "one before, and each step only once: a code used already, or an older one, is refused. "
                                    + "Five codes are evaluated per challenge; after five wrong codes in a row for the account "
                                    + "the step answers 429 for 30 seconds, doubling to 15 minutes, a correct code refused "
                                    + "meanwhile; after 100 in a row it answers 403 until the server owner resets it. No "
                                    + "token is needed: the challenge is the credential.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `challenge` or `code` missing or too long.",
                                    401,
                                    "`MFA_CHALLENGE_INVALID` (the same answer for an unknown, expired, consumed, used up or "
                                            + "stale challenge, or one of another purpose) or `MFA_CODE_INVALID` (wrong, "
                                            + "already used, or not checkable).",
                                    403,
                                    "`MFA_FROZEN`: 100 wrong codes in a row; waiting does not help. Or `USER_SUSPENDED`.",
                                    429,
                                    "`MFA_RATE_LIMITED`: a delay is running (`details.retryAfterSeconds`) or another check "
                                            + "of the account is in progress. Nothing was evaluated."))),
            entry(
                    "POST /api/v1/auth/mfa/enroll/begin",
                    new Described(
                            "Begin the forced enrollment of a sign-in",
                            "Takes the `challenge` of a `202` login of purpose `ENROLL` and, when the login said "
                                    + "`enrollmentCodeRequired`, the operator's `enrollmentCode`. Answers the new secret once: "
                                    + "the base32 text and an `otpauth://` link (no QR image). Nothing about the account "
                                    + "changes until `enroll/confirm`: abandoning the enrollment locks nobody out. A second "
                                    + "call replaces the pending secret.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `challenge` missing or too long.",
                                    401,
                                    "`MFA_CHALLENGE_INVALID`: unknown, expired, consumed, used up, stale, of another purpose, "
                                            + "or the account is enrolled already.",
                                    403,
                                    "`ENROLLMENT_CODE_INVALID`: the code is missing or wrong (the same answer for both; "
                                            + "it counts toward the challenge's five attempts). Or `USER_SUSPENDED`."))),
            entry(
                    "POST /api/v1/auth/mfa/enroll/confirm",
                    new Described(
                            "Confirm the forced enrollment of a sign-in",
                            "Takes the `challenge` and the first 6-digit `code` of the new authenticator, under the same "
                                    + "window, replay and attempt rules as the second step. Activates the authenticator, "
                                    + "revokes every other session of the account, opens the new session and answers the token "
                                    + "pair with ten recovery codes, shown once and never again.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `challenge` or `code` missing or too long.",
                                    401,
                                    "`MFA_CHALLENGE_INVALID` or `MFA_CODE_INVALID`, as for the second step.",
                                    403,
                                    "`MFA_FROZEN` or `USER_SUSPENDED`.",
                                    429,
                                    "`MFA_RATE_LIMITED`: a delay is running (`details.retryAfterSeconds`)."))),
            entry(
                    "GET /api/v1/me/mfa",
                    new Described(
                            "Two-step verification status of the signed-in account",
                            "Any signed-in account. `enrolled`: a confirmed authenticator exists. `required`: every sign-in "
                                    + "needs a second factor (every admin, and an author once enrolled). "
                                    + "`recoveryCodesRemaining`: only a count, the codes are shown once. `hasPassword` and "
                                    + "`passwordManagedByEnvironment` (the server sets `ADMIN_PASSWORD`, so the password "
                                    + "cannot be changed here) tell the security page what to offer. Never a secret.",
                            Map.of(401, UNAUTHENTICATED, 403, "`USER_SUSPENDED`: the account is suspended."))),
            entry(
                    "POST /api/v1/me/mfa/enroll/begin",
                    new Described(
                            "Turn on two-step verification (author): begin",
                            "For an AUTHOR (an admin is enrolled by the sign-in). " + STEP_UP_NOTE + " Needs the "
                                    + "`currentPassword` when the account has a password; an account without one is proved "
                                    + "by the fresh sign-in. Stores a pending secret and answers it once (base32 and an "
                                    + "`otpauth://` link, no QR image); nothing else changes until `enroll/confirm`.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: malformed body.",
                                    401,
                                    "`REAUTHENTICATION_REQUIRED` or `INVALID_CREDENTIALS` (wrong current password).",
                                    403,
                                    "`FORBIDDEN`: not an author, or the account is suspended (`USER_SUSPENDED`).",
                                    409,
                                    "`RESOURCE_CONFLICT`: two-step verification is already on.",
                                    429,
                                    "`RATE_LIMITED`: more than 10 changes in 10 minutes."))),
            entry(
                    "POST /api/v1/me/mfa/enroll/confirm",
                    new Described(
                            "Turn on two-step verification (author): confirm",
                            STEP_UP_NOTE + " Takes the first 6-digit `code` of the new authenticator. Activates it, "
                                    + "answers ten recovery codes (shown once, never again), ends every session of the "
                                    + "account and answers the caller's NEW session as a token pair (same sign-in time).",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `code` missing.",
                                    401,
                                    "`REAUTHENTICATION_REQUIRED`, `MFA_CODE_INVALID`.",
                                    403,
                                    "`FORBIDDEN`, `MFA_FROZEN` or `USER_SUSPENDED`.",
                                    409,
                                    "`RESOURCE_CONFLICT`: no enrollment is waiting to be confirmed.",
                                    429,
                                    "`MFA_RATE_LIMITED` (a delay is running, `details.retryAfterSeconds`) or "
                                            + "`RATE_LIMITED`."))),
            entry(
                    "POST /api/v1/me/mfa/recovery-codes/regenerate",
                    new Described(
                            "Generate new recovery codes",
                            STEP_UP_NOTE + " Takes a `code` (an authenticator code or a recovery code) and the "
                                    + "`currentPassword` where the account has one. Every older recovery code is void; the "
                                    + "ten new ones are answered once.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `code` missing.",
                                    401,
                                    "`REAUTHENTICATION_REQUIRED`, `INVALID_CREDENTIALS` or `MFA_CODE_INVALID`.",
                                    403,
                                    "`FORBIDDEN`, `MFA_FROZEN` or `USER_SUSPENDED`.",
                                    409,
                                    "`RESOURCE_CONFLICT`: two-step verification is not turned on.",
                                    429,
                                    "`MFA_RATE_LIMITED` or `RATE_LIMITED`."))),
            entry(
                    "POST /api/v1/me/mfa/replace/begin",
                    new Described(
                            "Replace the authenticator: begin",
                            STEP_UP_NOTE
                                    + " Takes a `code` of the CURRENT authenticator or a recovery code (the person "
                                    + "who lost the phone but kept the recovery codes can still replace it) and the "
                                    + "`currentPassword` where the account has one. The new secret waits next to the active "
                                    + "one, which keeps working until the swap; an admin never passes through a disabled "
                                    + "state. A second begin overwrites the pending secret.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `code` missing.",
                                    401,
                                    "`REAUTHENTICATION_REQUIRED`, `INVALID_CREDENTIALS` or `MFA_CODE_INVALID`.",
                                    403,
                                    "`FORBIDDEN`, `MFA_FROZEN` or `USER_SUSPENDED`.",
                                    409,
                                    "`RESOURCE_CONFLICT`: two-step verification is not turned on.",
                                    429,
                                    "`MFA_RATE_LIMITED` or `RATE_LIMITED`."))),
            entry(
                    "POST /api/v1/me/mfa/replace/confirm",
                    new Described(
                            "Replace the authenticator: confirm",
                            STEP_UP_NOTE + " Takes the first 6-digit `code` of the NEW authenticator. One conditional "
                                    + "update swaps the secret; the old recovery codes are void and ten new ones are "
                                    + "answered once; every other session ends and the caller gets a new one.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `code` missing.",
                                    401,
                                    "`REAUTHENTICATION_REQUIRED` or `MFA_CODE_INVALID`.",
                                    403,
                                    "`FORBIDDEN`, `MFA_FROZEN` or `USER_SUSPENDED`.",
                                    409,
                                    "`RESOURCE_CONFLICT`: no new authenticator is waiting to be confirmed.",
                                    429,
                                    "`MFA_RATE_LIMITED` or `RATE_LIMITED`."))),
            entry(
                    "DELETE /api/v1/me/mfa",
                    new Described(
                            "Turn off two-step verification (author)",
                            STEP_UP_NOTE + " Takes a `code`. Only an author can turn it off; an administrator gets "
                                    + "`MFA_REQUIRED`. Ends every session and answers the caller's new session.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `code` missing.",
                                    401,
                                    "`REAUTHENTICATION_REQUIRED` or `MFA_CODE_INVALID`.",
                                    403,
                                    "`MFA_REQUIRED` (an administrator), `MFA_FROZEN` or `USER_SUSPENDED`.",
                                    409,
                                    "`RESOURCE_CONFLICT`: two-step verification is not turned on.",
                                    429,
                                    "`MFA_RATE_LIMITED` or `RATE_LIMITED`."))),
            entry(
                    "POST /api/v1/me/password",
                    new Described(
                            "Change the password",
                            STEP_UP_NOTE + " Takes `currentPassword`, `newPassword` and, when the account has "
                                    + "two-step verification, a `code`. The new password must meet the password policy (12 to "
                                    + "128 characters, not on the common list, not built around the email, different from "
                                    + "the current one). Every session ends and the caller gets a new one, so the other "
                                    + "devices are signed out. Refused while the server sets `ADMIN_PASSWORD`, because that "
                                    + "setting would undo the change at the next start.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: a field is missing, the account has no password, or the new "
                                            + "password breaks the policy (one stable message per rule, never the value).",
                                    401,
                                    "`REAUTHENTICATION_REQUIRED`, `INVALID_CREDENTIALS` (wrong current password) or "
                                            + "`MFA_CODE_INVALID`.",
                                    403,
                                    "`MFA_FROZEN` or `USER_SUSPENDED`.",
                                    409,
                                    "`PASSWORD_MANAGED_BY_ENVIRONMENT`: `ADMIN_PASSWORD` is set.",
                                    429,
                                    "`RATE_LIMITED` (more than 5 changes in 10 minutes) or `MFA_RATE_LIMITED`."))),
            entry(
                    "POST /api/v1/admin/users/{id}/mfa/reset",
                    new Described(
                            "Reset an author's two-step verification",
                            "ADMIN only. For an author who lost the device: the enrollment and the recovery codes are "
                                    + "deleted and the author's sessions end. " + STEP_UP_NOTE + " Takes the "
                                    + "administrator's own `code`. Never for another administrator: that is the server "
                                    + "owner's job (docs/SECURITY.md).",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: malformed id or `code` missing.",
                                    401,
                                    "`REAUTHENTICATION_REQUIRED` or `MFA_CODE_INVALID`.",
                                    403,
                                    "`FORBIDDEN` (not an admin, or the target is an administrator) or `MFA_FROZEN`.",
                                    404,
                                    "`USER_NOT_FOUND`: no such account, or one that is not an author.",
                                    429,
                                    "`MFA_RATE_LIMITED` or `RATE_LIMITED`."))),
            entry(
                    "POST /api/v1/auth/sessions/revoke-all",
                    new Described(
                            "Sign out everywhere",
                            "Revokes every refresh token of the caller and every access token issued so far, the one "
                                    + "used for this call included. The caller must sign in again.",
                            Map.of(
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    "Not returned by this call: a suspended account can still end its own sessions."))),
            entry(
                    "GET /api/v1/auth/me",
                    new Described(
                            "The signed-in account",
                            "Any valid access token. `email` is null for a GitHub reader; `githubLogin` and `avatarUrl` are "
                                    + "null for an account that never signed in with GitHub. Never carries a password hash, a "
                                    + "GitHub id or a token.",
                            Map.of(
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    "`USER_SUSPENDED`: the account is suspended; the frontend then signs it out."))),
            entry(
                    "GET /api/v1/posts",
                    new Described(
                            "Published posts",
                            "Newest first. Filters are slugs and combine with AND: `category`, `tag` and `author` (an "
                                    + "account's public slug, the `profileSlug` of post and comment authors); `featured=true` "
                                    + "keeps the curated posts, in the site owner's order. A blank filter filters nothing; an "
                                    + "unknown or malformed slug gives an empty page. Drafts never appear. `sort=popular` "
                                    + "orders every published post by views and takes no filter. `size` is clamped to 1–100.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `sort` is neither `latest` nor `popular`, `sort=popular` comes "
                                            + "with a filter, or a `page` or `size` that is not a number."))),
            entry(
                    "GET /api/v1/users/{slug}",
                    new Described(
                            "A public profile",
                            "Any account that is not suspended, by its public slug: the `profileSlug` of post and comment "
                                    + "authors. The slug is chosen when the account is created and never changes, also when "
                                    + "the GitHub login does. Only what comments and author lines already show, plus "
                                    + "`joinedAt` (when the account was created) and `publishedPosts` (published posts only); "
                                    + "never an email, a role, a status or an id. `siteOwner` marks the site owner's account. "
                                    + "The account's posts are `GET /api/v1/posts?author={slug}`.",
                            Map.of(
                                    404,
                                    "`USER_NOT_FOUND`: the same answer for an unknown or malformed slug and for a "
                                            + "suspended account."))),
            entry(
                    "GET /api/v1/posts/search",
                    new Described(
                            "Search published posts",
                            "Full-text search over the title, excerpt and body, ignoring case and Vietnamese diacritics; "
                                    + "every word of `q` must match. `q` is cleaned (control and invisible characters removed, "
                                    + "trimmed) and may then hold at most 200 characters. Filters are slugs: `category` and "
                                    + "`series` once each, `tag` repeated (or comma-separated) up to 5 different ones. "
                                    + "Everything given must match, every selected tag included; a post has one category and "
                                    + "at most one series, so a repeated `category` or `series` matches nothing. An unknown or "
                                    + "malformed slug gives an empty page. With `q`, the best match comes first; with filters "
                                    + "only, the newest; with neither, the page is empty. Posts by a suspended author are "
                                    + "left out. `size` is clamped to 1–100.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `q` longer than 200 characters after cleaning, more than 5 "
                                            + "different `tag` values, a `page` or `size` that is not a number, or a query string "
                                            + "the server cannot decode (a malformed percent-encoding)."))),
            entry(
                    "GET /api/v1/search",
                    new Described(
                            "Search all published content",
                            "Posts, topics (categories and tags), series, case studies, authors and site pages, grouped in "
                                    + "that order; only groups with a match are returned. `q` is cleaned as in "
                                    + "`GET /api/v1/posts/search` and may then hold at most 200 characters; a blank `q` without "
                                    + "filters returns no groups. With the default PostgreSQL engine posts match whole words "
                                    + "(every word of `q`); with `SEARCH_ENGINE=meilisearch` the last word also matches as a "
                                    + "prefix and words of five or more characters tolerate typos (`engine` in the answer says "
                                    + "which one replied). The other types match word prefixes, ignoring case and Vietnamese "
                                    + "diacritics. A `q` with no letter or digit matches nothing on either engine. Only "
                                    + "published content: no drafts, no posts or profile of a suspended author, and an author is listed only with a "
                                    + "published post. `type` is `all` (default) or one type; `limit` (1–10) caps each group, "
                                    + "5 by default for `all` and 10 for one type. `type=post` pages with `page` and `size` "
                                    + "(1–50, default 10) and alone takes the `category`, `tag` (up to 5, all required) and "
                                    + "`series` filters of `GET /api/v1/posts/search`; with filters and a blank `q` it lists "
                                    + "the newest posts. Titles and descriptions are arrays of `{text, match}` segments, never "
                                    + "HTML; an item `id` is `<type>:<slug or path>`. `engine` names the engine that answered, "
                                    + "`degraded` is true only when the configured engine failed and PostgreSQL answered. "
                                    + "Server-wide limit: 1200 searches a minute (429 `RATE_LIMITED`).",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `q` longer than 200 characters after cleaning, an unknown "
                                            + "`type`, a filter without `type=post`, more than 5 different `tag` values, or a "
                                            + "`limit`, `page` or `size` that is not a number.",
                                    429,
                                    "`RATE_LIMITED`: too many searches on the whole server right now; retry in a "
                                            + "moment. No `Retry-After` header."))),
            entry(
                    "GET /api/v1/posts/{slug}/redirect",
                    new Described(
                            "Where an old post slug lives now",
                            "When the slug of a post that was ever published changes, the old one is kept. This answers the "
                                    + "post's current slug, for a permanent redirect: one hop, however many times the slug "
                                    + "changed, and never the slug asked for. Only while the post is published. A post that "
                                    + "takes back one of its old slugs makes it live again. No other post can take an old "
                                    + "slug; it gets a numbered suffix instead.",
                            Map.of(
                                    404,
                                    "`POST_NOT_FOUND`: not an old slug of a published post: unknown, a post's current "
                                            + "slug, or a post that is a draft, archived or deleted."))),
            entry(
                    "GET /api/v1/posts/{slug}/comments",
                    new Described(
                            "A page of comments",
                            "Top-level comments oldest first, each with its visible replies (at most 30, oldest first). "
                                    + "`size` is clamped to 1–20. Pass `nextCursor` back as `after` for the next page; it is "
                                    + "null on the last one. A hidden or deleted top-level comment that still has visible "
                                    + "replies appears as a placeholder whose `content` and `author` are null. With a token, "
                                    + "`mine` marks the caller's own comments.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: malformed `after` cursor.",
                                    401,
                                    UNAUTHENTICATED_OPTIONAL,
                                    404,
                                    POST_NOT_FOUND))),
            entry(
                    "POST /api/v1/posts/{slug}/comments",
                    new Described(
                            "Comment on a post",
                            "The author is always the token's user; every body field but `content` is ignored. The content "
                                    + "is cleaned (CRLF to LF, control and invisible formatting characters removed, trimmed, "
                                    + "runs of blank lines collapsed) and must then hold 2–2000 characters, one of them "
                                    + "visible. Stored and returned as plain text. Limit: 5 per minute and 30 per hour per "
                                    + "user, shared with replies.",
                            Map.of(
                                    400,
                                    COMMENT_INVALID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED,
                                    404,
                                    POST_NOT_FOUND,
                                    409,
                                    commentDuplicate("on this post"),
                                    429,
                                    RATE_LIMITED))),
            entry(
                    "POST /api/v1/comments/{id}/replies",
                    new Described(
                            "Reply to a comment",
                            "One level deep: the parent must be a visible top-level comment on a published post. Same "
                                    + "content rules, and the same limit, as a new comment.",
                            Map.of(
                                    400,
                                    COMMENT_OR_ID_INVALID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED,
                                    404,
                                    COMMENT_NOT_FOUND,
                                    409,
                                    commentDuplicate("as a reply to this comment"),
                                    422,
                                    "`COMMENT_NOT_REPLYABLE`: the parent is itself a reply, or already has 30 replies.",
                                    429,
                                    RATE_LIMITED))),
            entry(
                    "PUT /api/v1/comments/{id}",
                    new Described(
                            "Edit your comment",
                            "Author only, visible comments on published posts only, no time limit. `edited` becomes true "
                                    + "when the content changes; the same content changes nothing. Limit: 20 edits and "
                                    + "deletes per 10 minutes per user.",
                            Map.of(
                                    400,
                                    COMMENT_OR_ID_INVALID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    "`USER_SUSPENDED`, or `FORBIDDEN`: not the author. Moderators use the admin API.",
                                    404,
                                    COMMENT_NOT_FOUND,
                                    429,
                                    RATE_LIMITED))),
            entry(
                    "DELETE /api/v1/comments/{id}",
                    new Described(
                            "Delete your comment",
                            "Author only. Soft delete: the content stays for moderation, and a top-level comment with "
                                    + "visible replies becomes a placeholder. A second delete is a 404.",
                            Map.of(
                                    400,
                                    MALFORMED_ID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    "`USER_SUSPENDED`, or `FORBIDDEN`: not the author. Moderators use the admin API.",
                                    404,
                                    COMMENT_NOT_FOUND,
                                    429,
                                    RATE_LIMITED))),
            entry(
                    "GET /api/v1/posts/{slug}/like",
                    new Described(
                            "Like count",
                            "`liked` tells whether the caller liked the post: always false without a token.",
                            Map.of(401, UNAUTHENTICATED_OPTIONAL, 404, POST_NOT_FOUND))),
            entry(
                    "PUT /api/v1/posts/{slug}/like",
                    new Described(
                            "Like a post",
                            "Idempotent, no request body; answers the stored state. Limit: 30 per minute per user, shared "
                                    + "with removing a like.",
                            Map.of(401, UNAUTHENTICATED, 403, SUSPENDED, 404, POST_NOT_FOUND, 429, RATE_LIMITED))),
            entry(
                    "DELETE /api/v1/posts/{slug}/like",
                    new Described(
                            "Remove your like",
                            "Idempotent; answers 200 with the stored state, not 204.",
                            Map.of(401, UNAUTHENTICATED, 403, SUSPENDED, 404, POST_NOT_FOUND, 429, RATE_LIMITED))),
            entry(
                    "PUT /api/v1/comments/{id}/like",
                    new Described(
                            "Like a comment",
                            "A visible comment on a published post. Idempotent, no request body; answers the stored state. "
                                    + "Liking your own comment is allowed and notifies nobody; a new like notifies the "
                                    + "comment's author. The count comes with each comment (`likeCount`, `likedByMe`), so "
                                    + "there is no GET. Limit: 30 per minute per user, shared with post likes and removing a "
                                    + "like.",
                            Map.of(
                                    400,
                                    MALFORMED_ID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED,
                                    404,
                                    COMMENT_NOT_FOUND,
                                    429,
                                    RATE_LIMITED))),
            entry(
                    "DELETE /api/v1/comments/{id}/like",
                    new Described(
                            "Remove your like from a comment",
                            "Idempotent; answers 200 with the stored state, not 204.",
                            Map.of(
                                    400,
                                    MALFORMED_ID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED,
                                    404,
                                    COMMENT_NOT_FOUND,
                                    429,
                                    RATE_LIMITED))),
            entry(
                    "GET /api/v1/notifications",
                    new Described(
                            "Your notifications",
                            "Someone liked or commented on your post, replied to or liked your comment; never your own "
                                    + "actions. Newest first, and only while still current: the post is published, the "
                                    + "comment involved is visible, and a like has not been withdrawn (liking again brings the "
                                    + "same notification back). `size` is clamped to 1–50; pass `nextCursor` back as `after` "
                                    + "for the next page, it is null on the last one. `unread=true` lists unread ones only. "
                                    + "`headCursor`, set only on a first page that has items, is the newest item's position: "
                                    + "send it as `before` to mark all read. `commentId` and `excerpt` are null for "
                                    + "`POST_LIKED`.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: malformed `after` cursor, `size` or `unread`.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED))),
            entry(
                    "GET /api/v1/notifications/unread-count",
                    new Described(
                            "Unread notification count",
                            "Unread notifications that the list would show, capped at 100.",
                            Map.of(401, UNAUTHENTICATED, 403, SUSPENDED))),
            entry(
                    "POST /api/v1/notifications/{id}/read",
                    new Described(
                            "Mark a notification read",
                            "Idempotent: one already read is a 200 too." + UNREAD_COUNT,
                            Map.of(
                                    400,
                                    MALFORMED_ID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED,
                                    404,
                                    NOTIFICATION_NOT_FOUND))),
            entry(
                    "POST /api/v1/notifications/read-all",
                    new Described(
                            "Mark all notifications read",
                            "Marks every unread notification at or before `before`, the list's `headCursor`, so that one "
                                    + "arriving after the list was loaded stays unread. Without `before`, marks them all."
                                    + UNREAD_COUNT,
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: malformed `before` cursor.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED))),
            entry(
                    "DELETE /api/v1/notifications/{id}",
                    new Described(
                            "Delete a notification",
                            "Deletes one of your notifications for good; 200, not 204. A second delete is a 404."
                                    + UNREAD_COUNT,
                            Map.of(
                                    400,
                                    MALFORMED_ID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED,
                                    404,
                                    NOTIFICATION_NOT_FOUND))),
            entry(
                    "GET /api/v1/admin/comments",
                    new Described(
                            "Comments for moderation",
                            "ADMIN only. Every comment on every post, newest first, deleted ones included with their "
                                    + "content. `status` filters (absent means all); `postId` keeps one post's comments, in "
                                    + "the page and in the totals (an id that is no post gives an empty page); `q` searches "
                                    + "content, GitHub login and display name, ignoring case. `size` is clamped to 1–100.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: unknown `status`, or a `postId` that is not a UUID.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN))),
            entry(
                    "POST /api/v1/admin/posts/{id}/images",
                    new Described(
                            "Upload an image for a post's body",
                            "Owner or ADMIN. Multipart `file` (JPEG, PNG or WebP, at most 10 MB) and optional `altText` (at "
                                    + "most 300 characters after trimming; blank means none), processed like a cover: "
                                    + "re-encoded to JPEG or PNG, longest edge at most 2400 px, metadata stripped. The image "
                                    + "belongs to the post: it is listed with it and deleted with it. Nothing is inserted into "
                                    + "the post; link it from the Markdown as `/media/<fileName>`. Counts against the one "
                                    + "storage quota shared with covers and gallery photos.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: malformed id, no `file` or an empty one, or `altText` too long.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_OWNER,
                                    404,
                                    NO_POST,
                                    413,
                                    "`MEDIA_TOO_LARGE`: the file is over the upload limit.",
                                    415,
                                    "`MEDIA_UNSUPPORTED_TYPE`: not JPEG, PNG or WebP by its bytes; `VALIDATION_ERROR` "
                                            + "when the request is not multipart.",
                                    422,
                                    "`MEDIA_UNREADABLE`, `MEDIA_DIMENSIONS_TOO_LARGE`, or `MEDIA_QUOTA_EXCEEDED`: storing "
                                            + "it would exceed the quota.",
                                    503,
                                    "`MEDIA_BUSY`: another image is being processed; retry in a moment."))),
            entry(
                    "GET /api/v1/admin/posts/{id}/images",
                    new Described(
                            "A post's body images",
                            "Owner or ADMIN. Newest first. Never a cover or a gallery photo.",
                            Map.of(400, MALFORMED_ID, 401, UNAUTHENTICATED, 403, NOT_OWNER, 404, NO_POST))),
            entry(
                    "DELETE /api/v1/admin/posts/{id}/images/{mediaId}",
                    new Described(
                            "Delete a body image",
                            "Owner or ADMIN. Deletes the image and its bytes; its URL becomes a 404, also where the post's "
                                    + "Markdown still links to it. Answers the remaining images, newest first: 200, not 204.",
                            Map.of(
                                    400,
                                    MALFORMED_ID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_OWNER,
                                    404,
                                    NO_POST + " `MEDIA_NOT_FOUND`: not a body image of this post: a cover, a gallery "
                                            + "photo, another post's image, or one already deleted."))),
            entry(
                    "GET /api/v1/admin/posts/{id}/revisions",
                    new Described(
                            "A post's revisions",
                            "Owner or ADMIN. Newest first, without content. A save that changes the title, excerpt or "
                                    + "content records the text as it was before, unless the post already has a revision "
                                    + "from the last 10 minutes; the newest 20 are kept. `createdAt` is when that text was "
                                    + "replaced.",
                            Map.of(400, MALFORMED_ID, 401, UNAUTHENTICATED, 403, NOT_OWNER, 404, NO_POST))),
            entry(
                    "GET /api/v1/admin/posts/{id}/revisions/{revisionId}",
                    new Described(
                            "One revision",
                            "Owner or ADMIN. The title, excerpt and content as they were.",
                            Map.of(400, MALFORMED_ID, 401, UNAUTHENTICATED, 403, NOT_OWNER, 404, REVISION_MISSING))),
            entry(
                    "POST /api/v1/admin/posts/{id}/revisions/{revisionId}/restore",
                    new Described(
                            "Restore a revision",
                            "Owner or ADMIN. First records the current text as a revision, whatever the 10-minute rule says, "
                                    + "so the restore can be undone by restoring that one; then puts the revision's title, "
                                    + "excerpt and content back. Slug, status, taxonomy, series and cover stay. When the post "
                                    + "already has exactly that text, nothing changes. Answers the post.",
                            Map.of(400, MALFORMED_ID, 401, UNAUTHENTICATED, 403, NOT_OWNER, 404, REVISION_MISSING))),
            entry(
                    "POST /api/v1/admin/tags/{id}/merge",
                    new Described(
                            "Merge a tag into another",
                            "ADMIN only. Every post with this tag, in any status, gets the tag `targetId` (once, also when "
                                    + "it already had both), then this tag is deleted. No post's `updatedAt` changes. `moved` "
                                    + "is the number of posts that had this tag.",
                            Map.of(
                                    400,
                                    MERGE_INVALID + " `TAG_NOT_FOUND`: no tag `targetId`.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN,
                                    404,
                                    "`TAG_NOT_FOUND`: no tag with the id in the path."))),
            entry(
                    "POST /api/v1/admin/categories/{id}/merge",
                    new Described(
                            "Merge a category into another",
                            "ADMIN only. Moves every post of this category, in any status, to the category `targetId`, then "
                                    + "deletes this one: the way out for a category that `DELETE` refuses because posts use "
                                    + "it. No post's `updatedAt`, status or publication date changes. `moved` is the number "
                                    + "of posts moved.",
                            Map.of(
                                    400,
                                    MERGE_INVALID + " `CATEGORY_NOT_FOUND`: no category `targetId`.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN,
                                    404,
                                    "`CATEGORY_NOT_FOUND`: no category with the id in the path."))),
            entry(
                    "GET /api/v1/admin/media/usage",
                    new Described(
                            "Image storage used",
                            "ADMIN only. `usedBytes` is what the quota is checked against when an image is stored: covers, "
                                    + "gallery photos and body images together. `maxBytes` is the configured quota "
                                    + "(`MEDIA_MAX_TOTAL_SIZE`), `count` the number of images.",
                            Map.of(401, UNAUTHENTICATED, 403, NOT_ADMIN))),
            entry(
                    "PATCH /api/v1/admin/comments/{id}/status",
                    new Described(
                            "Hide or restore a comment",
                            "ADMIN only. `HIDDEN` hides a visible comment and `VISIBLE` restores a hidden one; asking for the "
                                    + "current status changes nothing. Other body fields are ignored.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `status` missing, unknown, or `DELETED` (delete with DELETE).",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN,
                                    404,
                                    "`COMMENT_NOT_FOUND`: no such comment.",
                                    409,
                                    "`RESOURCE_CONFLICT`: the comment is deleted, or changed status meanwhile."))),
            entry(
                    "DELETE /api/v1/admin/comments/{id}",
                    new Described(
                            "Delete a comment",
                            "ADMIN only. Soft delete of a visible or hidden comment; a 204 again for one already deleted.",
                            Map.of(
                                    400,
                                    MALFORMED_ID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN,
                                    404,
                                    "`COMMENT_NOT_FOUND`: no such comment."))),
            entry(
                    "GET /api/v1/admin/users",
                    new Described(
                            "Accounts",
                            "ADMIN only. Newest first. `q` matches GitHub login or display name, never email; `role` and "
                                    + "`status` filter. `size` is clamped to 1–100. No email, password hash or GitHub id is "
                                    + "returned.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: unknown `role` or `status`.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN))),
            entry(
                    "PATCH /api/v1/admin/users/{id}/status",
                    new Described(
                            "Suspend or reactivate a reader",
                            "ADMIN only, for accounts with role USER other than the caller's own. `SUSPENDED` also revokes "
                                    + "the reader's refresh tokens, and every write with a still valid access token is "
                                    + "refused at once. Only `status` is read from the body: the role changes only through "
                                    + "`PATCH /api/v1/admin/users/{id}/role` or by approving an author application.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `status` missing or unknown.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN,
                                    404,
                                    "`USER_NOT_FOUND`: no such account.",
                                    409,
                                    "`USER_NOT_SUSPENDABLE`: an ADMIN or AUTHOR account, or the caller's own."))),
            entry(
                    "PATCH /api/v1/admin/users/{id}/role",
                    new Described(
                            "Change an account's role",
                            "ADMIN only; the caller's own account included. `role` is `ADMIN`, `AUTHOR` or `USER`. A change "
                                    + "revokes the account's refresh tokens, so it signs "
                                    + "in again and gets a token with the new role; an ADMIN or AUTHOR access token it still "
                                    + "holds follows the new role at once, a USER one does not. Asking for the current role "
                                    + "changes nothing and revokes nothing. By default at most 20 changes per 10 minutes per "
                                    + "administrator. A change to or from ADMIN, or one that makes a reader an AUTHOR, is a "
                                    + "step-up: " + STEP_UP_NOTE
                                    + " The body then also takes the administrator's own `code` "
                                    + "(an authenticator code or a recovery code), which is ignored for any other change. A "
                                    + "promotion to ADMIN also deletes the account's two-step enrollment: it enrols again, "
                                    + "with the operator's enrollment code, at its next sign-in.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: malformed id, or `role` missing or unknown.",
                                    401,
                                    UNAUTHENTICATED
                                            + " `REAUTHENTICATION_REQUIRED` or `MFA_CODE_INVALID` (also when the "
                                            + "`code` is missing) for a change that is a step-up.",
                                    403,
                                    NOT_ADMIN + " `MFA_FROZEN`: the second step of the administrator is locked.",
                                    404,
                                    "`USER_NOT_FOUND`: no such account.",
                                    409,
                                    "`LAST_ADMIN`: the account is the last active ADMIN; promote another one first. "
                                            + "`SITE_OWNER_PROTECTED`: only the site owner changes the site owner's role. "
                                            + "`ROLE_TARGET_SUSPENDED`: a suspended account can only become USER.",
                                    429,
                                    ROLE_CHANGES_LIMITED + " `MFA_RATE_LIMITED`: too many wrong codes just now."))),
            entry(
                    "GET /api/v1/me/author-application",
                    new Described(
                            "Your author application",
                            "Your latest application to become an author, null if you never applied; never anyone else's. "
                                    + "`canApply` tells whether a new one would be accepted now: you are a reader (role USER), "
                                    + "have no pending application, and were not rejected in the last 30 days. "
                                    + "`reapplyAfter` is when those 30 days end, null when no rejection holds you back.",
                            Map.of(401, UNAUTHENTICATED, 403, SUSPENDED))),
            entry(
                    "POST /api/v1/me/author-application",
                    new Described(
                            "Apply to become an author",
                            "Readers (role USER) only. `motivation` is optional plain text, cleaned like a comment and at "
                                    + "most 500 characters after that; blank means none. Every other body field is ignored. "
                                    + "One pending application per account; after a rejection, the next one is accepted 30 "
                                    + "days after the decision. Nothing changes until an administrator decides. Limit: 5 per "
                                    + "hour per user.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `motivation` longer than 500 characters after cleaning.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED,
                                    409,
                                    "`AUTHOR_APPLICATION_PENDING`: you already have a pending application. "
                                            + "`AUTHOR_APPLICATION_COOLDOWN`: rejected less than 30 days ago. "
                                            + "`AUTHOR_APPLICATION_NOT_ALLOWED`: the account is already an AUTHOR or ADMIN.",
                                    429,
                                    RATE_LIMITED))),
            entry(
                    "GET /api/v1/me/bookmarks",
                    new Described(
                            "Your bookmarks",
                            "Posts you saved, most recently saved first, as the same summaries as the public post list; never "
                                    + "anyone else's. Published posts only: a post unpublished later leaves the page and the "
                                    + "totals, and comes back if it is published again; deleting a post deletes its bookmarks. "
                                    + "`size` is clamped to 1–50.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: a `page` or `size` that is not a number.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED))),
            entry(
                    "GET /api/v1/me/bookmarks/{slug}",
                    new Described(
                            "Whether you saved a post",
                            "`bookmarked` tells whether this published post is in your bookmarks.",
                            Map.of(401, UNAUTHENTICATED, 403, SUSPENDED, 404, POST_NOT_FOUND))),
            entry(
                    "PUT /api/v1/me/bookmarks/{slug}",
                    new Described(
                            "Bookmark a post",
                            "A published post. Idempotent, no request body; answers the stored state. Limit: 30 per minute per "
                                    + "user, shared with removing a bookmark.",
                            Map.of(401, UNAUTHENTICATED, 403, SUSPENDED, 404, POST_NOT_FOUND, 429, RATE_LIMITED))),
            entry(
                    "DELETE /api/v1/me/bookmarks/{slug}",
                    new Described(
                            "Remove a bookmark",
                            "Idempotent; answers 200 with the stored state, not 204. Also removes your bookmark of a post "
                                    + "unpublished since, so that it does not come back when the post is published again.",
                            Map.of(
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    SUSPENDED,
                                    404,
                                    "`POST_NOT_FOUND`: no published post with this slug, and none in your bookmarks.",
                                    429,
                                    RATE_LIMITED))),
            entry(
                    "GET /api/v1/admin/author-applications",
                    new Described(
                            "Author applications",
                            "ADMIN only. `status` filters, `PENDING` by default: pending ones oldest first, decided ones "
                                    + "most recently decided first. `size` is clamped to 1–100. Each comes with the "
                                    + "applicant's current role and status; never an email.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: unknown `status`.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN))),
            entry(
                    "POST /api/v1/admin/author-applications/{id}/approve",
                    new Described(
                            "Approve an author application",
                            "ADMIN only, never for your own application. Makes a reader an AUTHOR through the same role "
                                    + "change as `PATCH /api/v1/admin/users/{id}/role`: their refresh tokens are revoked, so "
                                    + "they sign in again and get an AUTHOR token. An applicant who is already an AUTHOR or "
                                    + "ADMIN keeps that role. Approving an approved application changes nothing. Counts "
                                    + "against the role-change limit. Making a reader an author is a step-up: "
                                    + STEP_UP_NOTE + " The optional body takes the administrator's own `code` (an "
                                    + "authenticator code or a recovery code), which is only read when a reader is "
                                    + "promoted.",
                            Map.of(
                                    400,
                                    MALFORMED_ID,
                                    401,
                                    UNAUTHENTICATED
                                            + " `REAUTHENTICATION_REQUIRED` or `MFA_CODE_INVALID` (also when the "
                                            + "`code` is missing) for the promotion of a reader.",
                                    403,
                                    "`FORBIDDEN`: not an ADMIN token, or your own application. `MFA_FROZEN`: the second "
                                            + "step of the administrator is locked.",
                                    404,
                                    APPLICATION_NOT_FOUND,
                                    409,
                                    "`AUTHOR_APPLICATION_DECIDED`: the application was rejected. "
                                            + "`ROLE_TARGET_SUSPENDED`: the applicant is suspended; reactivate them first.",
                                    429,
                                    ROLE_CHANGES_LIMITED + " `MFA_RATE_LIMITED`: too many wrong codes just now."))),
            entry(
                    "POST /api/v1/admin/author-applications/{id}/reject",
                    new Described(
                            "Reject an author application",
                            "ADMIN only. Changes no role; the applicant may apply again 30 days later. Rejecting a rejected "
                                    + "application changes nothing.",
                            Map.of(
                                    400,
                                    MALFORMED_ID,
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN,
                                    404,
                                    APPLICATION_NOT_FOUND,
                                    409,
                                    "`AUTHOR_APPLICATION_DECIDED`: the application was approved."))),
            entry(
                    "POST /api/v1/posts/{slug}/views",
                    new Described(
                            "Count a view",
                            "Called by the frontend's server after it filtered bots, limited calls per IP and deduplicated "
                                    + "per reader; the backend counts every accepted call once. Adds one to the post's total "
                                    + "and to its count for today, in the analytics time zone, under one source group. "
                                    + "`X-View-Token` must match when the backend has a views token. `X-View-Referrer` is "
                                    + "optional: the host (no scheme, port or path) of the page that linked to the post. It is "
                                    + "untrusted, only mapped to a group (`direct` when absent, `other` when malformed or "
                                    + "unknown) and never stored.",
                            Map.of(
                                    403,
                                    "`FORBIDDEN`: a views token is configured and `X-View-Token` is missing or wrong.",
                                    404,
                                    POST_NOT_FOUND))),
            entry(
                    "GET /api/v1/admin/analytics",
                    new Described(
                            "View analytics",
                            "ADMIN sees the whole site; AUTHOR only their own posts, in any status. Counts are accepted "
                                    + "views (after the frontend's bot filter, per-IP limit and dedupe), never unique visitors "
                                    + "or sessions. `from` and `to` are dates (YYYY-MM-DD) in `timeZone`, by default the 30 "
                                    + "days ending today. `daily` has every day of the range, 0 when there was no view; "
                                    + "`topPosts` the 10 most viewed posts in the range, ties by title then id; `sources` all "
                                    + "six groups in a fixed order. `since` is the first day with daily data in scope, whatever "
                                    + "the range, null when there is none: daily data starts when this feature was deployed. "
                                    + "`allTimeViews` comes from the per-post totals, so it also counts views before `since`.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `from` or `to` is not a date (YYYY-MM-DD), `from` is after "
                                            + "`to`, `to` is after today in `timeZone`, or the range covers more than 366 days.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    "`FORBIDDEN`: not an ADMIN or AUTHOR token."))),
            entry(
                    "POST /api/v1/newsletter/subscriptions",
                    new Described(
                            "Subscribe to new posts by email",
                            "Double opt-in. The address is trimmed, NFC-normalized and lowercased, and must then be ASCII, at "
                                    + "most 254 characters, with a dot in the domain; a `+tag` makes a different address. Every "
                                    + "well-formed address gets the same 202 and body, whether it is new, pending, confirmed, "
                                    + "unsubscribed before, or over the limit of 3 signups per address per hour, so the answer "
                                    + "never tells who subscribed. Nothing is sent during the call: a background worker mails a "
                                    + "confirmation link valid for 48 hours to a new or pending address, and nothing to a "
                                    + "confirmed one. An unconfirmed signup is deleted after 7 days.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `email` missing or not a usable address; the message never "
                                            + "repeats it."))),
            entry(
                    "POST /api/v1/newsletter/confirm",
                    new Described(
                            "Confirm a newsletter subscription",
                            "`token` comes from the confirmation link. Single use, valid for 48 hours; a newer confirmation "
                                    + "mail replaces the previous token. Confirming also removes the address from the "
                                    + "unsubscribed list.",
                            Map.of(
                                    400,
                                    "`NEWSLETTER_TOKEN_INVALID`: one answer for a malformed, unknown, expired or already "
                                            + "used token. `VALIDATION_ERROR` when the body is not JSON.",
                                    429,
                                    NEWSLETTER_TOKEN_LIMITED))),
            entry(
                    "POST /api/v1/newsletter/unsubscribe",
                    new Described(
                            "Unsubscribe from the newsletter",
                            "`token` comes from the unsubscribe link of any newsletter mail; no sign-in. It never expires. The "
                                    + "address is deleted and only a keyed hash of it is kept, so it gets no more mail until it "
                                    + "subscribes and confirms again. Already unsubscribed: 200 again.",
                            Map.of(
                                    400,
                                    "`NEWSLETTER_TOKEN_INVALID`: malformed or forged token. `VALIDATION_ERROR` when the "
                                            + "body is not JSON.",
                                    429,
                                    NEWSLETTER_TOKEN_LIMITED))),
            entry(
                    "GET /api/v1/admin/newsletter",
                    new Described(
                            "Newsletter statistics",
                            "ADMIN only. Counts only, never an address: subscribers by status, unsubscribed addresses "
                                    + "(`suppressed`), the 10 latest first-publish mailings (`status` is `PENDING`, `EXPANDED`, "
                                    + "`HELD` for an AUTHOR's post waiting for an administrator, or `DISCARDED`) with their "
                                    + "deliveries by status, and "
                                    + "retrying or abandoned deliveries by safe reason code (`CONNECTION_FAILED`, `TIMEOUT`, "
                                    + "`AUTH_FAILED`, `REJECTED`, `INVALID_ADDRESS`, `UNKNOWN`, `SUPPRESSED`). A failed delivery "
                                    + "is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, then abandoned.",
                            Map.of(401, UNAUTHENTICATED, 403, NOT_ADMIN))),
            entry(
                    "GET /api/v1/admin/newsletter/held",
                    new Described(
                            "Newsletters waiting for approval",
                            "ADMIN only. The first-publish mailings of posts that an AUTHOR published, oldest first (at "
                                    + "most 100): `title` and `excerpt` are exactly what subscribers would read (one-line "
                                    + "subject, excerpt cut at 300 characters), with the author's display name, the post "
                                    + "language, whether the post is published now and how many confirmed subscribers of "
                                    + "that language would get the mail, and a `version` that stands for the text shown, to "
                                    + "send back with the release. Never an address.",
                            Map.of(401, UNAUTHENTICATED, 403, NOT_ADMIN))),
            entry(
                    "POST /api/v1/admin/newsletter/issues/{postId}/release",
                    new Described(
                            "Release a held newsletter",
                            "ADMIN only. Body `{\"version\": \"...\"}`: the `version` that the held list returned for "
                                    + "this post, which stands for the text the administrator read. Queues the mailing for the "
                                    + "confirmed subscribers of the post language. The subject, excerpt and language of the "
                                    + "moment are stored with it and are the ones mailed, whatever the post says later; a post "
                                    + "that changed since the list was loaded is not released. A post that is not published "
                                    + "waits until it is published again.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: no `version`, or one that is not text of up to 128 characters.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN,
                                    404,
                                    "`NEWSLETTER_ISSUE_NOT_FOUND`: no such post, or its mailing is not held (released or "
                                            + "discarded already, or queued by an ADMIN).",
                                    409,
                                    "`NEWSLETTER_ISSUE_CHANGED`: the address, subject, excerpt or language of the post "
                                            + "changed after the list was loaded. Nothing was released; reload the list."))),
            entry(
                    "POST /api/v1/admin/newsletter/issues/{postId}/discard",
                    new Described(
                            "Discard a held newsletter",
                            "ADMIN only. The mailing is kept as a record (`DISCARDED`) and never sent; the post is not "
                                    + "changed.",
                            Map.of(
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN,
                                    404,
                                    "`NEWSLETTER_ISSUE_NOT_FOUND`: no such post, or its mailing is not held."))),
            entry(
                    "POST /api/v1/admin/search/reindex",
                    new Described(
                            "Rebuild the search index",
                            "ADMIN only. `dryRun` defaults to `true`: counts only (documents per type the new index would "
                                    + "hold, the live index's document count, pending and failed sync rows), nothing written. "
                                    + "`dryRun=false` builds `<MEILI_INDEX_NAME>_build` from PostgreSQL in batches, checks its "
                                    + "document count, swaps it with the live index (or renames it when there is none), deletes "
                                    + "the old one and reconciles at once to catch changes made meanwhile; the live index is "
                                    + "never dropped before the new one is complete. Running it again gives the same index. "
                                    + "Dry runs and real runs count together: by default 3 per 10 minutes per administrator.",
                            Map.of(
                                    400,
                                    "`VALIDATION_ERROR`: `dryRun` is not `true` or `false`.",
                                    401,
                                    UNAUTHENTICATED,
                                    403,
                                    NOT_ADMIN,
                                    409,
                                    "`SEARCH_NOT_CONFIGURED`: a real run needs `MEILI_URL` and `MEILI_MASTER_KEY`. "
                                            + "`SEARCH_REINDEX_RUNNING`: a reindex or reconciliation is running.",
                                    429,
                                    "`RATE_LIMITED`: this administrator reindexed too often; retry later.",
                                    502,
                                    "`SEARCH_REINDEX_FAILED`: Meilisearch failed, rejected documents or holds a "
                                            + "different count before the swap; the live index was not changed."))),
            entry(
                    "GET /api/v1/admin/search/status",
                    new Described(
                            "Search status",
                            "ADMIN only. The engine answering `GET /api/v1/search`, whether indexing is on, whether "
                                    + "Meilisearch answers and its version, the index's documents by type next to PostgreSQL's, "
                                    + "sync rows (pending, processing, failed, oldest pending age), the last reconciliation and "
                                    + "the counters since startup (degraded answers with the last failure code, stale hits "
                                    + "dropped, deep pages served by PostgreSQL). Never a key, a URL or query text.",
                            Map.of(401, UNAUTHENTICATED, 403, NOT_ADMIN))));

    private enum Access {
        NONE,
        OPTIONAL,
        REQUIRED
    }

    @Bean
    public OpenAPI blogOpenApi() {
        return new OpenAPI()
                .info(new Info().title("Personal Blog API").version("v1").description(DESCRIPTION))
                .components(
                        new Components()
                                .addSecuritySchemes(
                                        BEARER,
                                        new SecurityScheme()
                                                .type(SecurityScheme.Type.HTTP)
                                                .scheme("bearer")
                                                .bearerFormat("JWT")
                                                .description(
                                                        "Access token (HS256 JWT, 15 minutes) from `POST /api/v1/auth/login`, "
                                                                + "`POST /api/v1/auth/refresh`, or a GitHub sign-in through the frontend.")));
    }

    /**
     * Runs once every time springdoc builds the documentation, on the very object it just built; it only decorates
     * existing operations and schemas, it adds no path. If a schema is renamed while the table below still uses the old
     * name, it throws: the documentation breaks right in OpenApiConfigIT, instead of silently losing its descriptions.
     *
     * The OpenAPI version is read from the springdoc configuration, which selects the JSON writer, not from
     * {@code openApi.getSpecVersion()}: springdoc copies the {@link #blogOpenApi()} bean through JSON, so the copy keeps
     * the default V30 even though the document is written as 3.1. ObjectProvider because with springdoc off
     * (SPRINGDOC_ENABLED=false) there is no configuration bean, and nobody calls this customizer either.
     */
    @Bean
    public OpenApiCustomizer apiContractCustomizer(ObjectProvider<SpringDocConfigProperties> springDoc) {
        return openApi -> {
            SpringDocConfigProperties properties = springDoc.getIfAvailable();
            boolean openapi31 = properties == null || properties.isOpenapi31();
            @SuppressWarnings("rawtypes")
            Map<String, Schema> schemas = openApi.getComponents().getSchemas();
            schemas.put(ERROR_SCHEMA, errorResponseSchema());
            describeSchemas(schemas, openapi31);
            openApi.getPaths()
                    .forEach((path, item) -> item.readOperationsMap()
                            .forEach((method, operation) -> describe(method.name() + " " + path, path, operation)));
            describeLoginAnswers(openApi);
        };
    }

    /**
     * The login answers two different bodies at two statuses, which the Java return type cannot say: {@code 200} the token
     * pair, {@code 202} a challenge for the second step.
     */
    private static void describeLoginAnswers(OpenAPI openApi) {
        PathItem login = openApi.getPaths().get("/api/v1/auth/login");
        if (login == null || login.getPost() == null) {
            return;
        }
        login.getPost()
                .getResponses()
                .addApiResponse(
                        "200",
                        dataResponse("The token pair: no second factor applies to this account.", "TokenResponse"));
        login.getPost()
                .getResponses()
                .addApiResponse(
                        "202",
                        dataResponse(
                                "A second step is due: no token, only the challenge to hand back with the code.",
                                "MfaChallengeResponse"));
    }

    /** {@code {"data": <schema>}}: the success envelope of this API, written by hand where the Java type is not enough. */
    private static ApiResponse dataResponse(String description, String schemaName) {
        Schema<Object> data = new Schema<>();
        data.set$ref(schemaName);
        Schema<Object> envelope = typed("object");
        envelope.addProperty("data", data);
        envelope.setRequired(List.of("data"));
        return new ApiResponse()
                .description(description)
                .content(new Content().addMediaType("application/json", new MediaType().schema(envelope)));
    }

    /** The keys of every operation the table describes, so OpenApiConfigIT can check each operation really exists. */
    static Set<String> describedOperations() {
        return OPERATIONS.keySet();
    }

    // --- Operations ------------------------------------------------------------------------------------

    private static void describe(String key, String path, Operation operation) {
        Access access = path.startsWith("/api/v1/admin/") || TOKEN_REQUIRED.contains(key)
                ? Access.REQUIRED
                : TOKEN_OPTIONAL.contains(key) ? Access.OPTIONAL : Access.NONE;
        switch (access) {
            case REQUIRED -> operation.setSecurity(List.of(new SecurityRequirement().addList(BEARER)));
            // An empty requirement means "nothing needed": callable anonymously, send the token if there is one.
            case OPTIONAL ->
                operation.setSecurity(List.of(new SecurityRequirement(), new SecurityRequirement().addList(BEARER)));
            case NONE -> {}
        }

        Described described = OPERATIONS.get(key);
        Map<Integer, String> errors = Map.of();
        if (described != null) {
            operation.setSummary(described.summary());
            operation.setDescription(described.description());
            errors = described.errors();
        } else if (access == Access.REQUIRED) {
            errors = TOKEN_ERRORS;
        }
        new TreeMap<>(errors)
                .forEach((status, text) ->
                        operation.getResponses().addApiResponse(String.valueOf(status), errorResponse(text)));
    }

    /**
     * The 409 of a duplicate submission. The guard is per person (CommentRepository.existsRecentRootDuplicate and
     * existsRecentReplyDuplicate), not per post: the same text from someone else is still accepted, and a deleted
     * comment does not count.
     */
    private static String commentDuplicate(String where) {
        return "`COMMENT_DUPLICATE`: you already posted the same content " + where + " less than 10 minutes ago, "
                + "and have not deleted it. The same text from another account is accepted.";
    }

    /** The error body is always JSON, even when the request only accepts images (GlobalExceptionHandler presets the Content-Type). */
    private static ApiResponse errorResponse(String description) {
        Schema<Object> envelope = new Schema<>();
        envelope.set$ref(ERROR_SCHEMA);
        return new ApiResponse()
                .description(description)
                .content(new Content().addMediaType("application/json", new MediaType().schema(envelope)));
    }

    // --- Schemas ---------------------------------------------------------------------------------------

    /**
     * Jackson writes every field of these records, null ones included, so every field is always present (required);
     * a field that is listed may be null; a status string only accepts the values of the matching enum. This matches the
     * frontend types, and OpenApiConfigIT compares every real answer against these schemas.
     */
    @SuppressWarnings("rawtypes")
    private static void describeSchemas(Map<String, Schema> schemas, boolean openapi31) {
        List<String> commentStatus = names(CommentStatus.values());
        List<String> role = names(UserRole.values());
        List<String> userStatus = names(UserStatus.values());

        shape(schemas, "CommentResponse", openapi31, Map.of("status", commentStatus), "content", "author", "editedAt");
        shape(schemas, "CommentAuthorResponse", openapi31, Map.of(), "githubLogin", "avatarUrl", "profileSlug");
        shape(schemas, "CommentThreadResponse", openapi31, Map.of());
        shape(schemas, "CommentPage", openapi31, Map.of(), "nextCursor");
        shape(schemas, "LikeResponse", openapi31, Map.of());
        shape(schemas, "NotificationPage", openapi31, Map.of(), "nextCursor", "headCursor");
        shape(
                schemas,
                "NotificationResponse",
                openapi31,
                Map.of("type", names(NotificationType.values())),
                "commentId",
                "excerpt");
        shape(schemas, "NotificationActorResponse", openapi31, Map.of(), "githubLogin", "avatarUrl");
        shape(schemas, "NotificationPostResponse", openapi31, Map.of());
        shape(schemas, "UnreadCountResponse", openapi31, Map.of());
        shape(
                schemas,
                "CommentAdminResponse",
                openapi31,
                Map.of(
                        "status", commentStatus,
                        "postStatus", names(PostStatus.values()),
                        "authorRole", role,
                        "authorStatus", userStatus),
                "editedAt",
                "authorGithubLogin",
                "authorAvatarUrl");
        shape(
                schemas,
                "UserAdminResponse",
                openapi31,
                Map.of("role", role, "status", userStatus),
                "githubLogin",
                "avatarUrl",
                "lastLoginAt");
        shape(
                schemas,
                "CurrentUserResponse",
                openapi31,
                Map.of("role", role, "status", userStatus),
                "email",
                "githubLogin",
                "avatarUrl");
        shape(schemas, "TokenResponse", openapi31, Map.of());
        // Two-step verification. The challenge of the 202 answer of the login is the type of no controller method, so
        // its
        // schema is registered here; the others come from the endpoints of the second step.
        ModelConverters.getInstance(openapi31)
                .readAll(MfaChallengeResponse.class)
                .forEach(schemas::putIfAbsent);
        shape(schemas, "MfaChallengeResponse", openapi31, Map.of("purpose", List.of("VERIFY", "ENROLL")));
        shape(schemas, "MfaVerifiedResponse", openapi31, Map.of());
        shape(schemas, "MfaEnrollmentSecretResponse", openapi31, Map.of());
        shape(schemas, "MfaEnrollmentConfirmedResponse", openapi31, Map.of());
        shape(schemas, "MfaStatusResponse", openapi31, Map.of());
        shape(schemas, "MfaRecoveryCodesResponse", openapi31, Map.of());
        shape(schemas, "PostRedirectResponse", openapi31, Map.of());
        // Editorial: images (also cover and gallery images everywhere else), storage usage, revisions, merge results
        // and
        // the tag or category a merge result carries (also the tags and categories of every post).
        shape(schemas, "MediaResponse", openapi31, Map.of(), "altText", "dominantColor");
        shape(schemas, "MediaUsageResponse", openapi31, Map.of());
        shape(schemas, "PostRevisionSummaryResponse", openapi31, Map.of());
        shape(schemas, "PostRevisionResponse", openapi31, Map.of(), "excerpt");
        shape(schemas, "TagMergeResponse", openapi31, Map.of());
        shape(schemas, "CategoryMergeResponse", openapi31, Map.of());
        shape(schemas, "TagResponse", openapi31, Map.of());
        shape(schemas, "CategoryResponse", openapi31, Map.of(), "description");
        // The public author of every post DTO (PostResponse, PostSummaryResponse).
        shape(schemas, "PostAuthorResponse", openapi31, Map.of(), "githubLogin", "avatarUrl", "profileSlug");
        schema(schemas, "PostAuthorResponse")
                .setDescription("The post's public author: a display name and, once "
                        + "the account is linked to GitHub, its login and avatar. Never an id, an email or a role. "
                        + "`siteOwner` is true only for the site owner's account (the seeded administrator), not for every "
                        + "ADMIN; a comment author's `siteOwner` follows the same rule. `profileSlug` is the public profile "
                        + "(`GET /api/v1/users/{slug}`), null for a suspended account, which has none; a comment author's "
                        + "`profileSlug` follows the same rule.");
        // The public profile.
        shape(schemas, "UserProfileResponse", openapi31, Map.of(), "githubLogin", "avatarUrl");
        // Author applications, as the applicant sees them and as the admin sees them.
        List<String> applicationStatus = names(AuthorApplicationStatus.values());
        shape(
                schemas,
                "AuthorApplicationResponse",
                openapi31,
                Map.of("status", applicationStatus),
                "motivation",
                "decidedAt");
        shape(schemas, "MyAuthorApplicationResponse", openapi31, Map.of(), "application", "reapplyAfter");
        shape(
                schemas,
                "AuthorApplicationAdminResponse",
                openapi31,
                Map.of("status", applicationStatus),
                "motivation",
                "decidedAt");
        shape(
                schemas,
                "AuthorApplicantResponse",
                openapi31,
                Map.of("role", role, "status", userStatus),
                "githubLogin",
                "avatarUrl");
        // The bookmark state of a post.
        shape(schemas, "BookmarkResponse", openapi31, Map.of());
        // The view report.
        shape(schemas, "AnalyticsResponse", openapi31, Map.of(), "since");
        shape(schemas, "AnalyticsTotals", openapi31, Map.of());
        shape(schemas, "AnalyticsDay", openapi31, Map.of());
        shape(schemas, "AnalyticsTopPost", openapi31, Map.of("status", names(PostStatus.values())));
        shape(
                schemas,
                "AnalyticsSource",
                openapi31,
                Map.of(
                        "source",
                        Arrays.stream(ViewSource.values())
                                .map(ViewSource::value)
                                .toList()));
        // Newsletter.
        shape(schemas, "NewsletterStateResponse", openapi31, Map.of());
        shape(schemas, "NewsletterStatsResponse", openapi31, Map.of());
        shape(schemas, "NewsletterSubscriberCounts", openapi31, Map.of());
        shape(schemas, "NewsletterIssueStats", openapi31, Map.of());
        shape(schemas, "NewsletterFailureCount", openapi31, Map.of());

        // The Java type of the PATCH body is the whole CommentStatus, but DELETED there is a 400: deleting has its own
        // DELETE path.
        replaceWithEnum(
                schema(schemas, "CommentStatusRequest"), "status", names(CommentStatus.VISIBLE, CommentStatus.HIDDEN));
    }

    @SuppressWarnings("rawtypes")
    private static void shape(
            Map<String, Schema> schemas,
            String name,
            boolean openapi31,
            Map<String, List<String>> enums,
            String... nullable) {
        Schema<?> schema = schema(schemas, name);
        schema.setRequired(new ArrayList<>(schema.getProperties().keySet()));
        enums.forEach((property, values) -> replaceWithEnum(schema, property, values));
        for (String property : nullable) {
            allowNull(schema, property, openapi31);
        }
    }

    /**
     * Replaces the field's schema instead of editing it: springdoc may share one schema object in several places (the
     * CommentStatus enum is the filter parameter of the moderation list, which accepts DELETED too).
     */
    private static void replaceWithEnum(Schema<?> owner, String property, List<String> values) {
        Schema<?> original = property(owner, property);
        Schema<Object> restricted = typed(typeOf(original));
        restricted.setDescription(original.getDescription());
        restricted.setEnum(new ArrayList<>(values));
        owner.getProperties().put(property, restricted);
    }

    /**
     * OpenAPI 3.1 says "may be null" with {@code "null"} in {@code type}, or {@code anyOf} with {@code {type: null}}
     * for a {@code $ref}; 3.0 uses {@code nullable}. Swagger's 3.1 writer ignores {@code nullable} and {@code type}, the
     * 3.0 writer ignores {@code types}: a plain field carries both ways, only a {@code $ref} must choose by version.
     */
    private static void allowNull(Schema<?> owner, String property, boolean openapi31) {
        Schema<?> original = property(owner, property);
        if (original.getAnyOf() != null
                || original.getAllOf() != null
                || (original.getTypes() != null && original.getTypes().contains("null"))) {
            // Already nullable: if the customizer runs again on the same document it does not wrap another layer.
            return;
        }
        Schema<Object> nullable;
        if (original.get$ref() != null) {
            Schema<Object> reference = new Schema<>();
            reference.set$ref(original.get$ref());
            nullable = new Schema<>();
            if (openapi31) {
                nullable.setAnyOf(new ArrayList<>(List.of(reference, typed("null"))));
            } else {
                nullable.setAllOf(new ArrayList<>(List.of(reference)));
                nullable.setNullable(true);
            }
        } else {
            nullable = typed(typeOf(original));
            nullable.setFormat(original.getFormat());
            nullable.addType("null");
            nullable.setNullable(true);
        }
        nullable.setDescription(original.getDescription());
        owner.getProperties().put(property, nullable);
    }

    /** {@code {"error": {"code", "message", "traceId"}}}: GlobalExceptionHandler, entry point, access denied handler. */
    private static Schema<Object> errorResponseSchema() {
        Schema<Object> code = typed("string");
        code.setEnum(new ArrayList<>(names(ErrorCode.values())));
        code.setDescription("Stable machine-readable code: the field a client branches on.");
        Schema<Object> message = typed("string");
        message.setDescription("English, for developers and logs. Never quotes a token, an email or comment content.");
        Schema<Object> traceId = typed("string");
        traceId.setFormat("uuid");
        traceId.setDescription("Also printed on the server's log line for this failure.");

        Schema<Object> error = typed("object");
        error.addProperty("code", code);
        error.addProperty("message", message);
        error.addProperty("traceId", traceId);
        error.setRequired(List.of("code", "message", "traceId"));

        Schema<Object> envelope = typed("object");
        envelope.addProperty("error", error);
        envelope.setRequired(List.of("error"));
        envelope.setDescription("Every failure of this API, whatever produced it: a controller, request validation "
                + "or the security filters.");
        return envelope;
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    /** A typed schema that serializes in both versions: the 3.0 writer reads {@code type}, the 3.1 writer reads {@code types}. */
    private static Schema<Object> typed(String type) {
        Schema<Object> schema = new Schema<>();
        schema.setType(type);
        schema.setTypes(new LinkedHashSet<>(List.of(type)));
        return schema;
    }

    private static String typeOf(Schema<?> schema) {
        if (schema.getType() != null) {
            return schema.getType();
        }
        if (schema.getTypes() != null && !schema.getTypes().isEmpty()) {
            return schema.getTypes().iterator().next();
        }
        throw new IllegalStateException("OpenAPI: a property schema without a type: " + schema);
    }

    @SuppressWarnings("rawtypes")
    private static Schema<?> schema(Map<String, Schema> schemas, String name) {
        Schema<?> schema = schemas.get(name);
        if (schema == null || schema.getProperties() == null) {
            throw new IllegalStateException("OpenAPI: no schema " + name + " to describe; was the DTO renamed?");
        }
        return schema;
    }

    private static Schema<?> property(Schema<?> owner, String name) {
        Schema<?> property = owner.getProperties().get(name);
        if (property == null) {
            throw new IllegalStateException("OpenAPI: schema " + owner.getName() + " has no property " + name);
        }
        return property;
    }

    private static List<String> names(Enum<?>... values) {
        return Arrays.stream(values).map(Enum::name).toList();
    }
}
