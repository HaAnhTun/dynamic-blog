package com.blog.common.security;

import com.blog.auth.oauth.GithubOAuthProperties;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

/**
 * Whether the backend runs as a public site ("production") or on a dev machine. One single rule for every place that
 * needs to know:
 * <ul>
 *   <li>the committed dev JWT secret, or no JWT secret at all: refuse to start (SecurityConfig, when building the bean,
 *       before Tomcat accepts connections);</li>
 *   <li>the admin still has the dev password: refuse to start (DevCredentialWarning), and that password is always
 *       rejected at login (AuthService), even while the startup runners have not finished;</li>
 *   <li>{@code VIEWS_TOKEN} is blank: refuse to start (ViewsTokenWarning);</li>
 *   <li>{@code CLIENT_IP_TOKEN} is blank: refuse to start (ClientIpTokenCheck).</li>
 * </ul>
 *
 * The backend is fail-closed: it is production unless the operator opts in to development defaults. The opt-in is
 * explicit and has two forms only: the Spring profile {@value #DEV_PROFILE} (what {@code mvn spring-boot:run} enables,
 * see application-dev.yml, and what the tests use) or {@code APP_ALLOW_DEV_DEFAULTS=true} (the property
 * {@value #ALLOW_DEV_DEFAULTS_PROPERTY}) for throw-away E2E and CI stacks. A public {@code SITE_URL} (a host that is
 * not localhost, 127.0.0.0/8 or ::1, or a GitHub redirect URI with such a host) is production even with the opt-in:
 * a forgotten dev flag on a reachable site is exactly the mistake to block. A value from which no host can be read is
 * public too: if it cannot be proven to be a dev machine, pick the safe side.
 *
 * Decided once when the bean is built ({@link #active()}); the static functions are for places without a bean
 * (SecurityConfig) and for tests.
 */
@Component
public class ProductionMode {

    /** The Spring profile that `mvn spring-boot:run` enables. */
    public static final String DEV_PROFILE = "dev";

    /** The property behind the environment variable {@code APP_ALLOW_DEV_DEFAULTS}. */
    public static final String ALLOW_DEV_DEFAULTS_PROPERTY = "app.allow-dev-defaults";

    private final boolean active;
    private final boolean devDefaultsAllowed;

    @Autowired
    public ProductionMode(GithubOAuthProperties oauth, Environment environment) {
        this(oauth, devDefaultsAllowed(environment));
    }

    public ProductionMode(GithubOAuthProperties oauth, boolean devDefaultsAllowed) {
        this.devDefaultsAllowed = devDefaultsAllowed;
        this.active = !devDefaultsAllowed || isProduction(oauth.siteUrl(), oauth.redirectUri());
    }

    /** Production: no opt-in to development defaults, or a public address. */
    public boolean active() {
        return active;
    }

    /** The operator opted in to development defaults (profile dev or APP_ALLOW_DEV_DEFAULTS=true). */
    public boolean devDefaultsAllowed() {
        return devDefaultsAllowed;
    }

    /** The explicit opt-in: the {@value #DEV_PROFILE} profile is active, or {@value #ALLOW_DEV_DEFAULTS_PROPERTY} is true. */
    public static boolean devDefaultsAllowed(Environment environment) {
        return environment.acceptsProfiles(Profiles.of(DEV_PROFILE))
                || environment.getProperty(ALLOW_DEV_DEFAULTS_PROPERTY, Boolean.class, false);
    }

    /**
     * @param siteUrl the value of {@code SITE_URL}; null or blank means not set
     * @return true when it has a value and its host is not loopback, including when no host can be read
     */
    public static boolean isProduction(String siteUrl) {
        if (siteUrl == null || siteUrl.isBlank()) {
            return false;
        }
        String host;
        try {
            host = new URI(siteUrl.strip()).getHost();
        } catch (URISyntaxException e) {
            return true;
        }
        return !isLoopbackHost(host);
    }

    /** {@link #isProduction(String)} for {@code SITE_URL}, or for {@code GITHUB_REDIRECT_URI} when {@code SITE_URL} is empty. */
    public static boolean isProduction(String siteUrl, String githubRedirectUri) {
        return isProduction(siteUrl) || isProduction(githubRedirectUri);
    }

    /**
     * localhost (case-insensitive), or a literal loopback IP address: 127.0.0.0/8 and ::1, with or without the square
     * brackets that {@code URI.getHost()} returns for IPv6. No DNS lookup: a host name other than localhost is never
     * loopback, wherever it points.
     */
    public static boolean isLoopbackHost(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        if ("localhost".equalsIgnoreCase(host)) {
            return true;
        }
        try {
            return InetAddress.ofLiteral(host).isLoopbackAddress();
        } catch (IllegalArgumentException e) {
            // Not a literal IP address: a host name.
            return false;
        }
    }
}
