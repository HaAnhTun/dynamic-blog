package com.blog.common.security;

import com.blog.auth.oauth.GithubOAuthProperties;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * Speaks up at startup when GitHub login points at a machine that is not GitHub.
 *
 * GitHub's addresses can only be changed through {@code app.oauth.github.provider.*}, which is in neither compose nor
 * .env.example: tests and E2E use it to point at a fake GitHub on loopback. A production machine that still has that
 * configuration lets the other machine decide the logged-in person's profile, so there must be a WARN line nobody can
 * miss.
 *
 * It also warns when only one of {@code GITHUB_CLIENT_ID} / {@code GITHUB_CLIENT_SECRET} is set: GitHub login is then
 * off, and without this line the operator would only see the login button saying "not enabled".
 */
@Component
@RequiredArgsConstructor
public class OAuthProviderOverrideWarning implements ApplicationRunner {

    static final Set<String> GITHUB_HOSTS = GithubOAuthProperties.Provider.GITHUB_HOSTS;

    private static final Logger log = LoggerFactory.getLogger(OAuthProviderOverrideWarning.class);

    private final GithubOAuthProperties properties;

    @Override
    public void run(ApplicationArguments args) {
        if (!properties.enabled()) {
            if (StringUtils.hasText(properties.clientId()) != StringUtils.hasText(properties.clientSecret())) {
                log.warn("Only one of GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET is set, so GitHub login stays off. "
                        + "Set both to turn it on, or neither.");
            }
            return;
        }
        GithubOAuthProperties.Provider provider = properties.provider();
        warnUnlessGithub("app.oauth.github.provider.authorization-uri", provider.authorizationUri());
        warnUnlessGithub("app.oauth.github.provider.token-uri", provider.tokenUri());
        warnUnlessGithub("app.oauth.github.provider.user-info-uri", provider.userInfoUri());
    }

    private static void warnUnlessGithub(String property, String uri) {
        String host = hostOf(uri);
        if (host == null || !GITHUB_HOSTS.contains(host.toLowerCase(Locale.ROOT))) {
            log.warn(
                    "{} points at {} instead of GitHub. That is only for tests against a mock GitHub; "
                            + "never leave it set in production.",
                    property,
                    host == null ? "an unparseable address" : host);
        }
    }

    private static String hostOf(String uri) {
        try {
            return new URI(uri).getHost();
        } catch (URISyntaxException e) {
            return null;
        }
    }
}
