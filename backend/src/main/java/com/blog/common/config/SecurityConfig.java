package com.blog.common.config;

import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.auth.service.TokenService;
import com.blog.common.security.ApiAccessDeniedHandler;
import com.blog.common.security.ApiAuthenticationEntryPoint;
import com.blog.common.security.ApiBearerFailureHandler;
import com.blog.common.security.CurrentAccessJwtConverter;
import com.blog.common.security.ProductionMode;
import com.blog.common.security.SecretStrength;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.stream.IntStream;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.ObjectPostProcessor;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtAudienceValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableConfigurationProperties({SecurityProperties.class, com.blog.common.security.AdminAccountProperties.class})
@EnableMethodSecurity
public class SecurityConfig {

    /** Argon2id memory cost in KiB: 19 MiB, the OWASP minimum (see {@link #passwordEncoder()}). */
    static final int ARGON2_MEMORY_KIB = 19_456;

    /** Argon2id iterations (OWASP minimum for 19 MiB). */
    static final int ARGON2_ITERATIONS = 2;

    /** Argon2id degree of parallelism (OWASP minimum). */
    static final int ARGON2_PARALLELISM = 1;

    /**
     * Argon2id with the OWASP Password Storage Cheat Sheet minimum for the algorithm: 19 MiB of memory, 2 iterations,
     * 1 degree of parallelism (the first row of its table; the other rows trade memory for iterations at the same
     * strength). Spring Security's own defaults use 16 MiB, which is below that row, so the numbers are stated here.
     * The salt is 16 bytes and the hash 32 bytes, as before.
     *
     * Raising a number later is safe: a stored hash carries its own parameters, so older hashes keep verifying, and
     * {@code AuthService.login} replaces a hash whose parameters are weaker ({@code upgradeEncoding}) by a fresh one
     * after a correct password. Each check holds about 19 MiB while it runs, and the number of checks at once is limited
     * ({@code LoginConcurrencyLimiter}, default 2), so a login costs about 38 MiB of heap at most.
     *
     * Requires BouncyCastle on the classpath, see pom.xml.
     */
    @Bean
    public PasswordEncoder passwordEncoder() {
        return new Argon2PasswordEncoder(16, 32, ARGON2_PARALLELISM, ARGON2_MEMORY_KIB, ARGON2_ITERATIONS);
    }

    /**
     * HMAC-SHA256 with a shared secret, which suits a single-service deployment: there is
     * no second party that needs to verify these tokens without the secret, so the key
     * management an asymmetric pair would require buys nothing here.
     */
    /**
     * RFC 7518 §3.2 requires a key at least as long as the hash output for HMAC, so HS256
     * needs 256 bits. Nimbus enforces it too — but at the moment it first SIGNS, which is
     * the first login, not startup. The difference matters operationally: a deployment with
     * a 10-character secret boots, serves the public site, passes a health check, and then
     * fails the first time anyone tries to log in, with a KeyLengthException in a stack
     * trace. Refusing to start says the same thing at the moment somebody is watching.
     */
    private static final int MIN_SECRET_BYTES = 32;

    /** A floor against "aaaa..." and "abababab...", not a measure of strength: random data and any passphrase clear it easily. */
    private static final int MIN_DISTINCT_SECRET_BYTES = 8;

    /**
     * Static so it can be tested without a Spring context.
     *
     * The alternative — asserting that a real application refuses to start — turned out to
     * be untestable in isolation: the datasource bean fails first when the database is not
     * reachable, so a test that stubs the database to force a fast failure gets the wrong
     * exception and proves nothing. Extracting the rule makes the rule testable; that the
     * rule runs during startup is a property of `jwtEncoder` being an eager singleton, and
     * is verified by hand against a running application.
     *
     * Public because the OAuth cookie signing key (SignedCookieAuthorizationRequestRepository) is also derived from
     * JWT_SECRET: whichever bean is built first, a too-short secret still gets this exact message, not JCA's "Empty key"
     * error.
     */
    public static byte[] requireUsableSecret(String secret) {
        if (secret == null || secret.isBlank()) {
            throw new IllegalStateException(MISSING_SECRET_MESSAGE);
        }
        byte[] key = secret.getBytes(StandardCharsets.UTF_8);
        if (key.length < MIN_SECRET_BYTES) {
            // Reports the length, never the value. A startup exception is the one place a
            // secret would survive log rotation and end up pasted into a support ticket.
            throw new IllegalStateException("JWT_SECRET is " + key.length + " bytes; HS256 requires at least "
                    + MIN_SECRET_BYTES + ". Generate one with: openssl rand -base64 48");
        }
        // A long secret made of one repeated character (or a few) is guessable however long it is. Counts the different
        // bytes, never prints them. Anything produced by `openssl rand` has dozens; a passphrase has well over this.
        int distinct = (int) IntStream.range(0, key.length)
                .map(i -> key[i] & 0xff)
                .distinct()
                .count();
        if (distinct < MIN_DISTINCT_SECRET_BYTES) {
            throw new IllegalStateException("JWT_SECRET has only " + distinct + " different bytes; it needs at least "
                    + MIN_DISTINCT_SECRET_BYTES
                    + " so that it cannot be guessed. Generate one with: openssl rand -base64 48");
        }
        return key;
    }

    private static final String MISSING_SECRET_MESSAGE = "JWT_SECRET is not set. Set it to a new random value "
            + "(openssl rand -base64 48). A development machine gets a development secret from the Spring profile dev "
            + "(mvn spring-boot:run); a throw-away stack can opt in with APP_ALLOW_DEV_DEFAULTS=true and its own "
            + "JWT_SECRET.";

    /**
     * Fail-closed: the backend refuses to start without a real JWT secret unless the operator opted in to development
     * defaults ({@link ProductionMode#devDefaultsAllowed(org.springframework.core.env.Environment)}: the dev profile,
     * or {@code APP_ALLOW_DEV_DEFAULTS=true}). A missing secret and the committed dev secret are both refused: anyone
     * who reads the repository could sign an ADMIN token for that instance, so a WARN (DevSecretWarning) is not enough.
     * A public {@code SITE_URL} is production even with the opt-in ({@link ProductionMode#isProduction}).
     *
     * In production a secret that is long enough but guessable is refused too ({@link SecretStrength}: a placeholder
     * word, one repeated pattern, fewer than 6 different characters, a run like abcdefghij), because the HS256 key is the
     * only barrier between the internet and an ADMIN token. Every value of the documented commands passes.
     *
     * Static for the same reason as {@link #requireUsableSecret}: the rule can be checked without a context. Called from
     * {@link #jwtEncoder}, an eagerly built singleton, so the backend stops before Tomcat accepts any connection. It is
     * not placed in GithubOAuthConfig: that configuration is built on its own in tests with a public SITE_URL and the
     * dev secret.
     *
     * The message names the variables, never the values: no secret, no SITE_URL.
     */
    public static void refuseDevelopmentSecretInProduction(
            String secret, boolean devDefaultsAllowed, String siteUrl, String githubRedirectUri) {
        boolean production = !devDefaultsAllowed || ProductionMode.isProduction(siteUrl, githubRedirectUri);
        if (!production) {
            return;
        }
        if (secret == null || secret.isBlank()) {
            throw new IllegalStateException(MISSING_SECRET_MESSAGE);
        }
        if (SecurityProperties.DEV_JWT_SECRET.equals(secret)) {
            throw new IllegalStateException("JWT_SECRET is the development default committed to this repository, "
                    + "and this is not an opted-in development run (Spring profile dev or APP_ALLOW_DEV_DEFAULTS=true, "
                    + "with SITE_URL empty or loopback), so anyone who reads the repository could sign an ADMIN token "
                    + "for it. Set JWT_SECRET to a new random value (openssl rand -base64 48).");
        }
        // The length is requireUsableSecret's job (it runs next, in hmacKey); here only what a long value can still be.
        SecretStrength.require("JWT_SECRET", secret, 0, "openssl rand -base64 48");
    }

    private SecretKey hmacKey(SecurityProperties properties) {
        return new SecretKeySpec(requireUsableSecret(properties.jwtSecret()), "HmacSHA256");
    }

    @Bean
    public JwtEncoder jwtEncoder(SecurityProperties properties, GithubOAuthProperties oauth, Environment environment) {
        refuseDevelopmentSecretInProduction(
                properties.jwtSecret(),
                ProductionMode.devDefaultsAllowed(environment),
                oauth.siteUrl(),
                oauth.redirectUri());
        return NimbusJwtEncoder.withSecretKey(hmacKey(properties)).build();
    }

    /**
     * HS256 only (a token with another algorithm, {@code none} included, is refused before any claim is read), and a token is
     * accepted only if it is timed, from this issuer and for this API: {@link #accessTokenValidator}.
     */
    @Bean
    public JwtDecoder jwtDecoder(SecurityProperties properties) {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(hmacKey(properties))
                .macAlgorithm(MacAlgorithm.HS256)
                // The claims that must be PRESENT in the token itself, checked on the raw claim set: Spring fills in a
                // missing
                // `iat` from `exp` before its validators run (a token without `iat` would look issued a second before
                // it
                // expires and slip past the revocation cut-off), and lets a token without `exp` live forever.
                .jwtProcessorCustomizer(processor -> processor.setJWTClaimsSetVerifier(
                        new DefaultJWTClaimsVerifier<SecurityContext>(null, REQUIRED_CLAIMS)))
                .build();
        decoder.setJwtValidator(accessTokenValidator());
        return decoder;
    }

    /**
     * What an access token must be besides well signed and complete ({@link #REQUIRED_CLAIMS}): not expired (the default timestamp
     * check), and from the issuer and for the audience this backend gives (TokenService). Static so a test can reach it without a
     * context.
     */
    static OAuth2TokenValidator<Jwt> accessTokenValidator() {
        return JwtValidators.createDefaultWithValidators(List.<OAuth2TokenValidator<Jwt>>of(
                new JwtIssuerValidator(TokenService.ISSUER), new JwtAudienceValidator(TokenService.AUDIENCE)));
    }

    /** The claims every access token carries: when it expires, when it was issued, and whose it is. */
    private static final Set<String> REQUIRED_CLAIMS = Set.of("exp", "iat", "sub");

    /**
     * The endpoints that mint or retire tokens get their own chain, ahead of the main one,
     * and it has no `oauth2ResourceServer`.
     *
     * Spring Security's bearer-token filter authenticates any `Authorization: Bearer`
     * header that is present, before `authorizeHttpRequests` is consulted — so
     * `permitAll()` does not save a request that arrives with an expired token attached.
     * Measured on the single-chain version: a POST /auth/logout carrying a correctly-signed
     * but expired access token was rejected 401 by the filter, revoke never ran, and the
     * refresh token was still usable afterwards. Logout silently did nothing.
     *
     * That is the common case, not an edge one: the access token lives 15 minutes, the
     * refresh token 30 days, and most clients attach whatever access token they hold to
     * every request.
     *
     * /auth/me is deliberately NOT here — it needs the token, so it stays in the main chain.
     */
    @Bean
    @Order(1)
    public SecurityFilterChain authTokenEndpointsChain(HttpSecurity http) throws Exception {
        // /api/v1/setup (first-run claim) and /api/v1/setup/status are here for the same reason: they are called before
        // any account exists, and a stale Bearer header must not turn them into a 401. SetupService does the checks.
        return http.securityMatcher(
                        "/api/v1/auth/login",
                        "/api/v1/auth/refresh",
                        "/api/v1/auth/logout",
                        // The second step of a sign-in: the challenge is the credential, there is no session yet.
                        "/api/v1/auth/mfa/verify",
                        "/api/v1/auth/mfa/enroll/begin",
                        "/api/v1/auth/mfa/enroll/confirm",
                        "/api/v1/setup",
                        "/api/v1/setup/status")
                .csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
                .build();
    }

    /**
     * The real rules. Note the fallback is denyAll, not authenticated: a new endpoint
     * added without a matching rule becomes unreachable, which is a visible failure,
     * rather than quietly readable by any authenticated caller.
     *
     * It has no {@code @Order}, so it comes last, after the GitHub login chain too
     * ({@code GithubLoginSecurityConfig}, {@code @Order(2)}, {@code /api/v1/auth/oauth2/**}): requests to those paths
     * never reach here. If an {@code @Order} is ever added to this chain, it must stay greater than 2.
     */
    @Bean
    public SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            ApiAuthenticationEntryPoint entryPoint,
            ApiAccessDeniedHandler accessDeniedHandler,
            CurrentAccessJwtConverter currentAccess,
            ApiBearerFailureHandler bearerFailure)
            throws Exception {
        return http.csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> jwt.jwtAuthenticationConverter(currentAccess))
                        .authenticationEntryPoint(entryPoint)
                        .accessDeniedHandler(accessDeniedHandler)
                        .withObjectPostProcessor(new ObjectPostProcessor<BearerTokenAuthenticationFilter>() {
                            @Override
                            public <O extends BearerTokenAuthenticationFilter> O postProcess(O filter) {
                                filter.setAuthenticationFailureHandler(bearerFailure);
                                return filter;
                            }
                        }))
                .exceptionHandling(
                        ex -> ex.authenticationEntryPoint(entryPoint).accessDeniedHandler(accessDeniedHandler))
                .authorizeHttpRequests(auth -> auth.requestMatchers(
                                "/api/v1/auth/login",
                                "/api/v1/auth/refresh",
                                "/api/v1/auth/logout",
                                "/api/v1/auth/mfa/verify",
                                "/api/v1/auth/mfa/enroll/begin",
                                "/api/v1/auth/mfa/enroll/confirm")
                        .permitAll()
                        .requestMatchers("/api/v1/auth/me")
                        .authenticated()
                        .requestMatchers(HttpMethod.POST, "/api/v1/auth/sessions/revoke-all")
                        .authenticated()
                        // The signed-in person's own security. The status is open to any signed-in account (a reader's
                        // is
                        // "not enrolled, not required"); managing two-step verification is for ADMIN and AUTHOR only;
                        // the
                        // password change needs a password, which the service checks. Each mutation also needs a recent
                        // sign-in and its own step-up, in the service.
                        .requestMatchers(HttpMethod.GET, "/api/v1/me/mfa")
                        .authenticated()
                        .requestMatchers("/api/v1/me/mfa/**", "/api/v1/me/mfa")
                        .hasAnyRole("ADMIN", "AUTHOR")
                        .requestMatchers(HttpMethod.POST, "/api/v1/me/password")
                        .authenticated()
                        // /api/v1/media/**: images are "unlisted, not private": anyone with the URL (a random
                        // UUID v4) can download them, including the cover of a draft post and hidden gallery photos.
                        // GET only: HEAD falls through to denyAll, which is fine, because Next answers HEAD itself by
                        // running GET.
                        // /api/v1/gallery/** only lists visible photos; hidden ones appear only in the admin list.
                        // /api/v1/stats only counts what the public pages already list.
                        // /api/v1/users/*: exactly one slug segment, the public profile; anything deeper or any other
                        // method still falls through to denyAll.
                        .requestMatchers(
                                HttpMethod.GET,
                                "/api/v1/posts/**",
                                "/api/v1/categories/**",
                                "/api/v1/tags/**",
                                "/api/v1/series/**",
                                "/api/v1/gallery/**",
                                "/api/v1/media/**",
                                "/api/v1/stats",
                                "/api/v1/users/*",
                                "/api/v1/search",
                                // The owner's site content for one locale (profile, about ...): public by design, and
                                // it holds only validated plain text. Drafts do not exist for it.
                                "/api/v1/site-content")
                        .permitAll()
                        // The only write that needs no login: +1 on the view counter of a published post, nothing
                        // else. Exactly one slug segment and then "views", so no other POST under /posts is opened.
                        // The optional shared token (app.views.token) is checked in PostViewService: URL rules cannot
                        // compare headers.
                        .requestMatchers(HttpMethod.POST, "/api/v1/posts/*/views")
                        .permitAll()
                        // Newsletter: subscribing, confirming and unsubscribing need no login; for the last two the
                        // credential is the token.
                        .requestMatchers(
                                HttpMethod.POST,
                                "/api/v1/newsletter/subscriptions",
                                "/api/v1/newsletter/confirm",
                                "/api/v1/newsletter/unsubscribe")
                        .permitAll()
                        // The contact form: sending needs no login. Exactly this one method and path; the inbox is
                        // under
                        // /api/v1/admin/contact/** below (ADMIN only).
                        .requestMatchers(HttpMethod.POST, "/api/v1/contact/messages")
                        .permitAll()
                        // Comments and post likes need a login, for every role including USER. Who may edit or delete
                        // which comment is the service's job (only the author), and a suspended person is blocked there
                        // (CurrentUserService.requireActive), because URL rules cannot read the DB. Reading comments
                        // and likes is GET under /api/v1/posts/**, already opened above. Each rule is exactly one
                        // method and exactly one {slug} or {id} segment: other methods on the same path still fall
                        // through to denyAll.
                        .requestMatchers(HttpMethod.POST, "/api/v1/posts/*/comments")
                        .authenticated()
                        .requestMatchers(HttpMethod.PUT, "/api/v1/posts/*/like")
                        .authenticated()
                        .requestMatchers(HttpMethod.DELETE, "/api/v1/posts/*/like")
                        .authenticated()
                        .requestMatchers(HttpMethod.POST, "/api/v1/comments/*/replies")
                        .authenticated()
                        .requestMatchers(HttpMethod.PUT, "/api/v1/comments/*")
                        .authenticated()
                        .requestMatchers(HttpMethod.DELETE, "/api/v1/comments/*")
                        .authenticated()
                        // Comment likes and the notification inbox need a login, any role. A suspended person is
                        // blocked in the service (requireActive), and everyone can only touch their own notifications
                        // (recipient_id in every SQL statement), because URL rules cannot read the DB. "*" is exactly
                        // one segment: the DELETE /api/v1/comments/* rule above does not match /comments/{id}/like, and
                        // every other method on these paths (GET on comment likes, PUT or PATCH on notifications...)
                        // still falls through to denyAll.
                        .requestMatchers(HttpMethod.PUT, "/api/v1/comments/*/like")
                        .authenticated()
                        .requestMatchers(HttpMethod.DELETE, "/api/v1/comments/*/like")
                        .authenticated()
                        .requestMatchers(HttpMethod.GET, "/api/v1/notifications", "/api/v1/notifications/unread-count")
                        .authenticated()
                        .requestMatchers(
                                HttpMethod.POST, "/api/v1/notifications/read-all", "/api/v1/notifications/*/read")
                        .authenticated()
                        .requestMatchers(HttpMethod.DELETE, "/api/v1/notifications/*")
                        .authenticated()
                        // The caller's own author application: view and submit.
                        .requestMatchers(HttpMethod.GET, "/api/v1/me/author-application")
                        .authenticated()
                        .requestMatchers(HttpMethod.POST, "/api/v1/me/author-application")
                        .authenticated()
                        // The caller's own bookmarks: the list, and the state/save/unsave of one post by slug.
                        .requestMatchers(HttpMethod.GET, "/api/v1/me/bookmarks", "/api/v1/me/bookmarks/*")
                        .authenticated()
                        .requestMatchers(HttpMethod.PUT, "/api/v1/me/bookmarks/*")
                        .authenticated()
                        .requestMatchers(HttpMethod.DELETE, "/api/v1/me/bookmarks/*")
                        .authenticated()
                        // The health check must be reachable without a token, and it has to be
                        // listed here explicitly: the fallback below is denyAll, not
                        // authenticated, so an endpoint nobody added a rule for is refused with
                        // 403 rather than quietly open. A health check that always answers 403 is
                        // one a proxy believes, and it takes the whole site out of rotation.
                        .requestMatchers("/api/v1/health")
                        .permitAll()
                        // Swagger is off by default (application.yml; the dev profile of spring-boot:run turns it
                        // back on). When off, these paths reach the DispatcherServlet and give 404
                        // ENDPOINT_NOT_FOUND like any missing path (SpringDocDisabledIT); when on, they are readable
                        // without a token.
                        .requestMatchers("/swagger-ui/**", "/swagger-ui.html", "/v3/api-docs/**")
                        .permitAll()
                        // The admin area is ADMIN only BY DEFAULT: a controller added under /api/v1/admin/** that
                        // nobody
                        // decided about is refused to an AUTHOR, not open to the least trusted writer. What an AUTHOR
                        // may enter is this list and nothing else; each tree is then narrowed per handler, by
                        // @PreAuthorize (owner or ADMIN, ADMIN only) or in the service (an author's own posts, the
                        // shared
                        // taxonomy pool), and AdminRouteAuthorizationCoverageIT fails for a handler in these trees that
                        // has no reviewed decision. The first matching rule wins, so this list comes before the
                        // default.
                        // Images in a post body are under posts/{id}/images: the permission on them is the permission
                        // on
                        // the post (owner or ADMIN).
                        .requestMatchers(
                                "/api/v1/admin/posts/**",
                                "/api/v1/admin/post-import/**",
                                "/api/v1/admin/tags/**",
                                "/api/v1/admin/categories/**",
                                "/api/v1/admin/analytics/**")
                        .hasAnyRole("ADMIN", "AUTHOR")
                        // Everything else under /api/v1/admin is the site owner's: users, comment moderation, author
                        // applications, the newsletter, the contact inbox, the search index, the site content and its
                        // import, sample content, series, the gallery and the image storage of the whole site.
                        .requestMatchers("/api/v1/admin/**")
                        .hasRole("ADMIN")
                        .anyRequest()
                        .denyAll())
                .build();
    }
}
