package com.blog.auth.service;

import java.time.Instant;
import java.util.Objects;

/**
 * What a login session can prove, stored on its refresh token row and copied unchanged on rotation
 * ({@code refresh_tokens.authenticated_at} and {@code mfa_verified_at}, migration V44).
 *
 * @param authenticatedAt when the person last signed in with a first factor: the start of the session. It becomes the
 *                        {@code auth_time} claim of the session's access tokens and is never refreshed by rotation, so a
 *                        session that is still alive 30 days later never looks freshly authenticated
 * @param mfaVerifiedAt   when a second factor was verified for this session; null means none was. A session without it
 *                        cannot rotate once its account requires two-step verification
 */
public record SessionProof(Instant authenticatedAt, Instant mfaVerifiedAt) {

    public SessionProof {
        Objects.requireNonNull(authenticatedAt, "authenticatedAt");
    }

    /** A session that has passed the first factor only (a reader, an author without two-step verification). */
    public static SessionProof firstFactor(Instant now) {
        return new SessionProof(now, null);
    }

    /** A session that has just passed the first factor and a second factor. */
    public static SessionProof verified(Instant now) {
        return new SessionProof(now, now);
    }

    /** The same session start with a second factor verified at {@code now}: a signed-in request that verified a code. */
    public SessionProof withVerificationAt(Instant now) {
        return new SessionProof(authenticatedAt, now);
    }
}
