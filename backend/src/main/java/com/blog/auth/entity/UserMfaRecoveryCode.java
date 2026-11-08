package com.blog.auth.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * One single-use recovery code (migration V44). Only the SHA-256 hex of the normalised 24-character code is stored.
 * Redeeming is a conditional UPDATE in {@code MfaRecoveryCodeRepository}, never "load, set, save": {@code used_at} is not
 * updatable through the entity.
 */
@Entity
@Table(name = "user_mfa_recovery_code")
@Getter
@Setter
@NoArgsConstructor
public class UserMfaRecoveryCode {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false, updatable = false)
    private UUID userId;

    @Column(name = "code_hash", nullable = false, updatable = false)
    private String codeHash;

    @Column(name = "used_at", updatable = false)
    private Instant usedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @PrePersist
    void onCreate() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }
}
