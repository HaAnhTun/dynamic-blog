package com.blog.auth.support;

import com.blog.auth.service.TokenService;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.util.Optional;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Reads the authenticated principal rather than taking an id from the request, which is
 * the whole point of replacing AdminPostController's TEMP_ADMIN_ID: a caller must not be
 * able to choose whose name a post is written under.
 */
public final class AuthenticatedUser {

    private AuthenticatedUser() {}

    public static UUID requireUserId() {
        // Both guards exist because both were measured as 500s with ERROR stack traces,
        // for what is a routine rejection of a forged or foreign token.
        //
        // The null case is the less obvious one: a token can simply carry no `sub` claim,
        // and `UUID.fromString(null)` throws NullPointerException — which is NOT an
        // IllegalArgumentException, so the catch below does not cover it.
        String subject = requireJwt().getSubject();
        if (subject == null) {
            throw unauthenticated();
        }
        try {
            return UUID.fromString(subject);
        } catch (IllegalArgumentException e) {
            // Measured: `sub="not-a-uuid-at-all"` on a properly signed token returned
            // INTERNAL_ERROR before this existed. NumberFormatException, which is what
            // UUID.fromString actually throws for that input, is a subclass of
            // IllegalArgumentException, so one catch covers both.
            throw unauthenticated();
        }
    }

    /**
     * The caller's id, or empty when there is no usable principal — the non-throwing twin of
     * {@link #requireUserId()}.
     *
     * It exists for authorization predicates evaluated inside {@code @PreAuthorize}. Throwing
     * from there does not produce a clean 401: the expression is evaluated by Spring Security's
     * own machinery, so an ApiException escapes as something else entirely. A predicate that
     * cannot identify the caller should simply answer "not permitted" and let the filter chain's
     * 401 handle the missing-principal case, which it already does before any method runs.
     */
    public static Optional<UUID> currentUserId() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !(authentication.getPrincipal() instanceof Jwt jwt)) {
            return Optional.empty();
        }
        String subject = jwt.getSubject();
        if (subject == null) {
            return Optional.empty();
        }
        try {
            return Optional.of(UUID.fromString(subject));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    /**
     * The caller as a log line may name them: the account id, or {@code anonymous} when nobody is signed in or the token has
     * no usable subject. Never an address, a token or a name (docs/SECURITY.md, "Audit events").
     */
    public static String actorForLog() {
        return currentUserId().map(UUID::toString).orElse("anonymous");
    }

    /**
     * The login session the access token belongs to (its {@code sid} claim); empty for a token without one or with one that
     * is not an id. The filter chain has already refused such a token (AccessTokenVerifier), and has checked that the
     * session is live and belongs to the subject; what the session can prove is read from its row
     * ({@code RefreshTokenService.proofOfSession}), never from the claims of the token.
     */
    public static Optional<UUID> sessionId() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !(authentication.getPrincipal() instanceof Jwt jwt)) {
            return Optional.empty();
        }
        String sid = jwt.getClaimAsString(TokenService.SESSION_CLAIM);
        if (sid == null) {
            return Optional.empty();
        }
        try {
            return Optional.of(UUID.fromString(sid));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    /**
     * Reads the role from the granted authorities rather than from the {@code role} claim.
     *
     * Since V7a they can differ: CurrentAccessJwtConverter builds the authority from the
     * account's current role in the database for ADMIN/AUTHOR claims. The filter chain's own
     * {@code hasAnyRole} checks consult the authorities, so this must too.
     */
    public static boolean hasRole(String role) {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        String authority = "ROLE_" + role;
        return authentication.getAuthorities().stream().anyMatch(granted -> authority.equals(granted.getAuthority()));
    }

    private static ApiException unauthenticated() {
        return new ApiException(ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, "Authentication required");
    }

    private static Jwt requireJwt() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !(authentication.getPrincipal() instanceof Jwt jwt)) {
            throw new ApiException(ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, "Authentication required");
        }
        return jwt;
    }
}
