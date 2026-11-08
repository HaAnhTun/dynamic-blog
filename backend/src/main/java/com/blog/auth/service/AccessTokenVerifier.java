package com.blog.auth.service;

import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserAccess;
import com.blog.user.repository.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DataAccessException;
import org.springframework.security.authentication.AuthenticationServiceException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import org.springframework.stereotype.Service;

/**
 * Checks an already signature-verified access token against the database on every request
 * (CurrentAccessJwtConverter): the account current role and status, the token cut-off
 * {@code users.tokens_valid_after}, and the liveness of the login session in the {@code sid} claim. The claim is required
 * and the session must belong to the subject of the token: a token without one, or whose session is another account's, is
 * refused, even though the signature is good (audit 112).
 */
@Service
@RequiredArgsConstructor
public class AccessTokenVerifier {

    private final UserRepository userRepository;
    private final RefreshTokenService refreshTokenService;

    /**
     * @return the account current role name, or empty when the subject is not an account id, the account no longer
     *         exists or is suspended (no authority at all, 403 rather than 401)
     * @throws InvalidBearerTokenException when the token was issued before the account cut-off, or its session has
     *                                     ended (401)
     * @throws AuthenticationServiceException when the database cannot be read: refusal, never a guess (503)
     */
    public Optional<String> currentRole(Jwt jwt) {
        UUID id;
        try {
            id = UUID.fromString(jwt.getSubject());
        } catch (IllegalArgumentException | NullPointerException e) {
            return Optional.empty();
        }
        try {
            Optional<UserAccess> access = userRepository.findAccessById(id);
            if (access.isPresent()) {
                requireNotRevoked(jwt, id, access.get());
            }
            return access.filter(a -> a.status() == UserStatus.ACTIVE)
                    .map(a -> a.role().name());
        } catch (DataAccessException e) {
            throw new AuthenticationServiceException("Could not verify the current access of the account", e);
        }
    }

    private void requireNotRevoked(Jwt jwt, UUID userId, UserAccess access) {
        Instant cutOff = access.tokensValidAfter();
        // iat has second resolution: compare with the cut-off truncated to the second, or a token minted right after
        // the
        // bump, in the same second, would be rejected.
        if (cutOff != null) {
            Instant issuedAt = jwt.getIssuedAt();
            if (issuedAt == null || issuedAt.isBefore(cutOff.truncatedTo(ChronoUnit.SECONDS))) {
                throw new InvalidBearerTokenException("Access token has been revoked");
            }
        }
        // Every token this backend mints is bound to a session. A missing or malformed sid is not a legacy token to be
        // waved through (the transition of the release that introduced the claim is long over, and nothing mints a
        // token
        // without one): it can only be a token someone else signed, so it counts as revoked.
        String sid = jwt.getClaimAsString(TokenService.SESSION_CLAIM);
        if (sid == null) {
            throw new InvalidBearerTokenException("Access token has no session");
        }
        UUID sessionId;
        try {
            sessionId = UUID.fromString(sid);
        } catch (IllegalArgumentException e) {
            throw new InvalidBearerTokenException("Access token has an invalid session");
        }
        if (!refreshTokenService.isSessionLive(userId, sessionId)) {
            throw new InvalidBearerTokenException("Access token session has ended");
        }
    }
}
