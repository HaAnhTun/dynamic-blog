package com.blog.auth.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * The two-step verification of one account (migration V44). The row is read through this entity and written ONLY by the
 * conditional statements of {@code MfaRepository}: every mutable column is {@code updatable = false}, following the
 * {@code User} precedent, so a "load, set, save" can never silently overwrite a counter or a replay guard that another
 * request just moved. Nothing here has a setter.
 *
 * {@code secretCipher} is {@code iv || ciphertext || tag} of {@code MfaSecretCipher}; it is never logged or returned.
 */
@Entity
@Table(name = "user_mfa")
@Getter
@NoArgsConstructor
public class UserMfa {

    @Id
    @Column(name = "user_id", updatable = false)
    private UUID userId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, updatable = false)
    private MfaStatus status;

    @Column(name = "secret_cipher", nullable = false, updatable = false)
    private byte[] secretCipher;

    @Column(name = "key_id", nullable = false, updatable = false)
    private short keyId;

    /** A replacement secret waiting for its first code; the active secret keeps working meanwhile. */
    @Column(name = "pending_secret_cipher", updatable = false)
    private byte[] pendingSecretCipher;

    @Column(name = "pending_key_id", updatable = false)
    private Short pendingKeyId;

    /** The 30-second step of the last accepted code: a code is accepted only for a greater step (replay guard). */
    @Column(name = "last_used_step", nullable = false, updatable = false)
    private long lastUsedStep;

    /** Consecutive wrong second-step codes. */
    @Column(name = "failed_attempts", nullable = false, updatable = false)
    private int failedAttempts;

    @Column(name = "locked_until", updatable = false)
    private Instant lockedUntil;

    @Column(name = "confirmed_at", updatable = false)
    private Instant confirmedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false, updatable = false)
    private Instant updatedAt;
}
