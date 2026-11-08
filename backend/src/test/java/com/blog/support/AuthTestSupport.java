package com.blog.support;

import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.auth.dto.TokenResponse;
import com.blog.auth.mfa.MfaSecretCipher;
import com.blog.auth.mfa.MfaSecrets;
import com.blog.auth.mfa.RecoveryCodes;
import com.blog.auth.mfa.Totp;
import com.blog.auth.service.AuthService;
import com.blog.auth.service.SessionProof;
import com.blog.auth.service.TokenService;
import com.blog.common.security.SeedAdmin;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.PublicSlugs;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.stereotype.Component;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Mints a real token through the real TokenService rather than stubbing the security
 * context. A test that injected an authentication object directly would pass even if the
 * filter chain rejected every bearer token, which is exactly what these tests exist to
 * check.
 */
@Component
public class AuthTestSupport {

    /**
     * A GitHub id for test readers, unique across the whole JVM: the DB is shared by all test classes and never
     * cleaned, and {@code users.github_id} is UNIQUE. Starting around 8·10⁹ so it does not collide with ids tests
     * choose themselves (GitHub stub, the configured admin id), which are much smaller.
     */
    private static final AtomicLong NEXT_GITHUB_ID = new AtomicLong(8_000_000_000L);

    @Autowired
    private TokenService tokenService;

    @Autowired
    private AuthService authService;

    @Autowired
    private JwtEncoder jwtEncoder;

    @Autowired
    private JwtDecoder jwtDecoder;

    @Autowired
    private MfaSecretCipher mfaCipher;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    // --- Sessions -------------------------------------------------------------------------------------------------
    //
    // A session begins only through AuthService.issueSession (ArchitectureTest), so tests start theirs through it too.
    // The backend accepts no access token without a live session of its own subject (audit 112), so the bearer helpers
    // below (bearerFor and the others) open a real session as well and return its access token.

    /**
     * A session that has passed a first factor and a verified second factor, both just now: what a person has after
     * signing in with two-step verification. Use it wherever a test needs a live session of any account.
     */
    public TokenResponse verifiedSession(User user) {
        return authService.issueSession(user, SessionProof.verified(Instant.now()));
    }

    /** The raw refresh token of {@link #verifiedSession}: for tests of rotation, logout, reuse and revocation. */
    public String verifiedRefreshToken(User user) {
        return verifiedSession(user).refreshToken();
    }

    /**
     * A session that has passed the first factor only: what a reader or an author without two-step verification has. For
     * an ADMIN, or an enrolled AUTHOR, it is the session the refresh must refuse.
     */
    public TokenResponse unverifiedSession(User user) {
        return authService.issueSession(user, SessionProof.firstFactor(Instant.now()));
    }

    /** A verified session whose sign-in happened at {@code authenticatedAt}, for the re-authentication window. */
    public TokenResponse verifiedSessionStartedAt(User user, Instant authenticatedAt) {
        return authService.issueSession(user, new SessionProof(authenticatedAt, authenticatedAt));
    }

    // --- Two-step verification ------------------------------------------------------------------------------------
    //
    // The database is shared by the whole JVM, so the secrets of the accounts a test enrols are remembered here, by
    // account
    // id. An account that already has a row of unknown origin is enrolled again with a secret the helper knows.

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Map<UUID, EnrolledAccount> ENROLLED = new ConcurrentHashMap<>();

    /**
     * An account with an ACTIVE enrollment whose secret and recovery codes the test knows.
     *
     * @param secret        the raw TOTP secret
     * @param recoveryCodes the ten recovery codes in their normalised 24-character form (each works once)
     */
    public record EnrolledAccount(User user, byte[] secret, List<String> recoveryCodes) {

        /** The code of the current 30-second step. */
        public String code() {
            return Totp.code(secret, Totp.stepOf(Instant.now()));
        }

        /** The code of a step at an offset from the current one: -1 is the previous step, 1 the next (refused). */
        public String codeAtOffset(int steps) {
            return Totp.code(secret, Totp.stepOf(Instant.now()) + steps);
        }

        public String base32() {
            return MfaSecrets.encode(secret);
        }
    }

    /**
     * Enrols the account with a known secret, once per account (a second call returns the same one and puts the replay
     * guard and the failure counters back). Inserted with SQL, so no challenge, no enrollment code and no session is
     * involved: the account just is an enrolled one. Recovery codes are inserted as their hashes.
     */
    public EnrolledAccount enroll(User user) {
        EnrolledAccount known = ENROLLED.get(user.getId());
        boolean rowExists = Boolean.TRUE.equals(jdbcTemplate.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = ? AND status = 'ACTIVE')",
                Boolean.class,
                user.getId()));
        if (known != null && rowExists) {
            resetSecondStep(user.getId());
            return known;
        }
        jdbcTemplate.update("DELETE FROM user_mfa WHERE user_id = ?", user.getId());
        jdbcTemplate.update("DELETE FROM user_mfa_recovery_code WHERE user_id = ?", user.getId());
        byte[] secret = MfaSecrets.generate(RANDOM);
        jdbcTemplate.update(
                "INSERT INTO user_mfa (user_id, status, secret_cipher, key_id, confirmed_at) "
                        + "VALUES (?, 'ACTIVE', ?, ?, now())",
                user.getId(),
                mfaCipher.encrypt(user.getId(), MfaSecretCipher.Purpose.ACTIVE, secret),
                mfaCipher.keyId());
        List<String> codes = RecoveryCodes.generate(RANDOM);
        for (String code : codes) {
            jdbcTemplate.update(
                    "INSERT INTO user_mfa_recovery_code (user_id, code_hash) VALUES (?, ?)",
                    user.getId(),
                    RecoveryCodes.hash(code));
        }
        EnrolledAccount enrolled = new EnrolledAccount(user, secret, codes);
        ENROLLED.put(user.getId(), enrolled);
        return enrolled;
    }

    /**
     * A current code of the account's authenticator, enrolling the account first when it has none and putting the replay guard
     * back: what a test sends where the administrator's own code is asked for (a role change, the approval of an application,
     * audit 111). Every call returns a code the server has not seen.
     */
    public String freshCodeOf(User user) {
        EnrolledAccount account = enroll(user);
        resetSecondStep(user.getId());
        return account.code();
    }

    /** {@link #freshCodeOf} for the account behind a bearer header value ({@link #bearerFor}). */
    public String freshCodeForBearer(String bearer) {
        UUID id = UUID.fromString(
                jwtDecoder.decode(bearer.substring("Bearer ".length())).getSubject());
        return freshCodeOf(userRepository.findById(id).orElseThrow());
    }

    /** The seeded admin, enrolled with a known secret. */
    public EnrolledAccount enrolledAdmin() {
        return enroll(userRepository.findById(SeedAdmin.ID).orElseThrow());
    }

    /** Puts the replay guard, the failure counter and the lock of an account back: two handshakes in one 30-second step. */
    public void resetSecondStep(UUID userId) {
        jdbcTemplate.update(
                "UPDATE user_mfa SET last_used_step = 0, failed_attempts = 0, locked_until = NULL WHERE user_id = ?",
                userId);
    }

    /**
     * The whole two-step sign-in of an enrolled account over HTTP, as Next drives it: the password answers 202 with a
     * challenge and no token, the code answers with the tokens. The replay guard is put back first (two handshakes of one
     * account in the same 30-second step would otherwise fail the replay rule), and the {@code Clock} is never swapped.
     *
     * @return the token pair of the session, whose refresh token carries a verified second factor
     */
    public TokenResponse loginWithSecondStep(MockMvc mockMvc, String email, String password, EnrolledAccount account)
            throws Exception {
        MockHttpServletResponse first = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("email", email, "password", password))))
                .andReturn()
                .getResponse();
        return completeSecondStep(mockMvc, first, account);
    }

    /**
     * The second step of a sign-in whose first factor answered 202 (the password login or the GitHub callback): hands the
     * challenge back with a current code of the account's authenticator. The replay guard is put back first.
     */
    public TokenResponse completeSecondStep(
            MockMvc mockMvc, MockHttpServletResponse challengeResponse, EnrolledAccount account) throws Exception {
        String challengeBody = challengeResponse.getContentAsString();
        if (challengeResponse.getStatus() != 202) {
            throw new AssertionError("The first factor did not ask for a second step: " + challengeBody);
        }
        JsonNode challenge = objectMapper.readTree(challengeBody).path("data");
        resetSecondStep(account.user().getId());
        String body = mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("challenge", challenge.path("challenge").asString(), "code", account.code()))))
                .andReturn()
                .getResponse()
                .getContentAsString();
        JsonNode data = objectMapper.readTree(body).path("data");
        if (data.path("accessToken").isMissingNode()) {
            throw new AssertionError("The second step did not open a session: " + body);
        }
        return new TokenResponse(
                data.path("accessToken").asString(),
                data.path("refreshToken").asString(),
                data.path("expiresIn").asLong(),
                data.path("refreshExpiresIn").asLong());
    }

    /** {@link #loginWithSecondStep} for the seeded admin with the development password. */
    public TokenResponse loginAsAdmin(MockMvc mockMvc) throws Exception {
        return loginWithSecondStep(mockMvc, "admin@blog.local", "admin12345", enrolledAdmin());
    }

    /** The login session id (the {@code sid} claim) of the access token of a session. */
    public UUID sessionIdOf(TokenResponse session) {
        return UUID.fromString(jwtDecoder.decode(session.accessToken()).getClaimAsString(TokenService.SESSION_CLAIM));
    }

    /** The access token of a new live session of the account, as an Authorization header value. */
    public String bearerFor(User user) {
        return "Bearer " + verifiedSession(user).accessToken();
    }

    /**
     * The access token of a new live session of the account whose sign-in was at {@code startedAt}: a session too old for any
     * change that asks for a recent sign-in (the start of a session is read from its row, not from the token).
     */
    public String bearerForSessionStartedAt(User user, Instant startedAt) {
        return "Bearer " + verifiedSessionStartedAt(user, startedAt).accessToken();
    }

    /**
     * A token of a new live session of the account whose issue time is {@code issuedAt}: for the tests of the account
     * cut-off ({@code tokens_valid_after}), which compares the issue time, and of the expiry.
     */
    public String bearerIssuedAt(User user, Instant issuedAt) {
        TokenResponse session = verifiedSession(user);
        return "Bearer " + tokenService.mint(user, issuedAt, sessionIdOf(session), Instant.now());
    }

    /**
     * A token the backend never mints, signed with the real key and otherwise well formed: it names no session. Only a test
     * of its refusal wants one.
     */
    public String bearerWithoutSession(User user) {
        Instant now = Instant.now();
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(TokenService.ISSUER)
                .audience(List.of(TokenService.AUDIENCE))
                .subject(user.getId().toString())
                .issuedAt(now)
                .expiresAt(now.plusSeconds(tokenService.accessTokenSeconds()))
                .claim("role", user.getRole().name())
                .claim(TokenService.AUTH_TIME_CLAIM, now.getEpochSecond())
                .build();
        return "Bearer "
                + jwtEncoder
                        .encode(JwtEncoderParameters.from(
                                JwsHeader.with(() -> "HS256").build(), claims))
                        .getTokenValue();
    }

    public String bearerForAdmin() {
        return bearerFor(userRepository.findByEmail("admin@blog.local").orElseThrow());
    }

    /**
     * Ten minutes past expiry, and the reason has to be written as arithmetic rather than
     * as "long expired": mint sets expiresAt = issuedAt + ttl, so back-dating the issue
     * time by ttl + N puts exp at now - N. JwtTimestampValidator allows 60 seconds of
     * clock skew by default and rejects only when exp + skew < now, so N must comfortably
     * exceed 60. The previous value was exactly 60, which put the token on the boundary
     * and made the test depend on how long the call took.
     */
    private static final long SECONDS_PAST_EXPIRY = 600;

    /**
     * A correctly signed admin token whose `exp` is {@link #SECONDS_PAST_EXPIRY} seconds in
     * the past, measured from the moment of the call, so it stays expired however the
     * access-token TTL is later tuned.
     *
     * It goes through the real TokenService rather than hand-editing a token's payload.
     * Editing the payload would invalidate the signature, and the request would then be
     * rejected for a bad signature — a different code path from the one this exercises.
     */
    public String expiredBearerForAdmin() {
        User admin = userRepository.findByEmail("admin@blog.local").orElseThrow();
        Instant issuedAt =
                Instant.now().minusSeconds(tokenService.accessTokenSeconds()).minusSeconds(SECONDS_PAST_EXPIRY);
        return bearerIssuedAt(admin, issuedAt);
    }

    public User createAuthor(String email) {
        return createAccount(email, UserRole.AUTHOR);
    }

    /**
     * An email + password account with any role (a second ADMIN, an AUTHOR, a USER with a password), display name
     * {@code "<Role> <email>"} like {@link #createAuthor}. The hash is an undecodable string: tokens are issued
     * through {@link #bearerFor}, not through login; a test that needs a real password login sets the hash itself
     * with PasswordEncoder and saves it ({@code password_hash} can still be updated through the entity).
     */
    public User createAccount(String email, UserRole role) {
        User user = new User();
        user.setEmail(email);
        user.setPasswordHash("$argon2id$unused-for-token-minting");
        user.setDisplayName(capitalised(role) + " " + email);
        user.setRole(role);
        user.setPublicSlug(PublicSlugs.allocate(jdbcTemplate, PublicSlugs.base(user.getDisplayName())));
        return userRepository.save(user);
    }

    /** A GitHub id nobody has used in this JVM yet, for {@link #createReader}. */
    public long nextGithubId() {
        return NEXT_GITHUB_ID.getAndIncrement();
    }

    /** {@link #createReader(long, String, UserStatus)} in ACTIVE status. */
    public User createReader(long githubId, String login) {
        return createReader(githubId, login, UserStatus.ACTIVE);
    }

    /**
     * A reader as the first GitHub login would create: role USER, no email, no password, display name
     * {@code "Reader <login>"}, avatar on avatars.githubusercontent.com, {@code last_login_at} is the creation time.
     *
     * Writing through the entity works because User's read-only columns are still insertable. To change the status of
     * someone who ALREADY exists use {@link #setStatus}: the entity's setter can no longer write those columns. The
     * public slug is chosen like at the first login (root from the login, smallest free suffix), only without holding
     * the lock: fixtures run sequentially.
     */
    public User createReader(long githubId, String login, UserStatus status) {
        User reader = new User();
        reader.setGithubId(githubId);
        reader.setGithubLogin(login);
        reader.setAvatarUrl("https://avatars.githubusercontent.com/u/" + githubId + "?v=4");
        reader.setDisplayName("Reader " + login);
        reader.setRole(UserRole.USER);
        reader.setStatus(status);
        reader.setLastLoginAt(Instant.now().truncatedTo(ChronoUnit.MICROS));
        reader.setPublicSlug(PublicSlugs.allocate(jdbcTemplate, PublicSlugs.base(login)));
        return userRepository.save(reader);
    }

    /**
     * Changes the status of an existing account with SQL, exactly like the real suspension path: {@code status} is a
     * read-only column on the entity, so {@code user.setStatus(...)} then {@code save} silently writes nothing. It
     * does not revoke refresh tokens: a test that needs the full suspension calls
     * {@code RefreshTokenRepository.revokeAllLiveForUser} itself.
     */
    public void setStatus(UUID userId, UserStatus status) {
        int changed = jdbcTemplate.update(
                "UPDATE users SET status = ?, updated_at = now() WHERE id = ?", status.name(), userId);
        if (changed != 1) {
            throw new IllegalStateException("No account " + userId);
        }
    }

    /**
     * Changes the role of an existing account with SQL, like {@link #setStatus}: {@code role} is a read-only column
     * on the entity so {@code user.setRole(...)} then {@code save} silently writes nothing. It does not revoke
     * refresh tokens and bypasses the "one ADMIN must remain" invariant: the real path is PATCH
     * /api/v1/admin/users/{id}/role.
     */
    public void setRole(UUID userId, UserRole role) {
        int changed =
                jdbcTemplate.update("UPDATE users SET role = ?, updated_at = now() WHERE id = ?", role.name(), userId);
        if (changed != 1) {
            throw new IllegalStateException("No account " + userId);
        }
    }

    private static String capitalised(UserRole role) {
        String name = role.name();
        return name.charAt(0) + name.substring(1).toLowerCase(Locale.ROOT);
    }
}
