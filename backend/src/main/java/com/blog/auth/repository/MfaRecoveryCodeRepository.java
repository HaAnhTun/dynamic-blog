package com.blog.auth.repository;

import com.blog.auth.entity.UserMfaRecoveryCode;
import java.time.Instant;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/** The single-use recovery codes ({@code user_mfa_recovery_code}); only hashes are stored. */
public interface MfaRecoveryCodeRepository extends JpaRepository<UserMfaRecoveryCode, UUID> {

    /** How many codes the account can still use. */
    long countByUserIdAndUsedAtIsNull(UUID userId);

    /**
     * Redeems a code: one conditional statement, so a code works once even when two requests present it together.
     *
     * @return 1 when this call used the code, 0 when there is no such unused code
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE user_mfa_recovery_code SET used_at = :now "
                    + "WHERE user_id = :userId AND code_hash = :codeHash AND used_at IS NULL",
            nativeQuery = true)
    int redeem(UUID userId, String codeHash, Instant now);

    /** Deletes every code of the account, used or not: regenerating, replacing the authenticator, removing MFA. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("delete from UserMfaRecoveryCode c where c.userId = :userId")
    int deleteByUserId(UUID userId);
}
