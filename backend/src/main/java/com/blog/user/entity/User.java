package com.blog.user.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Table(name = "users")
@Getter
@Setter
@NoArgsConstructor
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    /** Null for GitHub readers: the blog does not store the GitHub email (migration V18). Only password accounts have an email. */
    @Column(unique = true)
    private String email;

    /** Null for GitHub readers. Password login treats null as a wrong password (AuthService.login). */
    @Column(name = "password_hash")
    private String passwordHash;

    @Column(name = "display_name", nullable = false)
    private String displayName;

    // Written only at creation; a role change goes through UserRepository.setRoleIfCurrently, like status below.
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, updatable = false)
    private UserRole role;

    // The fields below are READ-ONLY on update (updatable = false), following the Post precedent: they are only
    // written by dedicated SQL statements (GitHub login, admin linking, suspension), never through the entity. The
    // entity has no @DynamicUpdate, so every save of a User rewrites every column it may write: if these columns were
    // among them, an unrelated save (AdminPasswordFromEnvironment setting the admin password at startup) landing on top
    // of a login or suspension that just happened would overwrite it with the old value (UserEntityWriteIT).
    //
    // insertable is still true, so a test fixture can save a reader (AuthTestSupport.createReader). A consequence to
    // remember: calling the setters of these fields on a User already in the DB and then saving writes NOTHING, and
    // reports no error.

    /**
     * Access tokens issued before this instant are rejected (migration V43). Written only by
     * {@code UserRepository.bumpTokensValidAfter}; null means no cut-off.
     */
    @Column(name = "tokens_valid_after", updatable = false)
    private Instant tokensValidAfter;

    /**
     * While in the future, this account may start its two-step enrollment without the operator's enrollment code (the
     * first-run setup opens it for an hour; migration V44). Written only by
     * {@code UserRepository.setEnrollmentOpenUntil}.
     */
    @Column(name = "mfa_enrollment_open_until", updatable = false)
    private Instant mfaEnrollmentOpenUntil;

    /** Numeric id of the GitHub account: the reader's immutable identifier. The login can change, the id cannot. */
    @Column(name = "github_id", unique = true, updatable = false)
    private Long githubId;

    @Column(name = "github_login", updatable = false)
    private String githubLogin;

    @Column(name = "avatar_url", updatable = false)
    private String avatarUrl;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, updatable = false)
    private UserStatus status = UserStatus.ACTIVE;

    @Column(name = "last_login_at", updatable = false)
    private Instant lastLoginAt;

    /**
     * The public handle (migration V32): the profile path {@code /api/v1/users/{slug}} and the {@code ?author=} filter.
     * Immutable: only GithubAccountService's INSERT statement chooses it (PublicSlugs.allocate); insertable like the
     * columns above, for fixtures.
     */
    @Column(name = "public_slug", nullable = false, unique = true, updatable = false)
    private String publicSlug;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }
}
