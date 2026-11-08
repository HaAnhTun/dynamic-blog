package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.auth.entity.ChallengePurpose;
import com.blog.auth.entity.FirstFactor;
import com.blog.auth.entity.MfaChallenge;
import com.blog.auth.entity.MfaStatus;
import com.blog.auth.entity.UserMfa;
import com.blog.auth.entity.UserMfaRecoveryCode;
import com.blog.auth.repository.MfaChallengeRepository;
import com.blog.auth.repository.MfaRecoveryCodeRepository;
import com.blog.auth.repository.MfaRepository;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

/**
 * The conditional statements of the MFA tables, one by one: each is the proof of a rule (replay guard, single use, swap only
 * of the secret that was read, challenge cut-off), so each is checked against the real database. Every test runs in a
 * transaction that is rolled back, like the callers of these statements, which must hold one.
 */
@Transactional
class MfaRepositoryIT extends AbstractIntegrationTest {

    private static final byte[] CIPHER = {1, 2, 3, 4};
    private static final byte[] OTHER_CIPHER = {9, 9, 9};

    @Autowired
    private MfaRepository mfaRepository;

    @Autowired
    private MfaRecoveryCodeRepository recoveryRepository;

    @Autowired
    private MfaChallengeRepository challengeRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private final Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);

    /** The stored token hash of a challenge the test names: unique per test, because the column is unique. */
    private final String testId = UUID.randomUUID().toString();

    private String h(String name) {
        return name + "-" + testId;
    }

    private User author() {
        return auth.createAccount("mfa-repo-" + UUID.randomUUID() + "@blog.local", UserRole.AUTHOR);
    }

    private UserMfa row(UUID userId) {
        return mfaRepository.findById(userId).orElseThrow();
    }

    @Test
    void a_pending_enrollment_is_overwritten_while_pending_and_never_once_active() {
        UUID id = author().getId();

        assertThat(mfaRepository.upsertPending(id, CIPHER, (short) 7, now)).isEqualTo(1);
        assertThat(mfaRepository.upsertPending(id, OTHER_CIPHER, (short) 8, now))
                .isEqualTo(1);
        assertThat(row(id).getSecretCipher()).isEqualTo(OTHER_CIPHER);
        assertThat(row(id).getStatus()).isEqualTo(MfaStatus.PENDING);
        assertThat(mfaRepository.existsActive(id)).isFalse();

        assertThat(mfaRepository.activate(id, 100, now)).isEqualTo(1);

        assertThat(mfaRepository.existsActive(id)).isTrue();
        assertThat(mfaRepository.upsertPending(id, CIPHER, (short) 7, now)).isZero();
        assertThat(row(id).getSecretCipher()).isEqualTo(OTHER_CIPHER);
        assertThat(row(id).getStatus()).isEqualTo(MfaStatus.ACTIVE);
        assertThat(row(id).getLastUsedStep()).isEqualTo(100);
        assertThat(row(id).getConfirmedAt()).isNotNull();
    }

    @Test
    void activating_twice_or_with_an_used_step_changes_nothing() {
        UUID id = author().getId();
        mfaRepository.upsertPending(id, CIPHER, (short) 1, now);

        assertThat(mfaRepository.activate(id, 50, now)).isEqualTo(1);
        // Already ACTIVE: not a pending enrollment any more.
        assertThat(mfaRepository.activate(id, 60, now)).isZero();
        assertThat(row(id).getLastUsedStep()).isEqualTo(50);
    }

    @Test
    void an_accepted_code_moves_the_replay_guard_only_forward_and_resets_the_counters() {
        UUID id = author().getId();
        mfaRepository.upsertPending(id, CIPHER, (short) 1, now);
        mfaRepository.activate(id, 10, now);
        mfaRepository.recordFailure(id, now.plusSeconds(30), now);
        mfaRepository.recordFailure(id, now.plusSeconds(60), now);
        assertThat(row(id).getFailedAttempts()).isEqualTo(2);
        assertThat(row(id).getLockedUntil()).isEqualTo(now.plusSeconds(60));

        assertThat(mfaRepository.recordCodeAccepted(id, 10, now))
                .as("same step")
                .isZero();
        assertThat(mfaRepository.recordCodeAccepted(id, 9, now))
                .as("older step")
                .isZero();
        assertThat(mfaRepository.recordCodeAccepted(id, 11, now))
                .as("newer step")
                .isEqualTo(1);

        assertThat(row(id).getLastUsedStep()).isEqualTo(11);
        assertThat(row(id).getFailedAttempts()).isZero();
        assertThat(row(id).getLockedUntil()).isNull();
    }

    @Test
    void a_failure_counts_and_a_recovery_code_resets_without_touching_the_replay_guard() {
        UUID id = author().getId();
        mfaRepository.upsertPending(id, CIPHER, (short) 1, now);
        mfaRepository.activate(id, 10, now);

        mfaRepository.recordFailure(id, null, now);
        assertThat(row(id).getFailedAttempts()).isEqualTo(1);
        assertThat(row(id).getLockedUntil()).isNull();
        mfaRepository.recordFailure(id, now.plusSeconds(30), now);
        assertThat(row(id).getLockedUntil()).isEqualTo(now.plusSeconds(30));

        mfaRepository.recordRecoveryAccepted(id, now);

        assertThat(row(id).getFailedAttempts()).isZero();
        assertThat(row(id).getLockedUntil()).isNull();
        assertThat(row(id).getLastUsedStep()).isEqualTo(10);
    }

    @Test
    void clearing_the_lock_resets_both_counters() {
        UUID id = author().getId();
        mfaRepository.upsertPending(id, CIPHER, (short) 1, now);
        mfaRepository.activate(id, 10, now);
        mfaRepository.recordFailure(id, now.plusSeconds(900), now);

        mfaRepository.clearLock(id, now);

        assertThat(row(id).getFailedAttempts()).isZero();
        assertThat(row(id).getLockedUntil()).isNull();
    }

    @Test
    void a_replacement_secret_waits_next_to_the_active_one_and_is_swapped_only_if_it_is_the_one_that_was_read() {
        UUID id = author().getId();
        mfaRepository.upsertPending(id, CIPHER, (short) 1, now);
        mfaRepository.activate(id, 10, now);

        assertThat(mfaRepository.storeReplacement(id, OTHER_CIPHER, (short) 2, now))
                .isEqualTo(1);
        assertThat(row(id).getSecretCipher()).as("the active secret is kept").isEqualTo(CIPHER);
        assertThat(row(id).getPendingSecretCipher()).isEqualTo(OTHER_CIPHER);
        assertThat(row(id).getPendingKeyId()).isEqualTo((short) 2);

        byte[] newest = {5, 5, 5};
        // A stale reader: the pending secret was overwritten after it read it.
        mfaRepository.storeReplacement(id, newest, (short) 3, now);
        assertThat(mfaRepository.swapReplacement(id, OTHER_CIPHER, new byte[] {7}, (short) 4, 20, now))
                .isZero();
        assertThat(row(id).getSecretCipher()).isEqualTo(CIPHER);

        assertThat(mfaRepository.swapReplacement(id, newest, new byte[] {7}, (short) 4, 20, now))
                .isEqualTo(1);
        assertThat(row(id).getSecretCipher()).isEqualTo(new byte[] {7});
        assertThat(row(id).getKeyId()).isEqualTo((short) 4);
        assertThat(row(id).getPendingSecretCipher()).isNull();
        assertThat(row(id).getPendingKeyId()).isNull();
        assertThat(row(id).getLastUsedStep()).isEqualTo(20);
        // The same swap again: nothing pending any more.
        assertThat(mfaRepository.swapReplacement(id, newest, new byte[] {8}, (short) 5, 21, now))
                .isZero();
    }

    @Test
    void a_replacement_can_only_be_stored_for_an_active_enrollment() {
        UUID id = author().getId();
        assertThat(mfaRepository.storeReplacement(id, CIPHER, (short) 1, now)).isZero();
        mfaRepository.upsertPending(id, CIPHER, (short) 1, now);
        assertThat(mfaRepository.storeReplacement(id, OTHER_CIPHER, (short) 1, now))
                .isZero();
    }

    @Test
    void a_recovery_code_is_redeemed_once() {
        UUID id = author().getId();
        recoveryRepository.saveAllAndFlush(
                java.util.List.of(code(id, "hash-a"), code(id, "hash-b"), code(id, "hash-c")));
        assertThat(recoveryRepository.countByUserIdAndUsedAtIsNull(id)).isEqualTo(3);

        assertThat(recoveryRepository.redeem(id, "hash-a", now)).isEqualTo(1);
        assertThat(recoveryRepository.redeem(id, "hash-a", now)).isZero();
        assertThat(recoveryRepository.redeem(id, "unknown", now)).isZero();
        assertThat(recoveryRepository.redeem(UUID.randomUUID(), "hash-b", now))
                .as("another account")
                .isZero();
        assertThat(recoveryRepository.countByUserIdAndUsedAtIsNull(id)).isEqualTo(2);

        assertThat(recoveryRepository.deleteByUserId(id)).isEqualTo(3);
        assertThat(recoveryRepository.countByUserIdAndUsedAtIsNull(id)).isZero();
    }

    @Test
    void a_challenge_attempt_is_reserved_only_while_the_challenge_is_usable() {
        UUID id = author().getId();
        challenge(id, "usable", now.plusSeconds(300), now);
        challenge(id, "expired", now.minusSeconds(1), now.minusSeconds(400));
        MfaChallenge consumed = challenge(id, "consumed", now.plusSeconds(300), now);
        jdbcTemplate.update("UPDATE mfa_challenge SET consumed_at = now() WHERE id = ?", consumed.getId());

        assertThat(challengeRepository.reserveAttempt(h("usable"), now, 5)).isEqualTo(1);
        assertThat(challengeRepository.reserveAttempt(h("expired"), now, 5)).isZero();
        assertThat(challengeRepository.reserveAttempt(h("consumed"), now, 5)).isZero();
        assertThat(challengeRepository.reserveAttempt(h("unknown"), now, 5)).isZero();

        for (int i = 0; i < 4; i++) {
            assertThat(challengeRepository.reserveAttempt(h("usable"), now, 5)).isEqualTo(1);
        }
        assertThat(challengeRepository.reserveAttempt(h("usable"), now, 5))
                .as("a sixth attempt")
                .isZero();
        assertThat(challengeRepository
                        .findByTokenHash(h("usable"))
                        .orElseThrow()
                        .getAttempts())
                .isEqualTo(5);

        assertThat(challengeRepository.consumeIfExhausted(h("usable"), now, 5)).isEqualTo(1);
        assertThat(challengeRepository.consumeIfExhausted(h("usable"), now, 5)).isZero();
    }

    @Test
    void a_challenge_created_before_the_cut_off_of_the_account_is_dead() {
        UUID id = author().getId();
        Instant created = Instant.now().truncatedTo(ChronoUnit.MICROS).minusSeconds(5);
        challenge(id, "before-the-bump", Instant.now().plusSeconds(300), created);
        challenge(id, "after-the-bump", Instant.now().plusSeconds(300), created.plusSeconds(10));
        userRepository.bumpTokensValidAfter(id, created.plusSeconds(5));

        assertThat(challengeRepository.reserveAttempt(h("before-the-bump"), Instant.now(), 5))
                .isZero();
        assertThat(challengeRepository.reserveAttempt(h("after-the-bump"), Instant.now(), 5))
                .isEqualTo(1);
        assertThat(challengeRepository.countLive(id, Instant.now())).isEqualTo(1);
    }

    @Test
    void an_enrollment_code_attempt_is_given_back_and_every_challenge_of_an_account_can_be_ended_at_once() {
        UUID id = author().getId();
        UUID other = author().getId();
        challenge(id, "one", now.plusSeconds(300), now);
        challenge(id, "two", now.plusSeconds(300), now);
        challenge(other, "theirs", now.plusSeconds(300), now);
        assertThat(challengeRepository.countLive(id, now)).isEqualTo(2);

        challengeRepository.reserveAttempt(h("one"), now, 5);
        assertThat(challengeRepository.refundAttempt(h("one"))).isEqualTo(1);
        assertThat(challengeRepository.refundAttempt(h("one")))
                .as("never below zero")
                .isZero();
        assertThat(challengeRepository.findByTokenHash(h("one")).orElseThrow().getAttempts())
                .isZero();

        assertThat(challengeRepository.consumeAllForUser(id, now)).isEqualTo(2);

        assertThat(challengeRepository.countLive(id, now)).isZero();
        assertThat(challengeRepository.countLive(other, now)).isEqualTo(1);
    }

    @Test
    void the_cleanup_deletes_only_challenges_that_expired_before_the_limit() {
        UUID id = author().getId();
        challenge(id, "old", now.minusSeconds(3 * 86_400), now.minusSeconds(3 * 86_400 + 300));
        challenge(id, "recent", now.minusSeconds(60), now.minusSeconds(360));
        challenge(id, "live", now.plusSeconds(300), now);

        challengeRepository.deleteExpiredBefore(now.minusSeconds(86_400));

        assertThat(challengeRepository.findByTokenHash(h("old"))).isEmpty();
        assertThat(challengeRepository.findByTokenHash(h("recent"))).isPresent();
        assertThat(challengeRepository.findByTokenHash(h("live"))).isPresent();
    }

    @Test
    void the_account_row_can_be_locked_and_the_enrollment_window_opened_and_closed() {
        UUID id = author().getId();

        assertThat(userRepository.lockById(id)).contains(id);
        assertThat(userRepository.lockById(UUID.randomUUID())).isEmpty();

        assertThat(userRepository.findEnrollmentOpenUntil(id)).isEmpty();
        Instant until = now.plusSeconds(3600);
        assertThat(userRepository.setEnrollmentOpenUntil(id, until)).isEqualTo(1);
        assertThat(userRepository.findEnrollmentOpenUntil(id)).contains(until);
        assertThat(userRepository.setEnrollmentOpenUntil(id, null)).isEqualTo(1);
        assertThat(userRepository.findEnrollmentOpenUntil(id)).isEmpty();
    }

    private UserMfaRecoveryCode code(UUID userId, String hash) {
        UserMfaRecoveryCode code = new UserMfaRecoveryCode();
        code.setUserId(userId);
        code.setCodeHash(hash);
        code.setCreatedAt(now);
        return code;
    }

    private MfaChallenge challenge(UUID userId, String hash, Instant expiresAt, Instant createdAt) {
        MfaChallenge challenge = new MfaChallenge();
        challenge.setUserId(userId);
        challenge.setTokenHash(h(hash));
        challenge.setPurpose(ChallengePurpose.VERIFY);
        challenge.setFirstFactor(FirstFactor.PASSWORD);
        challenge.setExpiresAt(expiresAt);
        challenge.setCreatedAt(createdAt);
        return challengeRepository.saveAndFlush(challenge);
    }
}
