package com.blog.auth.service;

import com.blog.auth.dto.CurrentUserResponse;
import com.blog.auth.dto.LoginRequest;
import com.blog.auth.dto.MfaChallengeResponse;
import com.blog.auth.dto.RefreshRequest;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.entity.ChallengePurpose;
import com.blog.auth.entity.FirstFactor;
import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.LoginConcurrencyLimiter;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.security.ProductionMode;
import com.blog.common.security.SeedAdmin;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserAccess;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.CurrentUserService;
import jakarta.annotation.PostConstruct;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@Service
@RequiredArgsConstructor
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private static final String SAME_MESSAGE_FOR_BOTH = "Email or password is incorrect";

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final TokenService tokenService;
    private final RefreshTokenService refreshTokenService;
    private final LoginConcurrencyLimiter loginLimiter;
    private final RateLimiter rateLimiter;
    private final ProductionMode productionMode;
    private final MfaPolicy mfaPolicy;
    private final MfaChallengeService challengeService;
    private final TransactionTemplate transactionTemplate;

    // Precomputed once at startup rather than inlined as a literal: whether
    // Argon2PasswordEncoder.matches returns false or throws on an undecodable encoding is
    // an implementation detail, and a throw would turn an unknown email into a 500 - worse
    // than the timing leak this guard exists to close. Encoding a real random value keeps
    // the comparison cost realistic without depending on that detail.
    private String dummyHash;

    @PostConstruct
    void precomputeDummyHash() {
        dummyHash = passwordEncoder.encode(UUID.randomUUID().toString());
    }

    /**
     * Every attempt from a client address is counted before anything else, wrong or right, so a caller who reaches the
     * backend without Next in front (a public backend URL) cannot guess passwords at the speed of the Argon2 slots.
     * There is no per-account lock: knowing the owner's email must not be enough to lock the owner out.
     *
     * @param client where the request comes from (ClientAddressResolver)
     * @return a session, or a challenge when the account needs a second step. A wrong password, an unknown email and an
     *         account without a password are refused before the gate, byte for byte alike, so nothing about an account's
     *         two-step verification is visible to someone who does not hold the first factor
     * @throws ApiException 401 {@code INVALID_CREDENTIALS} (unknown email, wrong password, an account without a
     *                      password, and on a public site the dev password); 403 {@code USER_SUSPENDED} after a correct
     *                      password and before any challenge; 429 {@code RATE_LIMITED} when this client address made too
     *                      many attempts, or when waiting too long for a password-check slot (LoginConcurrencyLimiter),
     *                      and {@code MFA_RATE_LIMITED} when the account already holds the most challenges allowed
     */
    public FirstFactorResult login(LoginRequest request, ClientAddress client) {
        rateLimiter.check(RateLimiter.LOGIN_CLIENT, client.key());
        User user = userRepository.findByEmail(request.email()).orElse(null);

        // The encoder runs even when the email is unknown, against a hash that cannot
        // match. Returning early would make an unknown address measurably faster to
        // answer than a wrong password, which is the same disclosure the shared message
        // is written to avoid.
        //
        // An account without a password takes exactly that path: a GitHub account, or the seeded administrator of an
        // install whose first-run setup is pending (its hash is a marker, not an Argon2 encoding). It is compared
        // against the fake hash, then rejected with the very same message as an unknown email. The rejection relies
        // on "has no password", not on the fake hash failing to match. The marker must never reach the encoder:
        // it rejects a malformed hash at once (and logs a WARN per attempt), so that address would answer faster.
        //
        // Both paths (real hash and fake hash) go through the same limiter: each Argon2 run costs 19 MiB, so only a few
        // may run at once, and waiting too long gives 429. An unknown email must not get any shortcut around it.
        boolean hasPassword = user != null && isArgon2Encoding(user.getPasswordHash());
        String hash = hasPassword ? user.getPasswordHash() : dummyHash;
        boolean matches = loginLimiter.verify(() -> passwordEncoder.matches(request.password(), hash));
        // Public site: the dev password printed in the README is always rejected, for every account. It is checked
        // AFTER
        // the Argon2 run above, like every other failure, so the answer is no faster and no different from a wrong
        // password. That also means the gap between Tomcat accepting connections and DevCredentialWarning running is
        // not open to anyone.
        boolean developmentPassword = productionMode.active() && SeedAdmin.DEV_PASSWORD.equals(request.password());

        if (!hasPassword || !matches || developmentPassword) {
            // One WARN with a coarse reason and nothing else: no email, no password, no address. The response below is
            // the
            // same for all of them, so the reason lives in the log only (audit 008).
            String reason =
                    !hasPassword ? "no_account_or_no_password" : !matches ? "bad_password" : "dev_password_refused";
            log.warn("password login failed reason={}", reason);
            throw new ApiException(ErrorCode.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, SAME_MESSAGE_FOR_BOTH);
        }
        // Only say "suspended" AFTER the password is correct: with a wrong password a suspended person gets exactly the
        // same message as everyone else, so nobody can probe which accounts are suspended.
        if (user.getStatus() == UserStatus.SUSPENDED) {
            log.warn("password login refused userId={} reason=suspended", user.getId());
            throw CurrentUserService.suspended();
        }

        upgradeStoredHash(user, request.password());
        log.info("password login ok userId={}", user.getId());
        return completeFirstFactor(user, FirstFactor.PASSWORD);
    }

    /**
     * Replaces a stored hash whose Argon2 parameters are weaker than the current ones by a fresh hash of the password
     * the person just typed, so a stronger setting reaches existing accounts without a password change. It runs only
     * after the password matched, the account is active and the dev password was not the one used, and the encoding runs
     * under the same limiter as the check. The write is conditional on the old hash (a password change that landed in
     * between wins) and touches neither the sessions nor {@code updated_at}. A failure is logged and ignored: the person
     * is signed in, and the next sign-in tries again.
     */
    private void upgradeStoredHash(User user, String password) {
        String current = user.getPasswordHash();
        try {
            if (!passwordEncoder.upgradeEncoding(current)) {
                return;
            }
            String upgraded = loginLimiter.run(() -> passwordEncoder.encode(password));
            Integer written = transactionTemplate.execute(
                    status -> userRepository.replacePasswordHash(user.getId(), current, upgraded));
            log.info("password hash upgraded userId={} written={}", user.getId(), written != null && written == 1);
        } catch (RuntimeException e) {
            // The class only: a message could carry the hash or the password.
            log.warn(
                    "password hash upgrade skipped userId={} reason={}",
                    user.getId(),
                    e.getClass().getSimpleName());
        }
    }

    /** Whether this is a real Argon2 encoding. Null (a GitHub account) and the setup marker are not. */
    private static boolean isArgon2Encoding(String passwordHash) {
        return passwordHash != null && passwordHash.startsWith("$argon2");
    }

    /**
     * The one gate between "this person proved who they are" and "this person has a session": password login and GitHub
     * login both end here. It replaces the two direct calls that used to hand out tokens, so there is no path to a
     * session that skips whatever the gate decides.
     *
     * <ul>
     *   <li>A reader (USER) gets a session.</li>
     *   <li>An ADMIN, or an AUTHOR with a confirmed enrollment, gets a challenge instead of tokens: purpose
     *       {@code VERIFY} when an authenticator is enrolled, {@code ENROLL} for an ADMIN who has none yet (mandatory
     *       two-step verification; the upgrade path is docs/UPGRADING.md).</li>
     *   <li>Any other AUTHOR gets a session whose proof says no second factor was verified.</li>
     * </ul>
     * The gate itself is one short transaction that first locks the account row and then reads the role and the status
     * again, for every role (the {@code user} the caller holds was loaded before the password check, so its role may be
     * stale; the password check itself runs before the transaction, because Argon2 must not hold a connection). So "this
     * author has no second step yet" cannot be decided a moment before another tab's enrollment confirms, and a promotion
     * to ADMIN that lands while a login waits for its Argon2 slot gets the challenge, not a session: whichever runs
     * second sees the other's result, and the rotation rule is the backstop.
     *
     * It does not check the account status for the first factor: the caller already did (password login above, GitHub
     * login before getting here); it re-reads it under the lock only so a suspension that landed in between wins.
     *
     * @param factor how the person proved who they are
     */
    public FirstFactorResult completeFirstFactor(User user, FirstFactor factor) {
        return transactionTemplate.execute(status -> gate(user, factor));
    }

    private FirstFactorResult gate(User user, FirstFactor factor) {
        // Every role takes this path, readers included (audit 114): the entity was loaded before the password check,
        // which
        // waited for an Argon2 slot, and a promotion that landed meanwhile must not be missed. The decision is made on
        // the
        // role read here, under the lock, not on the role of the entity.
        userRepository.lockById(user.getId());
        UserAccess access = userRepository
                .findAccessById(user.getId())
                .orElseThrow(() -> new ApiException(
                        ErrorCode.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, SAME_MESSAGE_FOR_BOTH));
        if (access.status() == UserStatus.SUSPENDED) {
            throw CurrentUserService.suspended();
        }
        if (!mfaPolicy.required(access.role(), user.getId())) {
            return new FirstFactorResult.Session(issueSession(user, SessionProof.firstFactor(Instant.now())));
        }
        ChallengePurpose purpose = mfaPolicy.enrolled(user.getId()) ? ChallengePurpose.VERIFY : ChallengePurpose.ENROLL;
        MfaChallengeService.Issued issued = challengeService.issue(user, purpose, factor);
        List<String> methods = purpose == ChallengePurpose.VERIFY ? List.of("TOTP", "RECOVERY_CODE") : List.of("TOTP");
        return new FirstFactorResult.Challenge(new MfaChallengeResponse(
                issued.rawToken(),
                purpose.name(),
                methods,
                issued.expiresInSeconds(),
                issued.enrollmentCodeRequired()));
    }

    /**
     * Starts a login session and returns the token pair: a new access token (bound to the session, carrying when it
     * started), a new refresh token (its hash is stored), and the access token lifetime. The only way a session begins:
     * ArchitectureTest allows its callers to be this class and the services that verify a second factor or change a
     * password, and allows only this class to open the refresh token row and mint the token.
     */
    @Transactional
    public TokenResponse issueSession(User user, SessionProof proof) {
        RefreshTokenService.IssuedToken refresh = refreshTokenService.open(user, proof);
        return new TokenResponse(
                tokenService.mint(user, refresh.sessionId(), proof.authenticatedAt()),
                refresh.rawToken(),
                tokenService.accessTokenSeconds(),
                refresh.expiresInSeconds());
    }

    /** @param client where the request comes from; refreshes are counted per client address (429 {@code RATE_LIMITED}) */
    public TokenResponse refresh(RefreshRequest request, ClientAddress client) {
        rateLimiter.check(RateLimiter.REFRESH_CLIENT, client.key());
        RefreshTokenService.RotationResult rotated = refreshTokenService.rotate(request.refreshToken());
        return new TokenResponse(
                tokenService.mint(rotated.user(), rotated.sessionId(), rotated.authenticatedAt()),
                rotated.newRawToken(),
                tokenService.accessTokenSeconds(),
                rotated.refreshExpiresInSeconds());
    }

    public void logout(RefreshRequest request) {
        refreshTokenService.revoke(request.refreshToken());
    }

    /**
     * What the caller's own session can prove, read from its live refresh token BEFORE the caller ends every session: a
     * password change, an enrollment and the like then issue a new session with this very start time, so the caller never
     * gains a fresher sign-in this way.
     *
     * @throws ApiException 401 {@code REAUTHENTICATION_REQUIRED} when the token has no session or the session has no live
     *                      refresh token left
     */
    public SessionProof callerProof() {
        UUID userId = AuthenticatedUser.requireUserId();
        return AuthenticatedUser.sessionId()
                .flatMap(sessionId -> refreshTokenService.proofOfSession(userId, sessionId))
                .orElseThrow(() -> new ApiException(
                        ErrorCode.REAUTHENTICATION_REQUIRED, HttpStatus.UNAUTHORIZED, "Sign in again to continue"));
    }

    /**
     * "Sign out everywhere": ends every session of the caller, this one included. All their refresh tokens are revoked
     * and every access token issued so far stops working at once.
     */
    @Transactional
    public void signOutEverywhere() {
        refreshTokenService.revokeAllSessions(AuthenticatedUser.requireUserId(), Instant.now());
    }

    public CurrentUserResponse me() {
        User user = userRepository
                .findById(AuthenticatedUser.requireUserId())
                .orElseThrow(() -> new ApiException(
                        ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, "Authenticated user no longer exists"));
        // A suspended person gets 403 immediately, even if the access token is still valid: Next's /api/session route
        // clears the cookies when it sees this code, so they are signed out on the next page load rather than 15
        // minutes
        // later.
        if (user.getStatus() == UserStatus.SUSPENDED) {
            throw CurrentUserService.suspended();
        }
        return new CurrentUserResponse(
                user.getId(),
                user.getEmail(),
                user.getDisplayName(),
                user.getRole().name(),
                user.getGithubLogin(),
                user.getAvatarUrl(),
                user.getStatus().name(),
                user.getCreatedAt());
    }
}
