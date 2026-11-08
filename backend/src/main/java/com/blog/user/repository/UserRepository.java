package com.blog.user.repository;

import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/** {@link JpaSpecificationExecutor}: the admin user list filtered by role, status and search string. */
public interface UserRepository extends JpaRepository<User, UUID>, JpaSpecificationExecutor<User> {
    Optional<User> findByEmail(String email);

    /** The public profile: only ACTIVE accounts have one. */
    Optional<User> findByPublicSlugAndStatus(String publicSlug, UserStatus status);

    /**
     * Only the status, without loading the whole User: this check runs before EVERY reader write
     * (CurrentUserService.requireActive), so it must be cheap. Empty when the account no longer exists (the access token
     * of a deleted person may still be valid).
     */
    @Query("select u.status from User u where u.id = :id")
    Optional<UserStatus> findStatusById(UUID id);

    /** Only the role: to learn why a suspension changed no row. Empty when there is no such account. */
    @Query("select u.role from User u where u.id = :id")
    Optional<UserRole> findRoleById(UUID id);

    /**
     * Suspends or reactivates a reader. The role condition is right inside the UPDATE statement, not in an earlier read:
     * ADMIN and AUTHOR never have their status changed, even if the role was just changed by SQL midway.
     * {@code status} is a read-only column on the entity (User), so this is its only write path besides GitHub login.
     *
     * @param status the name of a {@link UserStatus}
     * @return 1 when written (even if the status did not change); 0 when there is no such account or it is not USER
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE users SET status = :status, updated_at = now() WHERE id = :id AND role = 'USER'",
            nativeQuery = true)
    int setStatusIfReader(UUID id, String status);

    /** The current role, status and token cut-off, for every request carrying an access token (CurrentAccessJwtConverter). */
    @Query(
            "select new com.blog.user.repository.UserAccess(u.role, u.status, u.tokensValidAfter) from User u where u.id = :id")
    Optional<UserAccess> findAccessById(UUID id);

    /**
     * Rejects every access token of this account issued before {@code now} (JWT revocation). Never moves the cut-off
     * backwards. The caller must already be inside a transaction.
     *
     * @return 1 when the account exists
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE users SET tokens_valid_after = GREATEST(COALESCE(tokens_valid_after, :now), :now) "
                    + "WHERE id = :id",
            nativeQuery = true)
    int bumpTokensValidAfter(UUID id, Instant now);

    /**
     * Locks the account row until the end of the transaction, so the steps that decide whether a person needs a second
     * factor and the steps that change it run one entirely before the other (AuthService.completeFirstFactor,
     * MfaService), and so a refresh rotation and a bulk revocation of the same person's sessions do
     * (RefreshTokenService.rotate takes it before it reads the token; the UPDATE of {@code tokens_valid_after} in
     * {@code revokeAllSessions} takes the same mode). {@code FOR NO KEY UPDATE} does not conflict with the key-share lock
     * that inserting a refresh token takes on this row, so the holder of this lock can issue a session without waiting for
     * itself, and every path takes the account row first and the refresh token rows after it, so none can deadlock with
     * another.
     *
     * @return the id, or empty when there is no such account
     */
    @Query(value = "SELECT id FROM users WHERE id = :id FOR NO KEY UPDATE", nativeQuery = true)
    Optional<UUID> lockById(UUID id);

    /** When the open enrollment window of the account ends; empty when it was never opened or the account is gone. */
    @Query("select u.mfaEnrollmentOpenUntil from User u where u.id = :id")
    Optional<Instant> findEnrollmentOpenUntil(UUID id);

    /**
     * Opens ({@code until} in the future) or closes ({@code null}) the window in which the account may enrol without the
     * operator's enrollment code. Nothing a caller sends can reach this: the first-run claim opens it, a confirmed
     * enrollment closes it.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = "UPDATE users SET mfa_enrollment_open_until = :until WHERE id = :id", nativeQuery = true)
    int setEnrollmentOpenUntil(UUID id, Instant until);

    /**
     * Replaces the stored password hash by a stronger encoding of the same password (the rehash after a successful
     * sign-in). The old hash is part of the condition, so a password change that landed in between is never overwritten.
     * It leaves {@code updated_at} and the sessions alone: the password did not change.
     *
     * @return 1 when written; 0 when the hash was no longer the expected one
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(
            value = "UPDATE users SET password_hash = :replacement WHERE id = :id AND password_hash = :expected",
            nativeQuery = true)
    int replacePasswordHash(UUID id, String expected, String replacement);

    /** A lock shared by every role change, until the end of the transaction: two admins demoting each other at the same time cannot leave the site without an admin. */
    @Query(value = "select 1 from pg_advisory_xact_lock(hashtext('admin-roster'))", nativeQuery = true)
    int lockAdminRoster();

    @Query("select count(u) from User u where u.role = com.blog.user.entity.UserRole.ADMIN"
            + " and u.status = com.blog.user.entity.UserStatus.ACTIVE and u.id <> :id")
    long countOtherActiveAdmins(UUID id);

    /**
     * Changes the role while it is still {@code expected}; a suspended account may only be demoted to USER (the
     * condition is in the statement so a concurrent suspension cannot slip through). It does not clear the caller's
     * persistence context.
     */
    @Modifying(flushAutomatically = true)
    @Query(
            value = "UPDATE users SET role = :role, updated_at = now() WHERE id = :id AND role = :expected"
                    + " AND (:role = 'USER' OR status = 'ACTIVE')",
            nativeQuery = true)
    int setRoleIfCurrently(UUID id, String role, String expected);
}
