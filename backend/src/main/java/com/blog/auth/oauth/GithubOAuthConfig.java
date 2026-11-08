package com.blog.auth.oauth;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.oauth2.client.CommonOAuth2Provider;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;

/**
 * The GitHub registration, only when GitHub login is configured.
 *
 * No {@link ClientRegistrationRepository} bean means OAuth is off: GithubLoginSecurityConfig still builds the chain for
 * {@code /api/v1/auth/oauth2/**} but without {@code oauth2Login}, so every request there falls through to the
 * DispatcherServlet and gets 404 ENDPOINT_NOT_FOUND, which Next turns into {@code /login?error=disabled}.
 *
 * If it is enabled but misconfigured, this bean cannot be built and the application does not start
 * ({@link GithubOAuthProperties#validateWhenEnabled()}): a login button that is always broken is worse than a failed
 * startup while someone is watching.
 */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(GithubOAuthProperties.class)
public class GithubOAuthConfig {

    /** The last segment of {@code /api/v1/auth/oauth2/authorization/github} and {@code …/callback/github}. */
    public static final String REGISTRATION_ID = "github";

    @Bean
    @Conditional(GithubOAuthConfiguredCondition.class)
    public ClientRegistrationRepository githubClientRegistrationRepository(GithubOAuthProperties properties) {
        properties.validateWhenEnabled();
        ClientRegistration github = CommonOAuth2Provider.GITHUB
                .getBuilder(REGISTRATION_ID)
                .clientId(properties.clientId())
                .clientSecret(properties.clientSecret())
                // Absolute, never {baseUrl}: GitHub must be given the site's own URL.
                .redirectUri(properties.effectiveRedirectUri())
                // Public profile only; the email is not requested.
                .scope("read:user")
                .authorizationUri(properties.provider().authorizationUri())
                .tokenUri(properties.provider().tokenUri())
                .userInfoUri(properties.provider().userInfoUri())
                .build();
        return new InMemoryClientRegistrationRepository(github);
    }
}
