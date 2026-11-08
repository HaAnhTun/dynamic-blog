package com.blog.auth.repository;

import com.blog.auth.entity.MfaChallenge;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/**
 * The sign-in challenges ({@code mfa_challenge}). {@code attempts} and {@code consumed_at} move only through the
 * conditional statements below. Every statement that decides whether a challenge is still usable compares with the
 * account's {@code tokens_valid_after} at full resolution (a password change, a sign-out everywhere, a role change or an
 * operator reset kills every challenge created before it).
 */
public interface MfaChallengeRepository extends JpaRepository<MfaChallenge, UUID> {

    Optional<MfaChallenge> findByTokenHash(String tokenHash);

    /**
     * Reserves one evaluated code on a challenge, only while it is unconsumed, unexpired, below {@code maxAttempts} and not
     * older than the account's cut-off.
     *
     * @return 1 when reserved, 0 for any other reason: one answer for unknown, expired, consumed, exhausted and stale
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE mfa_challenge SET attempts = attempts + 1 "
                    + "WHERE token_hash = :tokenHash AND consumed_at IS NULL AND expires_at > :now "
                    + "AND attempts < :maxAttempts "
                    + "AND created_at >= COALESCE((SELECT tokens_valid_after FROM users "
                    + "WHERE id = mfa_challenge.user_id), CAST('-infinity' AS timestamptz))",
            nativeQuery = true)
    int reserveAttempt(String tokenHash, Instant now, int maxAttempts);

    /** Gives back an attempt reserved before a check that turned out right (the enrollment code). */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE mfa_challenge SET attempts = attempts - 1 WHERE token_hash = :tokenHash AND attempts > 0",
            nativeQuery = true)
    int refundAttempt(String tokenHash);

    /** Consumes the challenge when its last attempt has been used. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE mfa_challenge SET consumed_at = :now "
                    + "WHERE token_hash = :tokenHash AND consumed_at IS NULL AND attempts >= :maxAttempts",
            nativeQuery = true)
    int consumeIfExhausted(String tokenHash, Instant now, int maxAttempts);

    /** Consumes every unconsumed challenge of the account: any one of them succeeding ends them all. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE mfa_challenge SET consumed_at = :now WHERE user_id = :userId AND consumed_at IS NULL",
            nativeQuery = true)
    int consumeAllForUser(UUID userId, Instant now);

    /**
     * How many challenges of the account can still be used: unconsumed, unexpired and not older than the cut-off. The
     * 21st sign-in step is refused, never the oldest evicted.
     */
    @Query(
            value = "SELECT count(*) FROM mfa_challenge c WHERE c.user_id = :userId AND c.consumed_at IS NULL "
                    + "AND c.expires_at > :now "
                    + "AND c.created_at >= COALESCE((SELECT u.tokens_valid_after FROM users u WHERE u.id = c.user_id), "
                    + "CAST('-infinity' AS timestamptz))",
            nativeQuery = true)
    long countLive(UUID userId, Instant now);

    /** The nightly cleanup (MfaChallengeCleanup): deletes challenges that expired before {@code before}. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = "DELETE FROM mfa_challenge WHERE expires_at < :before", nativeQuery = true)
    int deleteExpiredBefore(Instant before);
}
