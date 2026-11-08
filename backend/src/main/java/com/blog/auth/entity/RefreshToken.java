package com.blog.auth.entity;

import com.blog.user.entity.User;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Table(name = "refresh_tokens")
@Getter
@Setter
@NoArgsConstructor
public class RefreshToken {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @Column(name = "token_hash", nullable = false, unique = true)
    private String tokenHash;

    /**
     * The login session this token belongs to. Rotation copies it to the successor, so the access tokens minted for the
     * session (sid claim) stay valid across rotations and die when the session has no live token left.
     */
    @Column(name = "session_id", nullable = false, updatable = false)
    private UUID sessionId;

    /**
     * When a second factor was verified for this session; null means none was (migration V44). Copied unchanged on
     * rotation. A session without it cannot rotate once its account requires two-step verification
     * (RefreshTokenService.rotate).
     */
    @Column(name = "mfa_verified_at", updatable = false)
    private Instant mfaVerifiedAt;

    /**
     * When the person last signed in with a first factor: the start of the session. Never refreshed by rotation, so a
     * session that is still alive 30 days later never looks freshly authenticated. It is the {@code auth_time} claim of
     * the session's access tokens.
     */
    @Column(name = "authenticated_at", nullable = false, updatable = false)
    private Instant authenticatedAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
        if (sessionId == null) {
            sessionId = UUID.randomUUID();
        }
        // The service always sets the proof of the session; if a caller forgot, the session counts as "never recently
        // authenticated", the safe reading.
        if (authenticatedAt == null) {
            authenticatedAt = Instant.EPOCH;
        }
    }
}
