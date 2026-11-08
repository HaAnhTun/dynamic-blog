package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.config.SecurityProperties;
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
import org.springframework.test.context.TestPropertySource;

/**
 * The two variables of the operator (PRIVILEGED_SESSION_IDLE_TTL and PRIVILEGED_SESSION_ABSOLUTE_TTL) reach the behavior through
 * application.yml: the same names as in {@code .env}, set here as properties of the context, which is how the placeholders of
 * application.yml read an environment variable. A context of its own, because the values are not the defaults.
 */
@TestPropertySource(properties = {"PRIVILEGED_SESSION_IDLE_TTL=36h", "PRIVILEGED_SESSION_ABSOLUTE_TTL=10d"})
class SessionLifetimeConfigurationIT extends AbstractIntegrationTest {

    @Autowired
    private SecurityProperties properties;

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private AuthTestSupport auth;

    @Test
    void the_variables_set_the_idle_timeout_and_the_absolute_lifetime() {
        assertThat(properties.privilegedSessionIdleTtl()).isEqualTo(Duration.ofHours(36));
        assertThat(properties.privilegedSessionAbsoluteTtl()).isEqualTo(Duration.ofDays(10));
        // The reader's life is not one of them.
        assertThat(properties.refreshTokenTtl()).isEqualTo(Duration.ofDays(30));
    }

    @Test
    void a_new_privileged_session_lives_the_configured_idle_timeout() {
        User admin = auth.createAccount("cau-hinh-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);

        RefreshTokenService.IssuedToken issued = refreshTokenService.open(admin, SessionProof.verified(Instant.now()));

        assertThat(issued.expiresInSeconds())
                .isBetween(
                        Duration.ofHours(36).toSeconds() - 1,
                        Duration.ofHours(36).toSeconds());
    }

    @Test
    void the_shorter_of_the_two_limits_wins() {
        User author = auth.createAccount("cau-hinh-" + UUID.randomUUID() + "@blog.local", UserRole.AUTHOR);
        Instant start = Instant.now()
                .minus(Duration.ofDays(10))
                .plus(Duration.ofHours(2))
                .truncatedTo(ChronoUnit.MICROS);

        RefreshTokenService.IssuedToken issued = refreshTokenService.open(author, new SessionProof(start, start));

        // 36 hours of idle time would be allowed, but the session ends 10 days after it started: two hours from now.
        assertThat(issued.expiresInSeconds())
                .isBetween(
                        Duration.ofHours(2).toSeconds() - 60,
                        Duration.ofHours(2).toSeconds());
    }
}
