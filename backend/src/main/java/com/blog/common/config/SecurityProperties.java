package com.blog.common.config;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * The JWT secret has no default (fail-closed): the dev secret lives only in application-dev.yml (the Spring profile
 * {@code dev}, enabled by {@code mvn spring-boot:run}) and in the test configuration. Without JWT_SECRET the backend
 * refuses to start (SecurityConfig.refuseDevelopmentSecretInProduction), and so it does with the dev secret unless the
 * operator opted in (ProductionMode). DevSecretWarning still says so when the dev secret is in use on an opted-in run.
 *
 * The two refresh-token lifecycle properties have their defaults right here, not in application.yml, like
 * RateLimitProperties: set them only when they need adjusting. A negative duration stops the application from starting;
 * 0 is allowed.
 *
 * The life of a session depends on the role (RefreshTokenService). A reader keeps today's behavior: every refresh token
 * lives {@code refreshTokenTtl} from its issue, and the session slides for as long as it is used. An ADMIN or AUTHOR
 * session has two limits, both from the environment (application.yml: PRIVILEGED_SESSION_IDLE_TTL and
 * PRIVILEGED_SESSION_ABSOLUTE_TTL), because a stolen refresh cookie of a privileged account is worth more than a reader's:
 * it ends after {@code privilegedSessionIdleTtl} without use (every rotation renews it) and, however active it was,
 * {@code privilegedSessionAbsoluteTtl} after the person signed in. Both must be longer than zero.
 *
 * @param refreshTokenRevokedRetention how long a revoked token is kept before the nightly cleanup deletes it
 *                                     (RefreshTokenCleanup). Within that period, presenting it again counts as reuse
 * @param refreshTokenReuseGrace       a revoked token presented again within this period lost a token rotation race
 *                                     (two Next requests carrying the same cookie), it is not reuse
 *                                     (RefreshTokenService.rotate)
 */
@ConfigurationProperties(prefix = "app.security")
public record SecurityProperties(
        String jwtSecret,
        @DefaultValue("15m") Duration accessTokenTtl,
        @DefaultValue("30d") Duration refreshTokenTtl,
        @DefaultValue("7d") Duration refreshTokenRevokedRetention,
        @DefaultValue("2m") Duration refreshTokenReuseGrace,
        @DefaultValue("7d") Duration privilegedSessionIdleTtl,
        @DefaultValue("30d") Duration privilegedSessionAbsoluteTtl) {

    public SecurityProperties {
        requireNotNegative("refresh-token-revoked-retention", refreshTokenRevokedRetention);
        requireNotNegative("refresh-token-reuse-grace", refreshTokenReuseGrace);
        // An empty environment variable binds as null: it means "the default", not "no limit".
        privilegedSessionIdleTtl = privilegedSessionIdleTtl == null ? Duration.ofDays(7) : privilegedSessionIdleTtl;
        privilegedSessionAbsoluteTtl =
                privilegedSessionAbsoluteTtl == null ? Duration.ofDays(30) : privilegedSessionAbsoluteTtl;
        requirePositive("privileged-session-idle-ttl", privilegedSessionIdleTtl);
        requirePositive("privileged-session-absolute-ttl", privilegedSessionAbsoluteTtl);
    }

    private static void requirePositive(String name, Duration value) {
        if (value.isNegative() || value.isZero()) {
            throw new IllegalArgumentException(
                    "app.security." + name + " is invalid: " + value + " (must be longer than zero)");
        }
    }

    /**
     * Does not print the signing key: configuration is what ends up in a startup error or a debug line, and with this key
     * anyone can sign an ADMIN token. The state is enough to read a problem: set, unset, or the committed development key.
     */
    @Override
    public String toString() {
        String key = jwtSecret == null || jwtSecret.isBlank()
                ? "<unset>"
                : DEV_JWT_SECRET.equals(jwtSecret) ? "<dev-default>" : "<set>";
        return "SecurityProperties[jwtSecret=" + key + ", accessTokenTtl=" + accessTokenTtl + ", refreshTokenTtl="
                + refreshTokenTtl + ", refreshTokenRevokedRetention=" + refreshTokenRevokedRetention
                + ", refreshTokenReuseGrace=" + refreshTokenReuseGrace + ", privilegedSessionIdleTtl="
                + privilegedSessionIdleTtl + ", privilegedSessionAbsoluteTtl=" + privilegedSessionAbsoluteTtl + "]";
    }

    private static void requireNotNegative(String name, Duration value) {
        if (value == null || value.isNegative()) {
            throw new IllegalArgumentException(
                    "app.security." + name + " is invalid: " + value + " (must be zero or longer)");
        }
    }

    /**
     * The dev secret committed to the public repository, also the value in application-dev.yml and in the test
     * configuration (DevJwtSecretInProductionTest checks that they match). Whoever has it can sign ADMIN tokens for
     * every instance still using it.
     */
    public static final String DEV_JWT_SECRET = "dev-only-secret-change-me-this-must-be-at-least-32-bytes-long";
}
