package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class RefreshTokenServiceIT extends AbstractIntegrationTest {

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private RefreshTokenRepository refreshTokenRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private User admin() {
        return userRepository.findByEmail("admin@blog.local").orElseThrow();
    }

    @Test
    void storesOnlyTheHashOfTheIssuedToken() {
        String raw = auth.verifiedRefreshToken(admin());

        assertThat(raw).isNotBlank();
        // The raw value must not be recoverable from the table. Searching for it is the
        // assertion; finding the row by its hash is the control that proves the row exists
        // at all, so this is not passing merely because nothing was written.
        assertThat(refreshTokenRepository.findByTokenHash(raw)).isEmpty();
        assertThat(refreshTokenRepository.findByTokenHash(RefreshTokenService.hash(raw)))
                .isPresent();
    }

    @Test
    void issuesDifferentTokensEachTime() {
        assertThat(auth.verifiedRefreshToken(admin())).isNotEqualTo(auth.verifiedRefreshToken(admin()));
    }

    @Test
    void rotateReturnsANewTokenAndRevokesTheOld() {
        String first = auth.verifiedRefreshToken(admin());

        RefreshTokenService.RotationResult result = refreshTokenService.rotate(first);

        assertThat(result.newRawToken()).isNotEqualTo(first);
        assertThat(result.user().getEmail()).isEqualTo("admin@blog.local");
        assertThat(refreshTokenRepository
                        .findByTokenHash(RefreshTokenService.hash(first))
                        .orElseThrow()
                        .getRevokedAt())
                .isNotNull();
    }

    @Test
    void rotationCopiesTheProofOfTheSessionUnchangedAndNeverRefreshesIt() {
        // A session that started 40 minutes ago and verified a second factor 35 minutes ago.
        Instant signedIn = Instant.now().minus(40, ChronoUnit.MINUTES).truncatedTo(ChronoUnit.MICROS);
        Instant verified = signedIn.plus(5, ChronoUnit.MINUTES);
        String first = refreshTokenService
                .open(admin(), new SessionProof(signedIn, verified))
                .rawToken();

        RefreshTokenService.RotationResult result = refreshTokenService.rotate(first);
        RefreshTokenService.RotationResult second = refreshTokenService.rotate(result.newRawToken());

        assertThat(result.authenticatedAt()).isEqualTo(signedIn);
        assertThat(second.authenticatedAt()).isEqualTo(signedIn);
        for (String raw : new String[] {first, result.newRawToken(), second.newRawToken()}) {
            var row = refreshTokenRepository
                    .findByTokenHash(RefreshTokenService.hash(raw))
                    .orElseThrow();
            assertThat(row.getAuthenticatedAt()).isEqualTo(signedIn);
            assertThat(row.getMfaVerifiedAt()).isEqualTo(verified);
        }
        // The session id is copied too, like before: the access tokens of the session stay valid across rotations.
        assertThat(second.sessionId()).isEqualTo(result.sessionId());
    }

    @Test
    void aSessionWithoutASecondFactorStaysWithoutOneAfterRotation() {
        Instant signedIn = Instant.now().minusSeconds(60).truncatedTo(ChronoUnit.MICROS);
        String first = refreshTokenService
                .open(auth.createReader(auth.nextGithubId(), "no-second-factor"), SessionProof.firstFactor(signedIn))
                .rawToken();

        RefreshTokenService.RotationResult result = refreshTokenService.rotate(first);

        var row = refreshTokenRepository
                .findByTokenHash(RefreshTokenService.hash(result.newRawToken()))
                .orElseThrow();
        assertThat(row.getMfaVerifiedAt()).isNull();
        assertThat(row.getAuthenticatedAt()).isEqualTo(signedIn);
    }

    @Test
    void rotatingATokenTwiceIsRejectedAsRevoked() {
        String first = auth.verifiedRefreshToken(admin());
        refreshTokenService.rotate(first);

        assertThatThrownBy(() -> refreshTokenService.rotate(first))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_REVOKED);
    }

    @Test
    void rejectsAnUnknownToken() {
        assertThatThrownBy(() -> refreshTokenService.rotate("never-issued"))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_INVALID);
    }

    @Test
    void rejectsAnExpiredToken() {
        String raw = auth.verifiedRefreshToken(admin());
        var row = refreshTokenRepository
                .findByTokenHash(RefreshTokenService.hash(raw))
                .orElseThrow();
        // A real past timestamp rather than a mocked clock: the production code reads
        // Instant.now(), and a mocked clock would let an always-true comparison pass.
        row.setExpiresAt(Instant.now().minus(1, ChronoUnit.MINUTES));
        refreshTokenRepository.save(row);

        assertThatThrownBy(() -> refreshTokenService.rotate(raw))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_EXPIRED);
    }

    @Test
    void revokeMakesATokenUnusable() {
        String raw = auth.verifiedRefreshToken(admin());
        refreshTokenService.revoke(raw);

        assertThatThrownBy(() -> refreshTokenService.rotate(raw))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_REVOKED);
    }

    @Test
    void signingOutWithAnAlreadyRotatedTokenEndsTheLiveSuccessorOfThatSession() {
        // The token a client holds after a lost rotation answer (or Next's short refresh memo) is revoked, while its
        // successor
        // is the live one. Signing out with it used to answer 401 and end nothing, so the session stayed alive after
        // "Sign out".
        User reader = auth.createReader(
                auth.nextGithubId(),
                "dang-xuat-xoay-" + UUID.randomUUID().toString().substring(0, 8));
        String first = auth.verifiedRefreshToken(reader);
        String successor = refreshTokenService.rotate(first).newRawToken();
        assertThat(liveTokenCount(reader)).isEqualTo(1);

        refreshTokenService.revoke(first);

        assertThat(revokedAt(successor)).isNotNull();
        assertThat(liveTokenCount(reader)).isZero();
    }

    @Test
    void signingOutWithATokenOfOneSessionLeavesTheOtherSessionsOfThePersonAlive() {
        User reader = auth.createReader(
                auth.nextGithubId(),
                "dang-xuat-rieng-" + UUID.randomUUID().toString().substring(0, 8));
        String thisDevice = auth.verifiedRefreshToken(reader);
        String otherDevice = auth.verifiedRefreshToken(reader);

        refreshTokenService.revoke(thisDevice);

        assertThat(revokedAt(otherDevice)).isNull();
        assertThat(liveTokenCount(reader)).isEqualTo(1);
    }

    @Test
    void signingOutWithATokenThatWasNeverIssuedIsStillRefused() {
        assertThatThrownBy(() -> refreshTokenService.revoke("never-issued-" + UUID.randomUUID()))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_INVALID);
    }

    @Test
    void twoConcurrentRotationsOfTheSameTokenProduceExactlyOneSession() throws Exception {
        String raw = auth.verifiedRefreshToken(admin());
        var start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            var attempts = List.of(
                    pool.submit(() -> {
                        start.await();
                        return refreshTokenService.rotate(raw);
                    }),
                    pool.submit(() -> {
                        start.await();
                        return refreshTokenService.rotate(raw);
                    }));
            start.countDown();

            int succeeded = 0;
            int rejected = 0;
            for (var attempt : attempts) {
                try {
                    attempt.get();
                    succeeded++;
                } catch (ExecutionException e) {
                    assertThat(e.getCause()).isInstanceOf(ApiException.class);
                    assertThat(((ApiException) e.getCause()).getCode()).isEqualTo(ErrorCode.REFRESH_TOKEN_REVOKED);
                    rejected++;
                }
            }

            // Exactly one, not "at least one": before the conditional UPDATE both callers
            // succeeded and one token became two live sessions, which is the thing
            // rotation exists to prevent.
            assertThat(succeeded).isEqualTo(1);
            assertThat(rejected).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    // --- Rotation against a bulk revocation (audit 113) -------------------------------------------------------

    @Test
    void a_rotation_that_overlaps_a_bulk_revocation_leaves_no_live_session_behind() throws Exception {
        User reader = auth.createReader(
                auth.nextGithubId(),
                "chong-cheo-" + UUID.randomUUID().toString().substring(0, 8));
        String raw = auth.verifiedRefreshToken(reader);
        var successorInserted = new CountDownLatch(1);
        var mayCommit = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            // The rotation has inserted its successor and has not committed yet: the exact moment the bulk statement of
            // "sign out everywhere" cannot see the successor.
            var rotation = pool.submit(() -> new TransactionTemplate(transactionManager).execute(status -> {
                refreshTokenService.rotate(raw);
                successorInserted.countDown();
                awaitUninterruptibly(mayCommit);
                return null;
            }));
            assertThat(successorInserted.await(30, TimeUnit.SECONDS)).isTrue();
            var signOutEverywhere = pool.submit(
                    () -> inTransaction(() -> refreshTokenService.revokeAllSessions(reader.getId(), Instant.now())));
            // Before the fix the revocation went through at once and left the successor alone; now it waits for the
            // rotation, because both take the account row. Either way the rotation may commit now.
            Thread.sleep(500);
            mayCommit.countDown();
            rotation.get(30, TimeUnit.SECONDS);
            signOutEverywhere.get(30, TimeUnit.SECONDS);

            assertThat(liveTokenCount(reader))
                    .as("every session of the person is revoked, the successor of the overlapping rotation included")
                    .isZero();
        } finally {
            mayCommit.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void a_rotation_that_starts_during_a_bulk_revocation_is_refused_and_issues_nothing() throws Exception {
        User reader = auth.createReader(
                auth.nextGithubId(),
                "chong-cheo-hai-" + UUID.randomUUID().toString().substring(0, 8));
        String raw = auth.verifiedRefreshToken(reader);
        var revoked = new CountDownLatch(1);
        var mayCommit = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            var signOutEverywhere = pool.submit(() -> new TransactionTemplate(transactionManager).execute(status -> {
                refreshTokenService.revokeAllSessions(reader.getId(), Instant.now());
                revoked.countDown();
                awaitUninterruptibly(mayCommit);
                return null;
            }));
            assertThat(revoked.await(30, TimeUnit.SECONDS)).isTrue();
            var rotation = pool.submit(() -> refreshTokenService.rotate(raw));
            Thread.sleep(500);
            mayCommit.countDown();
            signOutEverywhere.get(30, TimeUnit.SECONDS);

            assertThatThrownBy(() -> rotation.get(30, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class)
                    .hasCauseInstanceOf(ApiException.class);
            assertThat(liveTokenCount(reader)).isZero();
        } finally {
            mayCommit.countDown();
            pool.shutdownNow();
        }
    }

    private static void awaitUninterruptibly(CountDownLatch latch) {
        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // --- Suspension ------------------------------------------------------------------------------------

    @Test
    void suspended_account_cannot_rotate_refresh_token_and_that_token_is_not_consumed() {
        User reader = auth.createReader(auth.nextGithubId(), "refresh-khoa");
        // Control: a reader can refresh a token like any other account, so the 403 below is because of the lock.
        String live =
                refreshTokenService.rotate(auth.verifiedRefreshToken(reader)).newRawToken();
        auth.setStatus(reader.getId(), UserStatus.SUSPENDED);

        assertThatThrownBy(() -> refreshTokenService.rotate(live))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.USER_SUSPENDED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.FORBIDDEN);

        // No rotation: the old token is not revoked, and no new token is issued.
        assertThat(revokedAt(live)).isNull();
        assertThat(liveTokenCount(reader)).isEqualTo(1);
        // Logout of a locked person still works: revoking is never blocked.
        refreshTokenService.revoke(live);
        assertThat(revokedAt(live)).isNotNull();
    }

    @Test
    void suspension_is_checked_before_both_revocation_and_expiry_so_locked_person_always_gets_USER_SUSPENDED() {
        User reader = auth.createReader(auth.nextGithubId(), "refresh-khoa-thu-hoi");
        String live = auth.verifiedRefreshToken(reader);
        String expired = auth.verifiedRefreshToken(reader);
        var expiredRow = refreshTokenRepository
                .findByTokenHash(RefreshTokenService.hash(expired))
                .orElseThrow();
        expiredRow.setExpiresAt(Instant.now().minus(1, ChronoUnit.MINUTES));
        refreshTokenRepository.save(expiredRow);

        // Exactly like a real suspension: change the status and then revoke every live token. If the "already revoked"
        // check came first,
        // the locked person would only get REFRESH_TOKEN_REVOKED, which Next treats as REVOKED = losing a token
        // rotation race and keeps
        // the cookie as is; 403 USER_SUSPENDED is what makes it clear the cookie.
        auth.setStatus(reader.getId(), UserStatus.SUSPENDED);
        inTransaction(() -> refreshTokenRepository.revokeAllLiveForUser(reader.getId(), Instant.now()));

        assertThatThrownBy(() -> refreshTokenService.rotate(live))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.USER_SUSPENDED);
        assertThatThrownBy(() -> refreshTokenService.rotate(expired))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.USER_SUSPENDED);
        // A token nobody issued is still only INVALID: it says nothing about any account.
        assertThatThrownBy(() -> refreshTokenService.rotate("never-issued-" + reader.getId()))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_INVALID);
    }

    @Test
    void revokeAllLiveForUser_revokes_every_live_token_of_exactly_one_person_and_leaves_revoked_tokens_alone() {
        User reader = auth.createReader(auth.nextGithubId(), "thu-hoi-het");
        User other = auth.createReader(auth.nextGithubId(), "nguoi-khac");
        String first = auth.verifiedRefreshToken(reader);
        String second = auth.verifiedRefreshToken(reader);
        String alreadyRevoked = auth.verifiedRefreshToken(reader);
        refreshTokenService.revoke(alreadyRevoked);
        Instant revokedEarlier = revokedAt(alreadyRevoked);
        Instant expiryOfAlreadyRevoked = expiresAt(alreadyRevoked);
        String othersToken = auth.verifiedRefreshToken(other);
        Instant expiryOfOthersToken = expiresAt(othersToken);
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);

        int changed = inTransaction(() -> refreshTokenRepository.revokeAllLiveForUser(reader.getId(), now));

        assertThat(changed).isEqualTo(2);
        assertThat(revokedAt(first)).isEqualTo(now);
        assertThat(revokedAt(second)).isEqualTo(now);
        assertThat(revokedAt(alreadyRevoked)).isEqualTo(revokedEarlier);
        assertThat(revokedAt(othersToken)).isNull();
        // A bulk revoke also ends the expiry of the tokens it revokes, so such a token coming back is never treated as
        // reuse. A token revoked earlier and tokens of other people keep their expiry.
        assertThat(expiresAt(first)).isEqualTo(now);
        assertThat(expiresAt(second)).isEqualTo(now);
        assertThat(expiresAt(alreadyRevoked)).isEqualTo(expiryOfAlreadyRevoked);
        assertThat(expiresAt(othersToken)).isEqualTo(expiryOfOthersToken);
    }

    @Test
    void revokeAllLiveForUser_does_not_extend_expiry_of_expired_token() {
        User reader = auth.createReader(
                auth.nextGithubId(), "het-han-" + UUID.randomUUID().toString().substring(0, 8));
        String expired = auth.verifiedRefreshToken(reader);
        jdbcTemplate.update(
                "UPDATE refresh_tokens SET expires_at = now() - interval '1 day' WHERE token_hash = ?",
                RefreshTokenService.hash(expired));
        Instant expiredAt = expiresAt(expired);

        inTransaction(() -> refreshTokenRepository.revokeAllLiveForUser(reader.getId(), Instant.now()));

        assertThat(revokedAt(expired)).isNotNull();
        assertThat(expiresAt(expired)).isEqualTo(expiredAt);
    }

    // --- Reuse of a revoked token ------------------------------------------------------------------------

    @Test
    void rotated_token_reused_after_grace_period_is_still_401_REVOKED_and_only_the_session_it_belongs_to_is_ended() {
        User reader = auth.createReader(
                auth.nextGithubId(), "dung-lai-" + UUID.randomUUID().toString().substring(0, 8));
        User other = auth.createReader(
                auth.nextGithubId(),
                "nguoi-ngoai-" + UUID.randomUUID().toString().substring(0, 8));
        String stolen = auth.verifiedRefreshToken(reader);
        String successor = refreshTokenService.rotate(stolen).newRawToken();
        String otherDevice = auth.verifiedRefreshToken(reader);
        String othersToken = auth.verifiedRefreshToken(other);
        // The rotation happened 3 minutes ago: outside the default 2-minute grace period.
        shiftIntoThePast(stolen, Duration.ofMinutes(3));

        // The answer is like for any revoked token: Next treats REVOKED as losing a race and keeps the cookie.
        assertThatThrownBy(() -> refreshTokenService.rotate(stolen))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_REVOKED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.UNAUTHORIZED)
                .hasMessage("Refresh token has been used already");

        // Read back from the DB AFTER the rotate() transaction has ended. rotate() is @Transactional and the 401 is a
        // RuntimeException: if the revoke rolled back with that error, the successor below would still be alive.
        assertThat(revokedAt(successor)).isNotNull();
        // The bulk revoke also ends the expiry: the holder of the successor gets EXPIRED, the answer that makes the
        // frontend clear the cookie.
        assertThatThrownBy(() -> refreshTokenService.rotate(successor))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_EXPIRED);
        // Only that session (audit 104): the person's other device and the sessions of other people are untouched.
        assertThat(revokedAt(otherDevice)).isNull();
        assertThat(liveTokenCount(reader)).isEqualTo(1);
        assertThat(revokedAt(othersToken)).isNull();
    }

    @Test
    void reuse_after_grace_revokes_only_the_replayed_token_family_and_other_devices_stay_signed_in() {
        User reader = auth.createReader(
                auth.nextGithubId(),
                "mat-phan-hoi-" + UUID.randomUUID().toString().substring(0, 8));
        String deviceOne = auth.verifiedRefreshToken(reader);
        String deviceTwo = auth.verifiedRefreshToken(reader);
        // The rotation of device one committed, but its response was lost on the way (a proxy answering 502): the
        // browser
        // still holds the old token, and nobody holds the new one.
        String lostSuccessor = refreshTokenService.rotate(deviceOne).newRawToken();
        shiftIntoThePast(deviceOne, Duration.ofMinutes(3));

        // The browser comes back with the old token after the grace period: REVOKED, and that lineage ends...
        assertThatThrownBy(() -> refreshTokenService.rotate(deviceOne))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_REVOKED);
        assertThat(revokedAt(lostSuccessor)).isNotNull();
        assertThatThrownBy(() -> refreshTokenService.rotate(lostSuccessor))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_EXPIRED);
        // ...but the second device of the same person stays signed in. Before the fix it was signed out as collateral.
        assertThat(refreshTokenService.rotate(deviceTwo).newRawToken()).isNotBlank();
    }

    @Test
    void a_suspension_still_ends_every_session_of_the_person_whatever_the_device() {
        // The narrowing above is for the reuse detection only: who may hold the account is not in doubt per device.
        User reader = auth.createReader(
                auth.nextGithubId(), "dinh-chi-" + UUID.randomUUID().toString().substring(0, 8));
        String deviceOne = auth.verifiedRefreshToken(reader);
        String deviceTwo = auth.verifiedRefreshToken(reader);

        inTransaction(() -> refreshTokenService.revokeAllSessions(reader.getId(), Instant.now()));

        assertThat(revokedAt(deviceOne)).isNotNull();
        assertThat(revokedAt(deviceTwo)).isNotNull();
        assertThat(liveTokenCount(reader)).isZero();
    }

    @Test
    void reuse_within_grace_period_is_losing_rotation_race_and_winners_session_stays_alive() {
        User reader = auth.createReader(
                auth.nextGithubId(), "an-han-" + UUID.randomUUID().toString().substring(0, 8));
        String first = auth.verifiedRefreshToken(reader);
        String successor = refreshTokenService.rotate(first).newRawToken();

        // Like two Next requests carrying the same token within a few seconds: the loser gets REVOKED, nobody is logged
        // out.
        assertThatThrownBy(() -> refreshTokenService.rotate(first))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_REVOKED);

        assertThat(revokedAt(successor)).isNull();
        assertThat(refreshTokenService.rotate(successor).newRawToken()).isNotBlank();
    }

    @Test
    void logged_out_token_reused_after_grace_period_ends_its_own_session_and_leaves_the_other_devices() {
        User reader = auth.createReader(
                auth.nextGithubId(), "dang-xuat-" + UUID.randomUUID().toString().substring(0, 8));
        String loggedOut = auth.verifiedRefreshToken(reader);
        refreshTokenService.revoke(loggedOut);
        String otherDevice = auth.verifiedRefreshToken(reader);
        shiftIntoThePast(loggedOut, Duration.ofMinutes(3));

        // Logout clears the cookie, so only a copy made earlier could bring this token back.
        assertThatThrownBy(() -> refreshTokenService.rotate(loggedOut))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_REVOKED);
        // The copy belonged to the session that was signed out: another device of the person is not in doubt.
        assertThat(revokedAt(otherDevice)).isNull();
    }

    @Test
    void each_token_triggers_only_once_so_replaying_it_forever_cannot_log_that_person_out_forever() {
        User reader = auth.createReader(
                auth.nextGithubId(), "mot-lan-" + UUID.randomUUID().toString().substring(0, 8));
        String stolen = auth.verifiedRefreshToken(reader);
        refreshTokenService.rotate(stolen);
        shiftIntoThePast(stolen, Duration.ofMinutes(3));
        assertThatThrownBy(() -> refreshTokenService.rotate(stolen)).isInstanceOf(ApiException.class);
        assertThat(liveTokenCount(reader)).isZero();

        // That person logs in again. The holder of the old token replays it, right away or later: 401 EXPIRED (the
        // detection already ended
        // its expiry, and expiry is checked before revocation), the new session is untouched.
        String relogin = auth.verifiedRefreshToken(reader);
        assertThatThrownBy(() -> refreshTokenService.rotate(stolen))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_EXPIRED);
        shiftIntoThePast(stolen, Duration.ofMinutes(3));
        assertThatThrownBy(() -> refreshTokenService.rotate(stolen))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_EXPIRED);
        assertThat(revokedAt(relogin)).isNull();
    }

    @Test
    void token_bulk_revoked_then_coming_back_is_not_treated_as_reuse() {
        User reader = auth.createReader(
                auth.nextGithubId(), "hang-loat-" + UUID.randomUUID().toString().substring(0, 8));
        String oldDevice = auth.verifiedRefreshToken(reader);
        // Suspension, an admin password change, and the reuse detection itself revoke every session at once. An old
        // device still
        // holding a token like that and reopening is normal, not a sign of theft.
        inTransaction(() -> refreshTokenRepository.revokeAllLiveForUser(reader.getId(), Instant.now()));
        shiftIntoThePast(oldDevice, Duration.ofMinutes(3));
        String relogin = auth.verifiedRefreshToken(reader);

        // EXPIRED: the frontend clears the old device cookie, instead of keeping it as after losing a token rotation
        // race.
        assertThatThrownBy(() -> refreshTokenService.rotate(oldDevice))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_EXPIRED);
        assertThat(revokedAt(relogin)).isNull();
    }

    @Test
    void reuse_detection_writes_exactly_one_WARN_with_user_id_and_nothing_of_the_token() {
        User reader = auth.createReader(
                auth.nextGithubId(),
                "log-dung-lai-" + UUID.randomUUID().toString().substring(0, 8));
        String stolen = auth.verifiedRefreshToken(reader);
        String successor = refreshTokenService.rotate(stolen).newRawToken();
        shiftIntoThePast(stolen, Duration.ofMinutes(3));
        Logger logger = (Logger) LoggerFactory.getLogger(RefreshTokenService.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        try {
            assertThatThrownBy(() -> refreshTokenService.rotate(stolen)).isInstanceOf(ApiException.class);
        } finally {
            logger.detachAppender(logs);
        }

        assertThat(logs.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage())
                    .contains(reader.getId().toString())
                    .doesNotContain(
                            stolen, RefreshTokenService.hash(stolen), successor, RefreshTokenService.hash(successor));
        });
    }

    private Instant revokedAt(String rawToken) {
        return refreshTokenRepository
                .findByTokenHash(RefreshTokenService.hash(rawToken))
                .orElseThrow()
                .getRevokedAt();
    }

    private Instant expiresAt(String rawToken) {
        return refreshTokenRepository
                .findByTokenHash(RefreshTokenService.hash(rawToken))
                .orElseThrow()
                .getExpiresAt();
    }

    /** Pushes the whole token into the past (issued, expiry, revoked), by the DB clock: "this happened {@code by} ago". */
    private void shiftIntoThePast(String rawToken, Duration by) {
        jdbcTemplate.update(
                "UPDATE refresh_tokens SET created_at = created_at - make_interval(secs => ?), "
                        + "expires_at = expires_at - make_interval(secs => ?), "
                        + "revoked_at = revoked_at - make_interval(secs => ?) WHERE token_hash = ?",
                by.toSeconds(),
                by.toSeconds(),
                by.toSeconds(),
                RefreshTokenService.hash(rawToken));
    }

    private long liveTokenCount(User user) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL",
                Long.class,
                user.getId());
    }

    /** A bulk UPDATE statement (@Modifying) needs a transaction, as in the service that will call it. */
    private <T> T inTransaction(Supplier<T> work) {
        return new TransactionTemplate(transactionManager).execute(status -> work.get());
    }
}
