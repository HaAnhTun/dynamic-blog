package com.blog.auth.service;

import com.blog.auth.entity.RefreshToken;
import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.common.config.SecurityProperties;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.CurrentUserService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
@RequiredArgsConstructor
public class RefreshTokenService {

    /**
     * @param authenticatedAt         the start of the session, copied from the token just rotated (never refreshed)
     * @param refreshExpiresInSeconds how long the replacement lives, from now: the Max-Age of the cookie that holds it
     */
    public record RotationResult(
            User user, String newRawToken, UUID sessionId, Instant authenticatedAt, long refreshExpiresInSeconds) {

        /** The raw token is a credential and is left out; the person is named by the id of the session only. */
        @Override
        public String toString() {
            return "RotationResult[newRawToken=<hidden>, sessionId=" + sessionId + ", authenticatedAt="
                    + authenticatedAt + ", refreshExpiresInSeconds=" + refreshExpiresInSeconds + "]";
        }
    }

    /**
     * A refresh token just issued and the login session it belongs to (the {@code sid} of the access tokens).
     *
     * @param expiresInSeconds how long it lives, from now: the Max-Age of the cookie that holds it
     */
    public record IssuedToken(String rawToken, UUID sessionId, long expiresInSeconds) {

        @Override
        public String toString() {
            return "IssuedToken[rawToken=<hidden>, sessionId=" + sessionId + ", expiresInSeconds=" + expiresInSeconds
                    + "]";
        }
    }

    private static final Logger log = LoggerFactory.getLogger(RefreshTokenService.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String REVOKED_MESSAGE = "Refresh token has been used already";

    private final RefreshTokenRepository refreshTokenRepository;
    private final SecurityProperties properties;
    private final UserRepository userRepository;
    private final MfaPolicy mfaPolicy;

    /**
     * SHA-256 hex. Public and static so a test can address a stored row by its hash
     * without reimplementing the hashing — a test that computed it differently would
     * silently stop testing anything.
     */
    public static String hash(String rawToken) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(rawToken.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required by every JVM", e);
        }
    }

    /**
     * Starts a new login session: the only way a session begins. Callable only from AuthService (ArchitectureTest), which
     * is where the first factor and the second factor are decided.
     *
     * @param proof what the session can prove: when the person signed in and whether a second factor was verified
     */
    public IssuedToken open(User user, SessionProof proof) {
        return issue(user, UUID.randomUUID(), proof);
    }

    private IssuedToken issue(User user, UUID sessionId, SessionProof proof) {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String raw = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);

        RefreshToken token = new RefreshToken();
        token.setUser(user);
        token.setTokenHash(hash(raw));
        token.setSessionId(sessionId);
        token.setAuthenticatedAt(proof.authenticatedAt());
        token.setMfaVerifiedAt(proof.mfaVerifiedAt());
        Instant now = Instant.now();
        Instant expiresAt = expiryOf(user.getRole(), proof.authenticatedAt(), now);
        token.setExpiresAt(expiresAt);
        refreshTokenRepository.save(token);

        return new IssuedToken(
                raw, sessionId, Math.max(0, Duration.between(now, expiresAt).toSeconds()));
    }

    /** ADMIN and AUTHOR sessions have an idle timeout and an absolute lifetime; a reader keeps the sliding refresh token life. */
    private static boolean isPrivileged(UserRole role) {
        return role != UserRole.USER;
    }

    /**
     * When a refresh token issued at {@code now} to a session that started at {@code sessionStart} (the
     * {@code authenticated_at} of the proof: never refreshed by rotation, carried over when a password change or an
     * enrollment issues the caller a new session) expires. A reader: {@code refreshTokenTtl} from now, as before. An ADMIN
     * or AUTHOR: the idle timeout from now, but never later than the absolute lifetime counted from the start of the
     * session, so a session that is used every day still ends after {@code privilegedSessionAbsoluteTtl} and the person signs
     * in again (with a new second-step code).
     */
    private Instant expiryOf(UserRole role, Instant sessionStart, Instant now) {
        if (!isPrivileged(role)) {
            return now.plus(properties.refreshTokenTtl());
        }
        Instant idle = now.plus(properties.privilegedSessionIdleTtl());
        Instant absolute = sessionStart.plus(properties.privilegedSessionAbsoluteTtl());
        return idle.isBefore(absolute) ? idle : absolute;
    }

    /**
     * What the session of a signed-in request can prove, read from its live refresh token: the start of the session and
     * whether a second factor was verified. A password change, an enrollment and the like read it BEFORE they end every
     * session, then issue the caller a new one that carries the very same start time (the caller never gains a fresher
     * sign-in this way).
     *
     * @param userId the account the access token names: a session of another account is not this one's session
     * @return empty when the session has no live refresh token
     */
    @Transactional(readOnly = true)
    public Optional<SessionProof> proofOfSession(UUID userId, UUID sessionId) {
        return refreshTokenRepository.findLiveBySessionId(sessionId, userId, Instant.now()).stream()
                .findFirst()
                .map(token -> new SessionProof(token.getAuthenticatedAt(), token.getMfaVerifiedAt()));
    }

    /**
     * Whether the login session of this person still has a live refresh token: the check behind an access token's
     * {@code sid} claim. The session must belong to the account the token names, so a session id that is not the subject's
     * own never counts.
     */
    @Transactional(readOnly = true)
    public boolean isSessionLive(UUID userId, UUID sessionId) {
        return refreshTokenRepository.existsLiveSession(sessionId, userId, Instant.now());
    }

    /**
     * Ends every session of one person at once: all refresh tokens are revoked and every access token issued before
     * {@code now} is rejected ({@code users.tokens_valid_after}). The caller must already be inside a transaction.
     *
     * @return the number of refresh tokens just revoked
     */
    public int revokeAllSessions(UUID userId, Instant now) {
        userRepository.bumpTokensValidAfter(userId, now);
        return refreshTokenRepository.revokeAllLiveForUser(userId, now);
    }

    /**
     * Revokes the presented token and issues a replacement, so a token cannot be used
     * twice — including by two requests that arrive together.
     *
     * The validation pass (`find`, then `requireLive`) is what keeps INVALID, EXPIRED and
     * REVOKED distinguishable. The conditional UPDATE after it is what makes the rotation atomic:
     * zero rows changed means another transaction revoked this token first, so this caller
     * lost the race and gets the same REVOKED answer a sequential replay would get. An
     * earlier version read and then saved, which let two concurrent callers both succeed
     * and turn one token into two live ones.
     *
     * <h2>Reuse of a revoked token</h2>
     *
     * A token revoked ON ITS OWN (rotation, logout) that is presented again after the grace period
     * ({@code app.security.refresh-token-reuse-grace}, default 2 minutes) and is still unexpired: either the token has
     * leaked, or a client lost the response of the rotation; the two cannot be told apart, so it is treated as leaked.
     * The session that token belongs to is ended ({@link RefreshTokenRepository#revokeAllLiveForSession}: the lineage of
     * rotations of that one sign-in, including the token the rotation issued to whoever holds the copy), and one WARN
     * line carries only the user id. The person's OTHER sessions stay: a copy of one device's cookie says nothing about
     * another device, and a lost response (a proxy answering 502 after the backend rotated) must not sign a second device
     * out (audit 104). A change of who may hold the account (suspension, password, role) still ends every session. The
     * response does NOT change: 401 REFRESH_TOKEN_REVOKED like any revoked token, so Next still treats it as losing a race
     * and keeps the cookie as before.
     *
     * Within the grace period it is a genuine race: two Next requests carry the same cookie for a few seconds (the
     * /admin proxy and the /api/session route do not share a memo), the loser gets REVOKED and nobody is signed out.
     *
     * Each token triggers only once: its own expiry ends immediately ({@link RefreshTokenRepository#expire}), and a
     * bulk revocation also ends the expiry of the tokens it revokes. Replaying the old token forever, or an old device
     * reopening after a suspension, password change, role change or this very detection, therefore gets EXPIRED (see
     * requireLive) and is signed out by Next, without triggering one more revocation.
     *
     * The transaction COMMITS when the reuse error propagates out ({@code noRollbackFor}). ApiException is a
     * RuntimeException, so by default Spring rolls back, and the revocation would vanish together with its own 401:
     * measured, RefreshTokenServiceIT and AuthRefreshIT go red without this line. Only the {@link ReuseDetected} type,
     * not every ApiException: the other 401/403 branches write nothing, and a write added later must not silently commit
     * along with the same error. REQUIRES_NEW is not used: every replay would hold two connections at once, and a few
     * parallel replays are enough to drain the pool.
     */
    @Transactional(noRollbackFor = {ReuseDetected.class, MfaRejection.class})
    public RotationResult rotate(String rawToken) {
        try {
            return rotateToken(rawToken);
        } catch (ApiException e) {
            logRefusal(e);
            throw e;
        }
    }

    private RotationResult rotateToken(String rawToken) {
        // The account row is locked BEFORE the token is read, with the lock every bulk revocation takes (the UPDATE of
        // tokens_valid_after in revokeAllSessions), so a rotation and "sign out everywhere", a password change, an
        // authenticator change or the reuse detection of the same person run one entirely before the other. Without it
        // the
        // two only held lock modes that do not conflict, and under READ COMMITTED the bulk UPDATE could not see a
        // successor
        // that was not yet committed: one live session survived the owner's recovery step (audit 113). The owner is
        // read
        // with a scalar query and the token itself only after the lock, so what is decided below is the state after
        // whoever held the lock has committed. The lock order is users first, then refresh_tokens, like every other
        // path.
        UUID owner = refreshTokenRepository
                .findUserIdByTokenHash(hash(rawToken))
                .orElseThrow(() -> unauthorized(ErrorCode.REFRESH_TOKEN_INVALID, "Refresh token is not recognised"));
        userRepository.lockById(owner);
        RefreshToken existing = find(rawToken);
        // A suspended person gets 403 USER_SUSPENDED and nothing is rotated. Checked right after learning whose token
        // it
        // is, BEFORE "revoked" and "expired": the suspension revoked every live token of that person, so if this check
        // came later, a suspended person would always get REFRESH_TOKEN_REVOKED. Next treats REVOKED as losing a token
        // rotation race and keeps the cookie; only USER_SUSPENDED makes it clear the cookie. The status is read from
        // the
        // User row just fetched by the join fetch.
        if (existing.getUser().getStatus() == UserStatus.SUSPENDED) {
            throw CurrentUserService.suspended();
        }
        Instant now = Instant.now();
        if (isReuseAfterGrace(existing, now)) {
            throw revokeSessionOfReusedToken(existing, now);
        }
        requireLive(existing);
        requireWithinAbsoluteLifetime(existing, now);
        if (existing.getMfaVerifiedAt() == null && mfaPolicy.required(existing.getUser())) {
            throw refuseUnverifiedSession(existing, now);
        }
        if (refreshTokenRepository.revokeIfLive(existing.getTokenHash(), now) == 0) {
            throw unauthorized(ErrorCode.REFRESH_TOKEN_REVOKED, REVOKED_MESSAGE);
        }
        // The proof of the session is copied, never refreshed: a session that is still alive 30 days later does not
        // look
        // freshly authenticated, and one that never verified a second factor still has not.
        SessionProof proof = new SessionProof(existing.getAuthenticatedAt(), existing.getMfaVerifiedAt());
        IssuedToken next = issue(existing.getUser(), existing.getSessionId(), proof);
        return new RotationResult(
                existing.getUser(),
                next.rawToken(),
                next.sessionId(),
                proof.authenticatedAt(),
                next.expiresInSeconds());
    }

    /**
     * An ADMIN or AUTHOR session ends {@code privilegedSessionAbsoluteTtl} after the person signed in, however active it was:
     * 401 {@code REFRESH_TOKEN_EXPIRED}, the answer that makes Next clear the cookies. The token's own expiry already stops at
     * that instant (see {@link #expiryOf}); this check is for a token issued under the reader's rules (before a role change
     * could be made without ending the sessions) and for a configuration shortened since. It writes nothing: the refusal
     * repeats at every attempt.
     */
    private void requireWithinAbsoluteLifetime(RefreshToken token, Instant now) {
        if (isPrivileged(token.getUser().getRole())
                && !token.getAuthenticatedAt()
                        .plus(properties.privilegedSessionAbsoluteTtl())
                        .isAfter(now)) {
            throw unauthorized(ErrorCode.REFRESH_TOKEN_EXPIRED, "Refresh token has expired");
        }
    }

    /**
     * The policy of the session, checked at every rotation: when the account requires two-step verification (an ADMIN, or
     * an AUTHOR with a confirmed enrollment) and this session never verified a second factor, the refresh token is
     * revoked AND expired and the answer is 401 {@code MFA_REQUIRED}. The token can never rotate later: a replay gets
     * {@code REFRESH_TOKEN_EXPIRED}, which Next already answers by clearing the cookies, and the session's access tokens
     * die with it (their {@code sid} has no live token left).
     *
     * Why a rule on the session and not only a check at login: a session opened before the account was required to enrol
     * (an author who enrols in another tab, an ADMIN session from a release without the second step, or one opened by the
     * race that {@code AuthService.completeFirstFactor} closes with the account lock) must not keep refreshing as if it
     * had passed the second step. The transaction COMMITS with the error ({@code noRollbackFor MfaRejection}), or the
     * revocation would vanish with its own 401.
     */
    private MfaRejection refuseUnverifiedSession(RefreshToken token, Instant now) {
        refreshTokenRepository.revokeIfLive(token.getTokenHash(), now);
        refreshTokenRepository.expire(token.getId(), now);
        log.warn("mfa session refused at refresh userId={}", token.getUser().getId());
        return MfaRejection.required();
    }

    /**
     * Signs one session out: every live refresh token of the session the presented token belongs to is revoked, and the
     * access tokens of the session die with it (their {@code sid} has no live token left). The lineage, not the single
     * token: a client that holds an already rotated token (a rotation answer that never arrived, Next's short refresh memo)
     * presents a revoked token while its successor is the live one, and revoking only the presented token left that session
     * alive after "Sign out" (audit 038). The person's other sessions are not touched.
     *
     * No suspension, revoked or expiry check: signing out must always work, even for a suspended person or with a token that
     * was rotated or has expired. Only a token that was never issued is refused. The account row is locked first, like
     * every bulk revocation, so a rotation of the same session is either entirely before this statement (its successor is
     * revoked here) or entirely after it (the token is already revoked and nothing is issued).
     */
    @Transactional
    public void revoke(String rawToken) {
        UUID owner = refreshTokenRepository
                .findUserIdByTokenHash(hash(rawToken))
                .orElseThrow(() -> unauthorized(ErrorCode.REFRESH_TOKEN_INVALID, "Refresh token is not recognised"));
        userRepository.lockById(owner);
        RefreshToken existing = find(rawToken);
        refreshTokenRepository.revokeLiveForSession(existing.getSessionId(), Instant.now());
    }

    private RefreshToken find(String rawToken) {
        // The fetching variant, so the User handed back by rotate() is initialised before
        // the transaction closes. See the comment on findByTokenHashWithUser.
        return refreshTokenRepository
                .findByTokenHashWithUser(hash(rawToken))
                .orElseThrow(() -> unauthorized(ErrorCode.REFRESH_TOKEN_INVALID, "Refresh token is not recognised"));
    }

    private void requireLive(RefreshToken token) {
        // Expiry is checked first: a bulk revocation cuts expires_at back to the revocation time, and EXPIRED makes the
        // frontend clear the cookie, while REVOKED (losing a rotation race) makes it keep the cookie.
        if (token.getExpiresAt().isBefore(Instant.now())) {
            throw unauthorized(ErrorCode.REFRESH_TOKEN_EXPIRED, "Refresh token has expired");
        }
        if (token.getRevokedAt() != null) {
            // Distinguished from invalid and expired on purpose: a revoked token being
            // presented means either a replay or a client that lost a rotation race, and
            // telling those apart later needs the two cases separated now.
            throw unauthorized(ErrorCode.REFRESH_TOKEN_REVOKED, REVOKED_MESSAGE);
        }
    }

    /** Revoked on its own beyond the grace period, and still unexpired: see {@link #rotate}. */
    private boolean isReuseAfterGrace(RefreshToken token, Instant now) {
        Instant revokedAt = token.getRevokedAt();
        return revokedAt != null
                && revokedAt.isBefore(now.minus(properties.refreshTokenReuseGrace()))
                && token.getExpiresAt().isAfter(now);
    }

    /**
     * Revokes every live token of the session the replayed token belongs to, ends the expiry of that token itself, and
     * returns the error to throw. The account row is already locked (rotateToken), so this cannot interleave with a
     * rotation of the same person. The access tokens of the session die with it (their {@code sid} has no live token left);
     * the account cut-off is NOT moved, because the person's other sessions are not in doubt.
     *
     * The WARN is written AFTER the commit, like AdminSeedEmail: it only reports a revocation that really happened. The
     * log has no token, hash or issue time: only the user id, how long ago the token was revoked, and the number of
     * tokens of that session just revoked.
     */
    private ReuseDetected revokeSessionOfReusedToken(RefreshToken token, Instant now) {
        UUID userId = token.getUser().getId();
        int revoked = refreshTokenRepository.revokeAllLiveForSession(token.getSessionId(), now);
        refreshTokenRepository.expire(token.getId(), now);
        long revokedSecondsAgo = Duration.between(token.getRevokedAt(), now).toSeconds();
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                log.warn(
                        "refresh token reuse detected userId={} revokedSecondsAgo={} tokensRevoked={}",
                        userId,
                        revokedSecondsAgo,
                        revoked);
            }
        });
        return new ReuseDetected();
    }

    /**
     * One WARN for a refresh that was refused because the token is not good (audit 008): the reason only, no token, no hash,
     * no account. The reuse of a revoked token and the refusal of an unverified session write their own lines.
     */
    private void logRefusal(ApiException e) {
        String reason = switch (e.getCode()) {
            case REFRESH_TOKEN_INVALID -> "invalid";
            case REFRESH_TOKEN_EXPIRED -> "expired";
            case REFRESH_TOKEN_REVOKED -> "revoked";
            case USER_SUSPENDED -> "suspended";
            default -> null;
        };
        if (reason != null && !(e instanceof ReuseDetected)) {
            log.warn("refresh refused reason={}", reason);
        }
    }

    private ApiException unauthorized(ErrorCode code, String message) {
        return new ApiException(code, HttpStatus.UNAUTHORIZED, message);
    }

    /**
     * Exactly the answer for every revoked token: 401 REFRESH_TOKEN_REVOKED with the same message, so Next cannot tell
     * the difference and does not need to. It is a type of its own only so that {@link #rotate} commits when it
     * propagates out.
     */
    private static final class ReuseDetected extends ApiException {
        ReuseDetected() {
            super(ErrorCode.REFRESH_TOKEN_REVOKED, HttpStatus.UNAUTHORIZED, REVOKED_MESSAGE);
        }
    }
}
