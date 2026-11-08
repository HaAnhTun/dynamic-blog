package com.blog.auth.oauth;

import com.blog.common.security.ApiAuthenticationEntryPoint;
import com.blog.user.service.GithubAccountService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.DefaultOAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestCustomizers;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.savedrequest.NullRequestCache;

/**
 * Dedicated chain for GitHub login, {@code /api/v1/auth/oauth2/**} ("githubLoginChain").
 *
 * <h2>Order among the three chains</h2>
 *
 * {@code @Order(2)}: after the SecurityConfig token-endpoint chain ({@code @Order(1)}, only /auth/login, /refresh,
 * /logout, which do not overlap with this chain's paths) and before the SecurityConfig main chain, which has no
 * {@code securityMatcher} (it matches every request) and declares no {@code @Order}, so it comes last. If this chain
 * came after the main chain it would never be consulted: every request would already have fallen into the
 * {@code denyAll} there. The main chain's rules still live only in SecurityConfig.
 *
 * <h2>Only Next calls these paths</h2>
 *
 * The browser only talks to the site's own origin; Next route handlers call
 * {@code /api/v1/auth/oauth2/authorization/github} (302 to GitHub with the signed blob) and
 * {@code /api/v1/auth/oauth2/callback/github} (200 with a TokenResponse) from the server. Therefore:
 * <ul>
 *   <li>no CSRF token: {@code state} is itself OAuth's CSRF guard, and the browser never calls these paths;</li>
 *   <li>STATELESS, {@link NullRequestCache}, the authorize request lives in an HMAC-signed cookie: no JSESSIONID is
 *       created;</li>
 *   <li>no {@code oauth2ResourceServer}: a stale Bearer header sent along must not break the login.</li>
 * </ul>
 *
 * <h2>When OAuth is off</h2>
 *
 * The chain still exists, just without {@code oauth2Login}: the request moves on to the DispatcherServlet and gets 404
 * ENDPOINT_NOT_FOUND, which Next turns into {@code /login?error=disabled}. Startup does not depend on
 * {@code GITHUB_*}.
 */
@Configuration
public class GithubLoginSecurityConfig {

    static final String BASE_PATH = "/api/v1/auth/oauth2";
    static final String AUTHORIZATION_BASE_URI = BASE_PATH + "/authorization";
    static final String CALLBACK_BASE_URI = BASE_PATH + "/callback/*";

    @Bean
    @Order(2)
    public SecurityFilterChain githubLoginChain(
            HttpSecurity http,
            ApiAuthenticationEntryPoint entryPoint,
            ObjectProvider<ClientRegistrationRepository> registrations,
            SignedCookieAuthorizationRequestRepository authorizationRequests,
            GithubAccountService githubAccounts,
            GithubLoginSuccessHandler successHandler,
            GithubLoginFailureHandler failureHandler)
            throws Exception {
        http.securityMatcher(BASE_PATH + "/**")
                .csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .requestCache(cache -> cache.requestCache(new NullRequestCache()))
                .exceptionHandling(ex -> ex.authenticationEntryPoint(entryPoint))
                .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());

        ClientRegistrationRepository repository = registrations.getIfAvailable();
        if (repository != null) {
            DefaultOAuth2AuthorizationRequestResolver pkce =
                    new DefaultOAuth2AuthorizationRequestResolver(repository, AUTHORIZATION_BASE_URI);
            // PKCE S256 even though the GitHub App is a client with a secret: a leaked code (proxy log, Referer) is
            // useless without the code_verifier, which lives only in the signed blob.
            pkce.setAuthorizationRequestCustomizer(OAuth2AuthorizationRequestCustomizers.withPkce());
            ClientHttpRequestFactory github = GithubHttpClients.requestFactory();

            http.oauth2Login(login -> login.clientRegistrationRepository(repository)
                    .authorizedClientRepository(new NoOpAuthorizedClientRepository())
                    .authorizationEndpoint(endpoint -> endpoint.baseUri(AUTHORIZATION_BASE_URI)
                            .authorizationRequestRepository(authorizationRequests)
                            // Unknown registration id: 404 ENDPOINT_NOT_FOUND as when OAuth is off, not Spring's 500.
                            .authorizationRequestResolver(
                                    new KnownRegistrationRequestResolver(pkce, repository, AUTHORIZATION_BASE_URI)))
                    .redirectionEndpoint(endpoint -> endpoint.baseUri(CALLBACK_BASE_URI))
                    .tokenEndpoint(endpoint ->
                            endpoint.accessTokenResponseClient(GithubHttpClients.tokenResponseClient(github)))
                    .userInfoEndpoint(endpoint -> endpoint.userService(
                            new GithubOAuth2UserService(GithubHttpClients.userInfoService(github), githubAccounts)))
                    .successHandler(successHandler)
                    .failureHandler(failureHandler));
        }
        return http.build();
    }
}
