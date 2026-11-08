package com.blog.auth.oauth;

import com.blog.common.security.ProductionMode;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.StringUtils;

/**
 * GitHub login for readers, bound from {@code app.oauth.github.*} (application.yml).
 *
 * Enabled if and only if both client id and client secret are present ({@link #enabled()}). If they are missing the
 * site still runs, it just cannot log in with GitHub: startup never depends on {@code GITHUB_*}. Boot's
 * {@code spring.security.oauth2.client.*} is not used, because there a blank client id breaks the whole startup.
 *
 * The callback GitHub calls back is the site's URL (a Next route), not the backend's: take {@code GITHUB_REDIRECT_URI},
 * or {@code SITE_URL} with every trailing / removed and {@value #CALLBACK_PATH} appended. There is no localhost default
 * anywhere: enabling OAuth with both missing makes {@link #validateWhenEnabled()} refuse to start. Spring's
 * {@code {baseUrl}} is also unusable, because the backend is only called by Next through an internal address.
 *
 * The constructor strips whitespace from every value and turns null into an empty string, like ViewsProperties: a stray
 * space in the .env file must not break login. {@link #toString()} does not print the secret.
 *
 * @param clientId     client id of the OAuth App on GitHub; blank means off
 * @param clientSecret client secret; blank means off
 * @param redirectUri  absolute callback ({@code GITHUB_REDIRECT_URI}); may be blank
 * @param siteUrl      public address of the site ({@code SITE_URL}); may be blank
 * @param provider     GitHub's addresses; the default is the real github.com
 */
@ConfigurationProperties("app.oauth.github")
public record GithubOAuthProperties(
        String clientId, String clientSecret, String redirectUri, String siteUrl, Provider provider) {

    /** The Next callback route (FE/app/api/auth/github/callback/route.ts). */
    public static final String CALLBACK_PATH = "/api/auth/github/callback";

    public GithubOAuthProperties {
        clientId = strip(clientId);
        clientSecret = strip(clientSecret);
        redirectUri = strip(redirectUri);
        siteUrl = strip(siteUrl);
        provider = provider == null ? new Provider(null, null, null) : provider;
    }

    /**
     * GitHub's three addresses. Only tests and E2E change them, to a fake GitHub on loopback; OAuthProviderOverrideWarning
     * then warns at startup. Not a knob for operators: they are in neither compose nor .env.example. A key that is
     * present but blank also means the default.
     */
    public record Provider(String authorizationUri, String tokenUri, String userInfoUri) {

        public static final String GITHUB_AUTHORIZATION_URI = "https://github.com/login/oauth/authorize";
        public static final String GITHUB_TOKEN_URI = "https://github.com/login/oauth/access_token";
        public static final String GITHUB_USER_INFO_URI = "https://api.github.com/user";

        /** The only hosts the real GitHub answers on: what a public site keeps (see {@link #validateWhenEnabled()}). */
        public static final Set<String> GITHUB_HOSTS = Set.of("github.com", "api.github.com");

        public Provider {
            authorizationUri = orDefault(authorizationUri, GITHUB_AUTHORIZATION_URI);
            tokenUri = orDefault(tokenUri, GITHUB_TOKEN_URI);
            userInfoUri = orDefault(userInfoUri, GITHUB_USER_INFO_URI);
        }

        private static String orDefault(String value, String fallback) {
            String stripped = strip(value);
            return stripped.isEmpty() ? fallback : stripped;
        }
    }

    /**
     * A single definition of "enabled" for both this record and GithubOAuthConfiguredCondition, which reads the
     * Environment directly before the record is bound. {@code hasText} ignores whitespace just like {@code strip()} in
     * the constructor.
     */
    public static boolean isEnabled(String clientId, String clientSecret) {
        return StringUtils.hasText(clientId) && StringUtils.hasText(clientSecret);
    }

    public boolean enabled() {
        return isEnabled(clientId, clientSecret);
    }

    /**
     * The callback sent to GitHub in both steps (authorize and exchanging the code for a token).
     *
     * @return {@code redirectUri} when present; otherwise {@code siteUrl} with every trailing / removed and
     *         {@value #CALLBACK_PATH} appended; null when both are blank
     */
    public String effectiveRedirectUri() {
        if (!redirectUri.isEmpty()) {
            return redirectUri;
        }
        if (siteUrl.isEmpty()) {
            return null;
        }
        int end = siteUrl.length();
        while (end > 0 && siteUrl.charAt(end - 1) == '/') {
            end--;
        }
        return siteUrl.substring(0, end) + CALLBACK_PATH;
    }

    /**
     * Refuses to start when OAuth is enabled but the configuration is unusable. When disabled nothing is checked.
     *
     * It refuses when: there is no callback; the callback or a GitHub address is not an absolute https URL (http is only
     * allowed for a loopback host: localhost, 127.0.0.0/8, ::1, the same definition as
     * {@link ProductionMode#isLoopbackHost}); the callback is not exactly the path {@value #CALLBACK_PATH}, or has a
     * query or fragment.
     *
     * The error message names only the configuration NAME, never the value, and does not chain the original exception
     * (a URISyntaxException message copies the value verbatim): the startup log is where a value lives longest.
     *
     * @throws IllegalStateException when OAuth is enabled but misconfigured
     */
    public void validateWhenEnabled() {
        if (!enabled()) {
            return;
        }
        String callback = effectiveRedirectUri();
        if (callback == null) {
            throw new IllegalStateException("GITHUB_CLIENT_ID/SECRET are set but neither GITHUB_REDIRECT_URI nor "
                    + "SITE_URL is. GitHub must be given the site's own callback, <SITE_URL>" + CALLBACK_PATH
                    + ": set SITE_URL (or GITHUB_REDIRECT_URI), or unset the client id and secret to turn GitHub "
                    + "login off.");
        }
        String source = redirectUri.isEmpty()
                ? "SITE_URL (app.oauth.github.site-url)"
                : "GITHUB_REDIRECT_URI (app.oauth.github.redirect-uri)";
        URI uri = requireAllowedUrl(callback, source);
        if (!CALLBACK_PATH.equals(uri.getRawPath()) || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalStateException(source + " must lead to the site's " + CALLBACK_PATH
                    + " exactly, with no query or fragment: that is the route that finishes a GitHub login.");
        }
        requireAllowedUrl(provider.authorizationUri(), "app.oauth.github.provider.authorization-uri");
        requireAllowedUrl(provider.tokenUri(), "app.oauth.github.provider.token-uri");
        requireAllowedUrl(provider.userInfoUri(), "app.oauth.github.provider.user-info-uri");
        if (ProductionMode.isProduction(siteUrl, redirectUri)) {
            requireGithubItself(provider.authorizationUri(), "app.oauth.github.provider.authorization-uri");
            requireGithubItself(provider.tokenUri(), "app.oauth.github.provider.token-uri");
            requireGithubItself(provider.userInfoUri(), "app.oauth.github.provider.user-info-uri");
        }
    }

    /**
     * On a public site (a {@code SITE_URL} or {@code GITHUB_REDIRECT_URI} whose host is not loopback) the three addresses
     * must be https on github.com or api.github.com, on the default port: whoever answers there says who signs in and
     * as which person, the administrator included (ADMIN_GITHUB_ID). The override exists for the tests and the E2E stack,
     * which run on a loopback site, where it stays allowed; elsewhere it used to be a warning only.
     */
    private static void requireGithubItself(String value, String property) {
        URI uri = URI.create(value);
        boolean github = "https".equalsIgnoreCase(uri.getScheme())
                && uri.getHost() != null
                && Provider.GITHUB_HOSTS.contains(uri.getHost().toLowerCase(Locale.ROOT))
                && uri.getUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() == 443);
        if (!github) {
            throw new IllegalStateException(property + " must point at github.com or api.github.com when SITE_URL "
                    + "(or GITHUB_REDIRECT_URI) is a public address: whoever answers there decides who signs in, even "
                    + "as the administrator. The override is only for tests and the E2E stack on a loopback address; "
                    + "remove it.");
        }
    }

    private static URI requireAllowedUrl(String value, String property) {
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException e) {
            throw notAllowed(property);
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (!uri.isAbsolute() || scheme == null || host == null) {
            throw notAllowed(property);
        }
        boolean https = "https".equalsIgnoreCase(scheme);
        boolean loopbackHttp = "http".equalsIgnoreCase(scheme) && ProductionMode.isLoopbackHost(host);
        if (!https && !loopbackHttp) {
            throw notAllowed(property);
        }
        return uri;
    }

    private static IllegalStateException notAllowed(String property) {
        return new IllegalStateException(property + " must be an absolute https URL "
                + "(plain http is accepted only for a loopback host: localhost, 127.0.0.0/8 or ::1).");
    }

    private static String strip(String value) {
        return value == null ? "" : value.strip();
    }

    /**
     * Does not print the secret. A record's generated toString prints every component, and configuration is something
     * that often ends up in logs or error messages. The client id is public: it is already in the authorize URL that
     * every browser sees.
     */
    @Override
    public String toString() {
        return "GithubOAuthProperties[clientId=" + clientId
                + ", clientSecret=" + (clientSecret.isEmpty() ? "<blank>" : "<set>")
                + ", redirectUri=" + redirectUri
                + ", siteUrl=" + siteUrl
                + ", provider=" + provider + "]";
    }
}
