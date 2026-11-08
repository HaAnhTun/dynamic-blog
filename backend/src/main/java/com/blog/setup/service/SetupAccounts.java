package com.blog.setup.service;

import com.blog.auth.service.RefreshTokenService;
import com.blog.common.security.SeedAdmin;
import com.blog.user.service.PublicSlugs;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * The account writes of first-run setup, on the seeded admin row ({@link SeedAdmin#ID}): the site owner concept and
 * every foreign key keep pointing at that id after the claim. Callers hold the setup lock ({@link SetupState}).
 */
@Component
@RequiredArgsConstructor
public class SetupAccounts {

    /**
     * The password hash of the seeded admin while setup is pending: not an Argon2 encoding, so
     * {@code Argon2PasswordEncoder.matches} returns false for every password without throwing (it logs one WARN
     * "Malformed password hash" per check, with no value). Non-null, so {@code chk_users_has_credential} still holds.
     */
    public static final String UNUSABLE_PASSWORD_HASH = "!disabled-until-first-run-setup";

    private final JdbcTemplate jdbcTemplate;
    private final RefreshTokenService refreshTokenService;

    /** The password hash of the seeded row, locked until the end of the transaction; empty when the row is missing. */
    List<String> lockSeedPasswordHash() {
        return jdbcTemplate.queryForList(
                "SELECT password_hash FROM users WHERE id = ? FOR UPDATE", String.class, SeedAdmin.ID);
    }

    void disableSeedPassword() {
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ?, updated_at = now() WHERE id = ?",
                UNUSABLE_PASSWORD_HASH,
                SeedAdmin.ID);
    }

    /** Whether an account other than {@code ownerId} already uses this address, ignoring case. */
    boolean emailTakenByAnother(String email, UUID ownerId) {
        return Boolean.TRUE.equals(jdbcTemplate.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(?) AND id <> ?)",
                Boolean.class,
                email,
                ownerId));
    }

    /**
     * Gives the seeded ADMIN row the owner's email, password hash and name. When that row no longer exists (deleted by
     * hand), inserts a new ADMIN with the seed id and a public slug allocated like every new account; when the id is held
     * by a row that is no longer ADMIN, the new ADMIN gets a fresh id.
     *
     * @return the id of the owner's account
     */
    UUID claimOwner(String email, String passwordHash, String displayName) {
        int updated = jdbcTemplate.update(
                "UPDATE users SET email = ?, password_hash = ?, display_name = ?, updated_at = now() "
                        + "WHERE id = ? AND role = 'ADMIN'",
                email,
                passwordHash,
                displayName,
                SeedAdmin.ID);
        if (updated == 1) {
            return SeedAdmin.ID;
        }
        boolean seedIdTaken = Boolean.TRUE.equals(jdbcTemplate.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM users WHERE id = ?)", Boolean.class, SeedAdmin.ID));
        UUID id = seedIdTaken ? UUID.randomUUID() : SeedAdmin.ID;
        String slug = PublicSlugs.allocate(jdbcTemplate, PublicSlugs.baseOf(null, displayName));
        jdbcTemplate.update(
                "INSERT INTO users (id, email, password_hash, display_name, role, public_slug) "
                        + "VALUES (?, ?, ?, ?, 'ADMIN', ?)",
                id,
                email,
                passwordHash,
                displayName,
                slug);
        return id;
    }

    /**
     * Opens the enrollment window of the account for one hour: the owner has just proved the setup code, and that proof is
     * what the operator's enrollment code would otherwise be asked for at the first sign-in (two-step verification is
     * mandatory for an administrator). A confirmed enrollment closes it again.
     */
    void openMfaEnrollmentWindow(UUID userId) {
        jdbcTemplate.update(
                "UPDATE users SET mfa_enrollment_open_until = now() + interval '1 hour' WHERE id = ?", userId);
    }

    /**
     * Ends every session of the account: all live refresh tokens are revoked and every access token issued before now
     * is rejected ({@code users.tokens_valid_after}), so nothing obtained with the previous credential outlives the
     * change. Like AdminSeedEmail, the revocation also ends the refresh tokens' expiry, so an old device coming back
     * gets EXPIRED rather than tripping token-reuse detection. Must run inside the caller's transaction.
     *
     * @return the number of refresh tokens revoked
     */
    int endAllSessions(UUID userId) {
        return refreshTokenService.revokeAllSessions(userId, Instant.now());
    }
}
