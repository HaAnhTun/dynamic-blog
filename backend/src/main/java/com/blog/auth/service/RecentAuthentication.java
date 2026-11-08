package com.blog.auth.service;

import com.blog.auth.mfa.MfaProperties;
import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.time.Clock;
import java.time.Instant;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * Re-authentication before a change of two-step verification or of the password (ASVS 5.0 7.5.1): enrolling an
 * authenticator revokes the other sessions, so a short theft of a session would otherwise become a durable takeover. The
 * session must have started with a first-factor sign-in within {@code app.mfa.reauth-window} (10 minutes by default).
 *
 * The time that counts is the start of the session (migration V44), read from the session row, not from the token:
 * rotation copies it and never refreshes it, so a session that is still alive 30 days later never looks freshly
 * authenticated, and "signing in again" is the only way to a new one. The {@code auth_time} claim of the access token is
 * informational only: whoever could write one (a holder of the signing secret) could write a fresh one, and the row of
 * the session of this very account is the only thing that cannot be forged that way (audit 112). A token without a live
 * session of its own account is stale: the gate fails closed.
 *
 * It is the FIRST check of every such mutation, before any code is looked at or counted.
 */
@Component
@RequiredArgsConstructor
public class RecentAuthentication {

    private final MfaProperties properties;
    private final RefreshTokenService refreshTokenService;
    private final Clock clock;

    /** @throws ApiException 401 {@code REAUTHENTICATION_REQUIRED} when the session started too long ago, or says nothing */
    public void require() {
        Instant now = clock.instant();
        boolean recent = AuthenticatedUser.currentUserId()
                .flatMap(userId -> AuthenticatedUser.sessionId()
                        .flatMap(sessionId -> refreshTokenService.proofOfSession(userId, sessionId)))
                .map(proof ->
                        !proof.authenticatedAt().plus(properties.reauthWindow()).isBefore(now))
                .orElse(false);
        if (!recent) {
            throw new ApiException(
                    ErrorCode.REAUTHENTICATION_REQUIRED, HttpStatus.UNAUTHORIZED, "Sign in again to continue");
        }
    }
}
