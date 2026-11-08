package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.auth.dto.CurrentUserResponse;
import com.blog.auth.dto.LoginRequest;
import com.blog.auth.dto.MfaChallengeResponse;
import com.blog.auth.dto.RefreshRequest;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.entity.ChallengePurpose;
import com.blog.auth.entity.FirstFactor;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.LoginConcurrencyLimiter;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.security.ProductionMode;
import com.blog.common.security.SeedAdmin;
import com.blog.setup.service.SetupAccounts;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserAccess;
import com.blog.user.repository.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Password login and {@code /auth/me} when GitHub readers exist: an account without a password hash,
 * and a suspended account.
 *
 * A unit test because what must be proven is the ORDER of the steps (always run the encoder before rejecting, only say "locked" after the
 * password is correct), and a mock encoder is the only way to see which hash it is called with.
 */
@ExtendWith(MockitoExtension.class)
class AuthServiceTest {

    private static final String DUMMY_HASH = "$argon2id$hash-gia-tinh-luc-khoi-dong";
    private static final String UNKNOWN_EMAIL_MESSAGE = "Email or password is incorrect";
    private static final ClientAddress CLIENT =
            ClientAddress.parse("203.0.113.9").orElseThrow();

    @Mock
    private UserRepository userRepository;

    @Mock
    private PasswordEncoder passwordEncoder;

    @Mock
    private TokenService tokenService;

    @Mock
    private RefreshTokenService refreshTokenService;
    /** Mock: accepts everything by default; the tests of the per-address limit make it throw. */
    @Mock
    private RateLimiter rateLimiter;
    /** The real limiter (a spy, so @InjectMocks can inject it): a mock would never run the password check. */
    @Spy
    private LoginConcurrencyLimiter loginLimiter = new LoginConcurrencyLimiter(2, Duration.ofSeconds(5));
    /** Mock: false by default, i.e. a dev machine, like every test that predates the limiter. */
    @Mock
    private ProductionMode productionMode;

    @Mock
    private MfaPolicy mfaPolicy;

    @Mock
    private MfaChallengeService challengeService;

    /** A real template over a transaction manager that does nothing: the gate runs, no database is needed. */
    @Spy
    private TransactionTemplate transactionTemplate = new TransactionTemplate(new NoTransactions());

    @InjectMocks
    private AuthService authService;

    private static final class NoTransactions implements PlatformTransactionManager {
        @Override
        public TransactionStatus getTransaction(TransactionDefinition definition) {
            return new SimpleTransactionStatus();
        }

        @Override
        public void commit(TransactionStatus status) {}

        @Override
        public void rollback(TransactionStatus status) {}
    }

    @BeforeEach
    void precomputeDummyHash() {
        when(passwordEncoder.encode(anyString())).thenReturn(DUMMY_HASH);
        authService.precomputeDummyHash();
    }

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    // --- Password login --------------------------------------------------------------------------------

    @Test
    void account_without_password_hash_still_runs_encoder_with_dummy_hash_then_is_rejected_like_unknown_email() {
        User githubOnly = user(UserRole.USER, UserStatus.ACTIVE, null);
        when(userRepository.findByEmail("github@blog.local")).thenReturn(Optional.of(githubOnly));
        // Deliberately make the dummy hash "match": the rejection must come from the "no hash" rule itself, not from
        // luck because
        // the dummy hash never matches.
        when(passwordEncoder.matches("bat-ky", DUMMY_HASH)).thenReturn(true);

        assertThatThrownBy(() -> authService.login(new LoginRequest("github@blog.local", "bat-ky"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.INVALID_CREDENTIALS)
                .hasFieldOrPropertyWithValue("status", HttpStatus.UNAUTHORIZED)
                .hasMessage(UNKNOWN_EMAIL_MESSAGE);
        // The same cost as an unknown email: the encoder runs, with the dummy hash, no early answer.
        verify(passwordEncoder).matches("bat-ky", DUMMY_HASH);
        verifyNoInteractions(tokenService, refreshTokenService);
    }

    @Test
    void account_with_the_unusable_password_marker_takes_the_dummy_hash_path_like_an_unknown_email() {
        // The seeded administrator of an install nobody has claimed yet (first-run setup pending) holds a marker that
        // is not an Argon2 encoding. It must cost the same Argon2 run as any other attempt: the real encoder rejects
        // the marker at once (and logs "Malformed password hash"), which would make this one address answer faster.
        User unclaimed = user(UserRole.ADMIN, UserStatus.ACTIVE, SetupAccounts.UNUSABLE_PASSWORD_HASH);
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(unclaimed));
        // Even a "match" against the dummy hash must not let the marker account in.
        when(passwordEncoder.matches("bat-ky", DUMMY_HASH)).thenReturn(true);

        assertThatThrownBy(() -> authService.login(new LoginRequest("admin@blog.local", "bat-ky"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.INVALID_CREDENTIALS)
                .hasFieldOrPropertyWithValue("status", HttpStatus.UNAUTHORIZED)
                .hasMessage(UNKNOWN_EMAIL_MESSAGE);
        verify(passwordEncoder).matches("bat-ky", DUMMY_HASH);
        verify(passwordEncoder, never()).matches(anyString(), eq(SetupAccounts.UNUSABLE_PASSWORD_HASH));
        verifyNoInteractions(tokenService, refreshTokenService);
    }

    @Test
    void unknown_email_also_runs_encoder_with_dummy_hash() {
        when(userRepository.findByEmail("nobody@blog.local")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> authService.login(new LoginRequest("nobody@blog.local", "bat-ky"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.INVALID_CREDENTIALS)
                .hasMessage(UNKNOWN_EMAIL_MESSAGE);
        verify(passwordEncoder).matches("bat-ky", DUMMY_HASH);
    }

    @Test
    void suspended_account_with_correct_password_gets_403_USER_SUSPENDED_and_no_token_issued() {
        User suspended = user(UserRole.USER, UserStatus.SUSPENDED, "$argon2id$that");
        when(userRepository.findByEmail("khoa@blog.local")).thenReturn(Optional.of(suspended));
        when(passwordEncoder.matches("dung-mat-khau", "$argon2id$that")).thenReturn(true);

        assertThatThrownBy(() -> authService.login(new LoginRequest("khoa@blog.local", "dung-mat-khau"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.USER_SUSPENDED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.FORBIDDEN);
        verifyNoInteractions(tokenService, refreshTokenService);
    }

    @Test
    void suspended_account_with_wrong_password_still_gets_only_401_so_locked_accounts_cannot_be_probed() {
        User suspended = user(UserRole.USER, UserStatus.SUSPENDED, "$argon2id$that");
        when(userRepository.findByEmail("khoa@blog.local")).thenReturn(Optional.of(suspended));
        when(passwordEncoder.matches("sai", "$argon2id$that")).thenReturn(false);

        assertThatThrownBy(() -> authService.login(new LoginRequest("khoa@blog.local", "sai"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.INVALID_CREDENTIALS)
                .hasMessage(UNKNOWN_EMAIL_MESSAGE);
    }

    @Test
    void correct_login_issues_exactly_the_token_pair_of_issueSession() {
        User admin = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(admin));
        when(passwordEncoder.matches("dung-mat-khau", "$argon2id$that")).thenReturn(true);
        stubCurrentAccessOf(admin);
        stubTokensFor(admin);

        assertThat(authService.login(new LoginRequest("admin@blog.local", "dung-mat-khau"), CLIENT))
                .isEqualTo(session());
    }

    // --- Rehash after a successful sign-in ---------------------------------------------------------------

    @Test
    void a_correct_password_over_an_outdated_hash_stores_a_fresh_hash_of_the_same_password() {
        User reader = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$old");
        when(userRepository.findByEmail("user@blog.local")).thenReturn(Optional.of(reader));
        when(passwordEncoder.matches("dung-mat-khau", "$argon2id$old")).thenReturn(true);
        when(passwordEncoder.upgradeEncoding("$argon2id$old")).thenReturn(true);
        when(passwordEncoder.encode("dung-mat-khau")).thenReturn("$argon2id$new");
        stubCurrentAccessOf(reader);
        stubTokensFor(reader);

        assertThat(authService.login(new LoginRequest("user@blog.local", "dung-mat-khau"), CLIENT))
                .isEqualTo(session());

        verify(userRepository).replacePasswordHash(reader.getId(), "$argon2id$old", "$argon2id$new");
    }

    @Test
    void a_hash_that_is_already_current_is_left_alone() {
        User reader = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$current");
        when(userRepository.findByEmail("user@blog.local")).thenReturn(Optional.of(reader));
        when(passwordEncoder.matches("dung-mat-khau", "$argon2id$current")).thenReturn(true);
        when(passwordEncoder.upgradeEncoding("$argon2id$current")).thenReturn(false);
        stubCurrentAccessOf(reader);
        stubTokensFor(reader);

        authService.login(new LoginRequest("user@blog.local", "dung-mat-khau"), CLIENT);

        verify(userRepository, never()).replacePasswordHash(any(), anyString(), anyString());
    }

    @Test
    void a_wrong_password_never_rewrites_the_hash() {
        User reader = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$old");
        when(userRepository.findByEmail("user@blog.local")).thenReturn(Optional.of(reader));
        when(passwordEncoder.matches("sai", "$argon2id$old")).thenReturn(false);

        assertThatThrownBy(() -> authService.login(new LoginRequest("user@blog.local", "sai"), CLIENT))
                .isInstanceOf(ApiException.class);

        verify(userRepository, never()).replacePasswordHash(any(), anyString(), anyString());
        verify(passwordEncoder, never()).upgradeEncoding(anyString());
    }

    @Test
    void a_suspended_account_or_a_refused_dev_password_never_rewrites_the_hash() {
        User suspended = user(UserRole.USER, UserStatus.SUSPENDED, "$argon2id$old");
        when(userRepository.findByEmail("user@blog.local")).thenReturn(Optional.of(suspended));
        when(passwordEncoder.matches("dung-mat-khau", "$argon2id$old")).thenReturn(true);

        assertThatThrownBy(() -> authService.login(new LoginRequest("user@blog.local", "dung-mat-khau"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.USER_SUSPENDED);

        User admin = user(UserRole.ADMIN, UserStatus.ACTIVE, "$argon2id$old-admin");
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(admin));
        when(passwordEncoder.matches(SeedAdmin.DEV_PASSWORD, "$argon2id$old-admin"))
                .thenReturn(true);
        when(productionMode.active()).thenReturn(true);

        assertThatThrownBy(
                        () -> authService.login(new LoginRequest("admin@blog.local", SeedAdmin.DEV_PASSWORD), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.INVALID_CREDENTIALS);

        verify(userRepository, never()).replacePasswordHash(any(), anyString(), anyString());
    }

    @Test
    void a_rehash_that_fails_does_not_fail_the_sign_in() {
        User reader = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$old");
        when(userRepository.findByEmail("user@blog.local")).thenReturn(Optional.of(reader));
        when(passwordEncoder.matches("dung-mat-khau", "$argon2id$old")).thenReturn(true);
        when(passwordEncoder.upgradeEncoding("$argon2id$old")).thenReturn(true);
        when(passwordEncoder.encode("dung-mat-khau")).thenThrow(new IllegalStateException("no memory"));
        stubCurrentAccessOf(reader);
        stubTokensFor(reader);

        assertThat(authService.login(new LoginRequest("user@blog.local", "dung-mat-khau"), CLIENT))
                .isEqualTo(session());

        verify(userRepository, never()).replacePasswordHash(any(), anyString(), anyString());
    }

    // --- Dev password and the password check limit ------------------------------------------------------

    @Test
    void
            public_site_rejects_dev_password_even_if_hash_matches_after_exactly_one_Argon2_run_with_wrong_password_message() {
        User admin = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$hash-cua-admin12345");
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(admin));
        when(passwordEncoder.matches(SeedAdmin.DEV_PASSWORD, "$argon2id$hash-cua-admin12345"))
                .thenReturn(true);
        when(productionMode.active()).thenReturn(true);

        assertThatThrownBy(
                        () -> authService.login(new LoginRequest("admin@blog.local", SeedAdmin.DEV_PASSWORD), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.INVALID_CREDENTIALS)
                .hasFieldOrPropertyWithValue("status", HttpStatus.UNAUTHORIZED)
                .hasMessage(UNKNOWN_EMAIL_MESSAGE);
        // The same cost as one wrong password: Argon2 already ran, no early answer.
        verify(passwordEncoder).matches(SeedAdmin.DEV_PASSWORD, "$argon2id$hash-cua-admin12345");
        verifyNoInteractions(tokenService, refreshTokenService);
    }

    @Test
    void dev_machine_can_still_log_in_with_dev_password() {
        // Control for the test above: the rejection is because of the public site, not the password itself.
        User admin = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$hash-cua-admin12345");
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(admin));
        when(passwordEncoder.matches(SeedAdmin.DEV_PASSWORD, "$argon2id$hash-cua-admin12345"))
                .thenReturn(true);
        stubCurrentAccessOf(admin);
        stubTokensFor(admin);

        assertThat(authService.login(new LoginRequest("admin@blog.local", SeedAdmin.DEV_PASSWORD), CLIENT))
                .isEqualTo(session());
    }

    @Test
    void public_site_still_accepts_real_password() {
        User admin = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(admin));
        when(passwordEncoder.matches("mat-khau-that-du-dai", "$argon2id$that")).thenReturn(true);
        when(productionMode.active()).thenReturn(true);
        stubCurrentAccessOf(admin);
        stubTokensFor(admin);

        assertThat(authService.login(new LoginRequest("admin@blog.local", "mat-khau-that-du-dai"), CLIENT))
                .isEqualTo(session());
    }

    @Test
    void both_real_hash_and_dummy_hash_are_checked_through_the_limiter() {
        User admin = user(UserRole.ADMIN, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(admin));
        when(userRepository.findByEmail("nobody@blog.local")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> authService.login(new LoginRequest("admin@blog.local", "sai"), CLIENT))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> authService.login(new LoginRequest("nobody@blog.local", "sai"), CLIENT))
                .isInstanceOf(ApiException.class);

        verify(loginLimiter, times(2)).verify(any());
        verify(passwordEncoder).matches("sai", "$argon2id$that");
        verify(passwordEncoder).matches("sai", DUMMY_HASH);
    }

    @Test
    void exhausted_password_check_quota_gives_429_without_running_Argon2_and_issues_no_token() {
        User admin = user(UserRole.ADMIN, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(admin));
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "busy"))
                .when(loginLimiter)
                .verify(any());

        assertThatThrownBy(() -> authService.login(new LoginRequest("admin@blog.local", "dung-mat-khau"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.TOO_MANY_REQUESTS);
        verify(passwordEncoder, never()).matches(anyString(), anyString());
        verifyNoInteractions(tokenService, refreshTokenService);
    }

    @Test
    void every_login_attempt_is_counted_against_its_client_address_before_anything_else() {
        User admin = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(admin));
        when(passwordEncoder.matches("dung-mat-khau", "$argon2id$that")).thenReturn(true);
        stubCurrentAccessOf(admin);
        stubTokensFor(admin);

        authService.login(new LoginRequest("admin@blog.local", "dung-mat-khau"), CLIENT);

        InOrder order = inOrder(rateLimiter, userRepository);
        order.verify(rateLimiter).check(RateLimiter.LOGIN_CLIENT, CLIENT.key());
        order.verify(userRepository).findByEmail("admin@blog.local");
    }

    @Test
    void a_client_address_over_its_login_limit_gets_429_before_the_database_or_Argon2_is_touched() {
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "slow down"))
                .when(rateLimiter)
                .check(RateLimiter.LOGIN_CLIENT, CLIENT.key());

        assertThatThrownBy(() -> authService.login(new LoginRequest("admin@blog.local", "dung-mat-khau"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.TOO_MANY_REQUESTS);
        verifyNoInteractions(userRepository, tokenService, refreshTokenService);
        verify(passwordEncoder, never()).matches(anyString(), anyString());
        // The password-check slots were not asked for either.
        verify(loginLimiter, never()).verify(any());
    }

    @Test
    void refresh_is_counted_against_its_client_address_and_refused_before_the_token_is_looked_at() {
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "slow down"))
                .when(rateLimiter)
                .check(RateLimiter.REFRESH_CLIENT, CLIENT.key());

        assertThatThrownBy(() -> authService.refresh(new RefreshRequest("a-refresh-token"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED);
        verifyNoInteractions(refreshTokenService, tokenService);
    }

    @Test
    void issueSession_assembles_access_token_new_refresh_token_and_lifetime_for_the_given_proof() {
        // Password login and GitHub login end in this method (through the gate): one single place decides the shape of
        // the token pair.
        User reader = user(UserRole.USER, UserStatus.ACTIVE, null);
        Instant signedIn = Instant.parse("2026-10-18T10:00:00Z");
        SessionProof proof = SessionProof.verified(signedIn);
        UUID sessionId = UUID.randomUUID();
        when(refreshTokenService.open(reader, proof))
                .thenReturn(new RefreshTokenService.IssuedToken("refresh-token", sessionId, 604_800L));
        when(tokenService.mint(reader, sessionId, signedIn)).thenReturn("access-token");
        when(tokenService.accessTokenSeconds()).thenReturn(900L);

        assertThat(authService.issueSession(reader, proof))
                .isEqualTo(new TokenResponse("access-token", "refresh-token", 900, 604_800L));
    }

    @Test
    void the_gate_opens_a_session_proved_by_the_first_factor_only_for_a_reader() {
        User reader = user(UserRole.USER, UserStatus.ACTIVE, null);
        when(userRepository.findAccessById(reader.getId()))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.ACTIVE)));
        stubTokensFor(reader);

        assertThat(authService.completeFirstFactor(reader, FirstFactor.GITHUB)).isEqualTo(session());

        ArgumentCaptor<SessionProof> proof = ArgumentCaptor.forClass(SessionProof.class);
        verify(refreshTokenService).open(org.mockito.ArgumentMatchers.eq(reader), proof.capture());
        assertThat(proof.getValue().mfaVerifiedAt())
                .as("no second factor was verified")
                .isNull();
        assertThat(proof.getValue().authenticatedAt()).isCloseTo(Instant.now(), within(10, ChronoUnit.SECONDS));
    }

    // --- The first-factor gate ---------------------------------------------------------------------------

    private static FirstFactorResult session() {
        return new FirstFactorResult.Session(new TokenResponse("access-token", "refresh-token", 900, 604_800L));
    }

    private static FirstFactorResult.Challenge challengeOf(FirstFactorResult result) {
        return (FirstFactorResult.Challenge) result;
    }

    @Test
    void an_enrolled_admin_gets_a_verify_challenge_and_no_token() {
        User admin = user(UserRole.ADMIN, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findAccessById(admin.getId()))
                .thenReturn(Optional.of(new UserAccess(UserRole.ADMIN, UserStatus.ACTIVE)));
        when(mfaPolicy.required(UserRole.ADMIN, admin.getId())).thenReturn(true);
        when(mfaPolicy.enrolled(admin.getId())).thenReturn(true);
        when(challengeService.issue(admin, ChallengePurpose.VERIFY, FirstFactor.PASSWORD))
                .thenReturn(new MfaChallengeService.Issued("raw-challenge", ChallengePurpose.VERIFY, 300, false));

        MfaChallengeResponse challenge = challengeOf(authService.completeFirstFactor(admin, FirstFactor.PASSWORD))
                .challenge();

        assertThat(challenge.challenge()).isEqualTo("raw-challenge");
        assertThat(challenge.purpose()).isEqualTo("VERIFY");
        assertThat(challenge.methods()).containsExactly("TOTP", "RECOVERY_CODE");
        assertThat(challenge.expiresIn()).isEqualTo(300);
        assertThat(challenge.enrollmentCodeRequired()).isFalse();
        verifyNoInteractions(tokenService, refreshTokenService);
    }

    @Test
    void an_admin_without_an_authenticator_gets_an_enroll_challenge_that_says_whether_a_code_is_needed() {
        User admin = user(UserRole.ADMIN, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findAccessById(admin.getId()))
                .thenReturn(Optional.of(new UserAccess(UserRole.ADMIN, UserStatus.ACTIVE)));
        when(mfaPolicy.required(UserRole.ADMIN, admin.getId())).thenReturn(true);
        when(mfaPolicy.enrolled(admin.getId())).thenReturn(false);
        when(challengeService.issue(admin, ChallengePurpose.ENROLL, FirstFactor.GITHUB))
                .thenReturn(new MfaChallengeService.Issued("raw-challenge", ChallengePurpose.ENROLL, 300, true));

        MfaChallengeResponse challenge = challengeOf(authService.completeFirstFactor(admin, FirstFactor.GITHUB))
                .challenge();

        assertThat(challenge.purpose()).isEqualTo("ENROLL");
        assertThat(challenge.methods()).containsExactly("TOTP");
        assertThat(challenge.enrollmentCodeRequired()).isTrue();
        verifyNoInteractions(tokenService, refreshTokenService);
    }

    @Test
    void an_author_without_an_enrollment_gets_a_session_after_the_account_row_is_locked() {
        User author = user(UserRole.AUTHOR, UserStatus.ACTIVE, null);
        when(userRepository.findAccessById(author.getId()))
                .thenReturn(Optional.of(new UserAccess(UserRole.AUTHOR, UserStatus.ACTIVE)));
        when(mfaPolicy.required(UserRole.AUTHOR, author.getId())).thenReturn(false);
        stubTokensFor(author);

        FirstFactorResult result = authService.completeFirstFactor(author, FirstFactor.GITHUB);

        assertThat(result)
                .isEqualTo(new FirstFactorResult.Session(
                        new TokenResponse("access-token", "refresh-token", 900, 604_800L)));
        // The lock comes first: an enrollment confirming in another tab is either entirely before or entirely after.
        InOrder order = inOrder(userRepository, mfaPolicy);
        order.verify(userRepository).lockById(author.getId());
        order.verify(mfaPolicy).required(UserRole.AUTHOR, author.getId());
        verifyNoInteractions(challengeService);
    }

    @Test
    void a_reader_gets_a_session_after_the_role_is_read_again_under_the_account_lock() {
        User reader = user(UserRole.USER, UserStatus.ACTIVE, null);
        when(userRepository.findAccessById(reader.getId()))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.ACTIVE)));
        stubTokensFor(reader);

        assertThat(authService.completeFirstFactor(reader, FirstFactor.GITHUB))
                .isInstanceOf(FirstFactorResult.Session.class);

        // Every role takes the same path (audit 114): lock the row, read the role again, then decide.
        InOrder order = inOrder(userRepository, mfaPolicy);
        order.verify(userRepository).lockById(reader.getId());
        order.verify(userRepository).findAccessById(reader.getId());
        order.verify(mfaPolicy).required(UserRole.USER, reader.getId());
        verifyNoInteractions(challengeService);
    }

    @Test
    void a_promotion_that_lands_between_the_password_and_the_gate_gets_a_challenge_and_no_session() {
        // The account was a reader when its login loaded it (and waited for an Argon2 slot); an administrator promoted
        // it
        // since. The gate decides on the role it reads under the lock, not on the stale entity.
        User staleReader = user(UserRole.USER, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findAccessById(staleReader.getId()))
                .thenReturn(Optional.of(new UserAccess(UserRole.ADMIN, UserStatus.ACTIVE)));
        when(mfaPolicy.required(UserRole.ADMIN, staleReader.getId())).thenReturn(true);
        when(mfaPolicy.enrolled(staleReader.getId())).thenReturn(true);
        when(challengeService.issue(staleReader, ChallengePurpose.VERIFY, FirstFactor.PASSWORD))
                .thenReturn(new MfaChallengeService.Issued("raw-challenge", ChallengePurpose.VERIFY, 300, false));

        FirstFactorResult result = authService.completeFirstFactor(staleReader, FirstFactor.PASSWORD);

        assertThat(challengeOf(result).challenge().challenge()).isEqualTo("raw-challenge");
        verifyNoInteractions(tokenService, refreshTokenService);
    }

    @Test
    void a_demotion_that_lands_between_the_password_and_the_gate_gets_a_session_without_a_second_step() {
        User staleAdmin = user(UserRole.ADMIN, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findAccessById(staleAdmin.getId()))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.ACTIVE)));
        stubTokensFor(staleAdmin);

        assertThat(authService.completeFirstFactor(staleAdmin, FirstFactor.PASSWORD))
                .isInstanceOf(FirstFactorResult.Session.class);

        verify(mfaPolicy).required(UserRole.USER, staleAdmin.getId());
        verifyNoInteractions(challengeService);
    }

    @Test
    void a_reader_suspended_between_the_password_and_the_gate_gets_no_session() {
        User reader = user(UserRole.USER, UserStatus.ACTIVE, null);
        when(userRepository.findAccessById(reader.getId()))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.SUSPENDED)));

        assertThatThrownBy(() -> authService.completeFirstFactor(reader, FirstFactor.GITHUB))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.USER_SUSPENDED);
        verifyNoInteractions(challengeService, tokenService, refreshTokenService);
    }

    @Test
    void a_suspension_that_lands_between_the_password_and_the_gate_still_wins() {
        User admin = user(UserRole.ADMIN, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findAccessById(admin.getId()))
                .thenReturn(Optional.of(new UserAccess(UserRole.ADMIN, UserStatus.SUSPENDED)));

        assertThatThrownBy(() -> authService.completeFirstFactor(admin, FirstFactor.PASSWORD))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.USER_SUSPENDED);
        verifyNoInteractions(challengeService, tokenService, refreshTokenService);
    }

    @Test
    void a_correct_password_of_an_admin_reaches_the_gate_and_a_wrong_one_never_does() {
        User admin = user(UserRole.ADMIN, UserStatus.ACTIVE, "$argon2id$that");
        when(userRepository.findByEmail("admin@blog.local")).thenReturn(Optional.of(admin));
        when(passwordEncoder.matches("sai", "$argon2id$that")).thenReturn(false);

        assertThatThrownBy(() -> authService.login(new LoginRequest("admin@blog.local", "sai"), CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.INVALID_CREDENTIALS);

        verifyNoInteractions(mfaPolicy, challengeService);
        verify(userRepository, never()).lockById(any());
    }

    // --- /auth/me --------------------------------------------------------------------------------------

    @Test
    void me_returns_all_v5_fields_of_reader() {
        User reader = user(UserRole.USER, UserStatus.ACTIVE, null);
        reader.setEmail(null);
        reader.setGithubLogin("octocat");
        reader.setAvatarUrl("https://avatars.githubusercontent.com/u/583231?v=4");
        reader.setCreatedAt(Instant.parse("2026-10-01T08:00:00Z"));
        signedInAs(reader);
        when(userRepository.findById(reader.getId())).thenReturn(Optional.of(reader));

        assertThat(authService.me())
                .isEqualTo(new CurrentUserResponse(
                        reader.getId(),
                        null,
                        reader.getDisplayName(),
                        "USER",
                        "octocat",
                        "https://avatars.githubusercontent.com/u/583231?v=4",
                        "ACTIVE",
                        Instant.parse("2026-10-01T08:00:00Z")));
    }

    @Test
    void me_of_suspended_account_gets_403_USER_SUSPENDED() {
        User suspended = user(UserRole.USER, UserStatus.SUSPENDED, null);
        signedInAs(suspended);
        when(userRepository.findById(suspended.getId())).thenReturn(Optional.of(suspended));

        assertThatThrownBy(() -> authService.me())
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.USER_SUSPENDED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.FORBIDDEN);
    }

    @Test
    void me_of_account_that_no_longer_exists_gets_401() {
        User gone = user(UserRole.USER, UserStatus.ACTIVE, null);
        signedInAs(gone);
        when(userRepository.findById(gone.getId())).thenReturn(Optional.empty());

        assertThatThrownBy(() -> authService.me())
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.UNAUTHENTICATED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.UNAUTHORIZED);
    }

    // --- Data ------------------------------------------------------------------------------------------

    private static User user(UserRole role, UserStatus status, String passwordHash) {
        User user = new User();
        user.setId(UUID.randomUUID());
        user.setEmail(role.name().toLowerCase(Locale.ROOT) + "@blog.local");
        user.setPasswordHash(passwordHash);
        user.setDisplayName("User " + role.name());
        user.setRole(role);
        user.setStatus(status);
        return user;
    }

    /** What the gate reads under the account lock: the role and the status the account has now. */
    private void stubCurrentAccessOf(User user) {
        when(userRepository.findAccessById(user.getId()))
                .thenReturn(Optional.of(new UserAccess(user.getRole(), user.getStatus())));
    }

    private void stubTokensFor(User user) {
        UUID sessionId = UUID.randomUUID();
        when(refreshTokenService.open(org.mockito.ArgumentMatchers.eq(user), any(SessionProof.class)))
                .thenReturn(new RefreshTokenService.IssuedToken("refresh-token", sessionId, 604_800L));
        when(tokenService.mint(
                        org.mockito.ArgumentMatchers.eq(user),
                        org.mockito.ArgumentMatchers.eq(sessionId),
                        any(Instant.class)))
                .thenReturn("access-token");
        when(tokenService.accessTokenSeconds()).thenReturn(900L);
    }

    private static void signedInAs(User user) {
        Jwt jwt = Jwt.withTokenValue("token")
                .header("alg", "HS256")
                .subject(user.getId().toString())
                .claim("role", user.getRole().name())
                .build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));
    }
}
