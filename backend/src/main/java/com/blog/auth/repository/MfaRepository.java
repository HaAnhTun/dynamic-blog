package com.blog.auth.repository;

import com.blog.auth.entity.UserMfa;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/**
 * The {@code user_mfa} table. Everything that must be atomic is a conditional statement here, never "load, set, save":
 * the replay guard, the failure counter, the lock and the secret swap each depend on the row not having moved since the
 * caller read it. The caller must already be inside a transaction (the second-step check holds the row lock).
 */
public interface MfaRepository extends JpaRepository<UserMfa, UUID> {

    /** Whether the account has a confirmed enrollment: the rule behind "AUTHOR with two-step verification". */
    @Query(
            "select count(m) > 0 from UserMfa m where m.userId = :userId and m.status = com.blog.auth.entity.MfaStatus.ACTIVE")
    boolean existsActive(UUID userId);

    /**
     * Reads the row and locks it until the end of the transaction: every second-step check of an account is serialised
     * by this lock, across challenges and across backend instances.
     */
    @Query(value = "SELECT * FROM user_mfa WHERE user_id = :userId FOR UPDATE", nativeQuery = true)
    Optional<UserMfa> lockByUserId(UUID userId);

    /**
     * Stores (or overwrites) the secret of an enrollment that is not confirmed yet. Only while the row is PENDING: against
     * an ACTIVE row it changes nothing.
     *
     * @return 1 when the pending secret is stored, 0 when the account is already enrolled
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "INSERT INTO user_mfa (user_id, status, secret_cipher, key_id, created_at, updated_at) "
                    + "VALUES (:userId, 'PENDING', :cipher, :keyId, :now, :now) "
                    + "ON CONFLICT (user_id) DO UPDATE SET secret_cipher = EXCLUDED.secret_cipher, "
                    + "key_id = EXCLUDED.key_id, updated_at = EXCLUDED.updated_at "
                    + "WHERE user_mfa.status = 'PENDING'",
            nativeQuery = true)
    int upsertPending(UUID userId, byte[] cipher, short keyId, Instant now);

    /**
     * Confirms an enrollment: PENDING becomes ACTIVE and the step of the code just accepted is consumed.
     *
     * @return 1 when confirmed, 0 when the row is not PENDING or the step was already used
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE user_mfa SET status = 'ACTIVE', last_used_step = :step, failed_attempts = 0, "
                    + "locked_until = NULL, confirmed_at = :now, updated_at = :now "
                    + "WHERE user_id = :userId AND status = 'PENDING' AND last_used_step < :step",
            nativeQuery = true)
    int activate(UUID userId, long step, Instant now);

    /**
     * Records an accepted authenticator code: the replay guard moves to its step and the failure counters reset. The
     * update is the proof: zero rows means the step (or a later one) was already used.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE user_mfa SET last_used_step = :step, failed_attempts = 0, locked_until = NULL, "
                    + "updated_at = :now WHERE user_id = :userId AND status = 'ACTIVE' AND last_used_step < :step",
            nativeQuery = true)
    int recordCodeAccepted(UUID userId, long step, Instant now);

    /** Records an accepted recovery code: the failure counters reset; the replay guard is not touched. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE user_mfa SET failed_attempts = 0, locked_until = NULL, updated_at = :now "
                    + "WHERE user_id = :userId",
            nativeQuery = true)
    int recordRecoveryAccepted(UUID userId, Instant now);

    /** Counts one more consecutive wrong code and sets the lock computed from the new count (null: no lock). */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE user_mfa SET failed_attempts = failed_attempts + 1, locked_until = :lockedUntil, "
                    + "updated_at = :now WHERE user_id = :userId",
            nativeQuery = true)
    int recordFailure(UUID userId, Instant lockedUntil, Instant now);

    /** Clears the counters and the lock: a real {@code ADMIN_PASSWORD} change does this, nothing else does. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE user_mfa SET failed_attempts = 0, locked_until = NULL, updated_at = :now "
                    + "WHERE user_id = :userId",
            nativeQuery = true)
    int clearLock(UUID userId, Instant now);

    /**
     * Stores a replacement secret next to the active one, which keeps working. A second call overwrites the pending one.
     *
     * @return 1 when stored, 0 when the account has no ACTIVE enrollment
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE user_mfa SET pending_secret_cipher = :cipher, pending_key_id = :keyId, updated_at = :now "
                    + "WHERE user_id = :userId AND status = 'ACTIVE'",
            nativeQuery = true)
    int storeReplacement(UUID userId, byte[] cipher, short keyId, Instant now);

    /**
     * Swaps the replacement in: one conditional statement, so two parallel confirmations of one code swap once and a
     * pending secret that was overwritten in the meantime is not swapped by a stale reader.
     *
     * @param readPending the exact pending ciphertext the caller verified the code against
     * @return 1 when swapped, 0 when the pending secret is no longer the one that was read
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE user_mfa SET secret_cipher = :cipher, key_id = :keyId, pending_secret_cipher = NULL, "
                    + "pending_key_id = NULL, last_used_step = :step, failed_attempts = 0, locked_until = NULL, "
                    + "updated_at = :now WHERE user_id = :userId AND status = 'ACTIVE' "
                    + "AND pending_secret_cipher = :readPending",
            nativeQuery = true)
    int swapReplacement(UUID userId, byte[] readPending, byte[] cipher, short keyId, long step, Instant now);

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("delete from UserMfa m where m.userId = :userId")
    int deleteByUserId(UUID userId);
}
