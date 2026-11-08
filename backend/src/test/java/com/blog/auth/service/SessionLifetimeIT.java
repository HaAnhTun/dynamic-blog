package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The life of a session by role (audit 007), with the defaults: an ADMIN or AUTHOR session ends after 7 days without use
 * (every rotation renews it) and 30 days after the person signed in however active it was; a reader keeps today's behavior,
 * a refresh token of 30 days from its issue, sliding with no end. The start of a session is its {@code authenticated_at},
 * which rotation copies and a password change or an enrollment hands to the session it issues to the caller. Time is moved
 * with the proof of the session (the start is written 29 or 31 days back) and with SQL, never with a mocked clock.
 */
class SessionLifetimeIT extends AbstractIntegrationTest {

    private static final Duration IDLE = Duration.ofDays(7);
    private static final Duration ABSOLUTE = Duration.ofDays(30);
    private static final Duration READER = Duration.ofDays(30);
    /** The database keeps microseconds and the test reads the clock a moment after the service: a few seconds of slack. */
    private static final Duration SLACK = Duration.ofSeconds(30);

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private RefreshTokenRepository refreshTokenRepository;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private User account(UserRole role) {
        return auth.createAccount("vong-doi-" + UUID.randomUUID() + "@blog.local", role);
    }

    private User reader() {
        return auth.createReader(
                auth.nextGithubId(), "vong-doi-" + UUID.randomUUID().toString().substring(0, 8));
    }

    private static SessionProof startedAt(Instant start) {
        return new SessionProof(start, start);
    }

    private Instant expiresAt(String rawToken) {
        return refreshTokenRepository
                .findByTokenHash(RefreshTokenService.hash(rawToken))
                .orElseThrow()
                .getExpiresAt();
    }

    @Test
    void a_new_admin_or_author_session_lives_seven_days_and_a_new_reader_session_thirty() {
        for (UserRole role : new UserRole[] {UserRole.ADMIN, UserRole.AUTHOR}) {
            Instant before = Instant.now();
            RefreshTokenService.IssuedToken issued =
                    refreshTokenService.open(account(role), SessionProof.verified(Instant.now()));

            assertThat(expiresAt(issued.rawToken()))
                    .as(role.name())
                    .isBetween(before.plus(IDLE), before.plus(IDLE).plus(SLACK));
            // The frontend sets the Max-Age of the cookie from this number.
            assertThat(issued.expiresInSeconds()).as(role.name()).isBetween(IDLE.toSeconds() - 1, IDLE.toSeconds());
        }

        Instant before = Instant.now();
        RefreshTokenService.IssuedToken reader =
                refreshTokenService.open(reader(), SessionProof.firstFactor(Instant.now()));
        assertThat(expiresAt(reader.rawToken()))
                .isBetween(before.plus(READER), before.plus(READER).plus(SLACK));
        assertThat(reader.expiresInSeconds()).isBetween(READER.toSeconds() - 1, READER.toSeconds());
    }

    @Test
    void every_rotation_renews_the_idle_timeout_for_a_session_that_is_not_old() {
        User author = account(UserRole.AUTHOR);
        Instant start = Instant.now().minus(Duration.ofDays(3)).truncatedTo(ChronoUnit.MICROS);
        String first = refreshTokenService.open(author, startedAt(start)).rawToken();

        Instant before = Instant.now();
        RefreshTokenService.RotationResult rotated = refreshTokenService.rotate(first);

        // Seven days from NOW, not seven days from the start of the session: a session in use does not end after a
        // week.
        assertThat(expiresAt(rotated.newRawToken()))
                .isBetween(before.plus(IDLE), before.plus(IDLE).plus(SLACK));
        assertThat(rotated.refreshExpiresInSeconds()).isBetween(IDLE.toSeconds() - 1, IDLE.toSeconds());
        assertThat(rotated.authenticatedAt()).isEqualTo(start);
    }

    @Test
    void near_the_end_of_the_absolute_lifetime_the_refresh_token_lives_only_until_it() {
        for (UserRole role : new UserRole[] {UserRole.ADMIN, UserRole.AUTHOR}) {
            Instant start = Instant.now().minus(Duration.ofDays(29)).truncatedTo(ChronoUnit.MICROS);
            User person = account(role);

            RefreshTokenService.IssuedToken opened = refreshTokenService.open(person, startedAt(start));
            RefreshTokenService.RotationResult first = refreshTokenService.rotate(opened.rawToken());
            RefreshTokenService.RotationResult second = refreshTokenService.rotate(first.newRawToken());

            // The session was issued, and every token of it was cut at start + 30 days: about a day from now, not
            // seven.
            for (String raw : new String[] {opened.rawToken(), first.newRawToken(), second.newRawToken()}) {
                assertThat(expiresAt(raw)).as(role + " " + raw).isBeforeOrEqualTo(start.plus(ABSOLUTE));
                assertThat(expiresAt(raw))
                        .as(role + " " + raw)
                        .isAfter(start.plus(ABSOLUTE).minus(SLACK));
            }
            assertThat(second.refreshExpiresInSeconds())
                    .isBetween(
                            Duration.ofHours(23).toSeconds(), Duration.ofDays(1).toSeconds());
            assertThat(second.authenticatedAt()).isEqualTo(start);
        }
    }

    @Test
    void a_session_that_reached_its_absolute_lifetime_cannot_rotate_however_active_it_was() {
        Instant start = Instant.now().minus(Duration.ofDays(31)).truncatedTo(ChronoUnit.MICROS);
        for (UserRole role : new UserRole[] {UserRole.ADMIN, UserRole.AUTHOR}) {
            String raw =
                    refreshTokenService.open(account(role), startedAt(start)).rawToken();

            // EXPIRED, the answer that makes Next clear the cookies and send the person to sign in again.
            assertThatThrownBy(() -> refreshTokenService.rotate(raw))
                    .as(role.name())
                    .isInstanceOf(ApiException.class)
                    .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_EXPIRED);
        }
    }

    @Test
    void the_absolute_lifetime_is_checked_at_the_rotation_even_when_the_token_itself_lives_longer() {
        // A token whose own expiry was set under other rules (the reader's, a longer configuration) is still ended.
        User admin = account(UserRole.ADMIN);
        Instant start = Instant.now().minus(Duration.ofDays(31)).truncatedTo(ChronoUnit.MICROS);
        String raw = refreshTokenService.open(admin, startedAt(start)).rawToken();
        jdbcTemplate.update(
                "UPDATE refresh_tokens SET expires_at = now() + interval '10 days' WHERE token_hash = ?",
                RefreshTokenService.hash(raw));

        assertThatThrownBy(() -> refreshTokenService.rotate(raw))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REFRESH_TOKEN_EXPIRED);
        // Nothing was issued in its place.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL",
                        Long.class,
                        admin.getId()))
                .isEqualTo(1);
    }

    @Test
    void a_reader_has_no_absolute_lifetime_a_session_that_old_still_rotates() {
        Instant start = Instant.now().minus(Duration.ofDays(31)).truncatedTo(ChronoUnit.MICROS);
        String raw = refreshTokenService.open(reader(), startedAt(start)).rawToken();

        Instant before = Instant.now();
        RefreshTokenService.RotationResult rotated = refreshTokenService.rotate(raw);

        assertThat(expiresAt(rotated.newRawToken()))
                .isBetween(before.plus(READER), before.plus(READER).plus(SLACK));
        assertThat(rotated.authenticatedAt()).isEqualTo(start);
    }

    @Test
    void a_session_issued_to_the_caller_after_a_password_change_keeps_the_end_of_the_one_it_replaces() {
        // MfaService and PasswordChangeService issue the caller a new session with the SAME start (callerProof): the
        // deadline
        // cannot be pushed back by changing the password.
        User admin = account(UserRole.ADMIN);
        Instant start = Instant.now().minus(Duration.ofDays(29)).truncatedTo(ChronoUnit.MICROS);

        RefreshTokenService.IssuedToken replacement = refreshTokenService.open(admin, startedAt(start));

        assertThat(expiresAt(replacement.rawToken())).isBeforeOrEqualTo(start.plus(ABSOLUTE));
        assertThat(replacement.expiresInSeconds())
                .isLessThanOrEqualTo(Duration.ofDays(1).toSeconds());
    }
}
