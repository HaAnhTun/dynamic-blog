package com.blog.auth.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * The step between the first factor and the session (migration V44). The raw challenge is 256 bits of SecureRandom and
 * only its SHA-256 is stored. {@code attempts} and {@code consumedAt} move only through the conditional statements of
 * {@code MfaChallengeRepository}; {@code createdAt} is written by the application from the Clock (full resolution, no
 * database default) because it is compared with {@code users.tokens_valid_after}.
 */
@Entity
@Table(name = "mfa_challenge")
@Getter
@Setter
@NoArgsConstructor
public class MfaChallenge {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "token_hash", nullable = false, updatable = false)
    private String tokenHash;

    @Column(name = "user_id", nullable = false, updatable = false)
    private UUID userId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, updatable = false)
    private ChallengePurpose purpose;

    @Enumerated(EnumType.STRING)
    @Column(name = "first_factor", nullable = false, updatable = false)
    private FirstFactor firstFactor;

    @Column(nullable = false, updatable = false)
    private int attempts;

    @Column(name = "expires_at", nullable = false, updatable = false)
    private Instant expiresAt;

    @Column(name = "consumed_at", updatable = false)
    private Instant consumedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
