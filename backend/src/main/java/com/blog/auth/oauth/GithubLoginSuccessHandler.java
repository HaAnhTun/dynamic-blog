package com.blog.auth.oauth;

import com.blog.auth.entity.FirstFactor;
import com.blog.auth.service.AuthService;
import com.blog.auth.service.FirstFactorResult;
import com.blog.common.response.ApiResponse;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.web.authentication.AuthenticationSuccessHandler;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * Ends a GitHub login: returns to Next exactly the {@code TokenResponse} that {@code POST /api/v1/auth/login}
 * returns, in the JSON body of the callback itself.
 *
 * There is no one-time "hand-off code": only the Next server reads this response (it calls the backend callback from
 * the server), so the tokens never sit in a URL, a redirect or the page's JavaScript. Next sets the two session cookies
 * with the very same functions the admin login page uses. {@code Cache-Control: no-store}: the response carries tokens,
 * so no proxy may keep it.
 *
 * The log has only the blog account id and "whether it was just created": no token, no GitHub login, no email.
 */
@Component
@RequiredArgsConstructor
public class GithubLoginSuccessHandler implements AuthenticationSuccessHandler {

    private static final Logger log = LoggerFactory.getLogger(GithubLoginSuccessHandler.class);

    private final UserRepository userRepository;
    private final AuthService authService;
    private final ObjectMapper objectMapper;

    @Override
    public void onAuthenticationSuccess(
            HttpServletRequest request, HttpServletResponse response, Authentication authentication)
            throws IOException {
        if (!(authentication.getPrincipal() instanceof GithubPrincipal principal)) {
            throw failed(null);
        }
        FirstFactorResult result;
        try {
            User user = userRepository
                    .findById(principal.userId())
                    .orElseThrow(() -> new IllegalStateException("The account of this GitHub login no longer exists"));
            result = authService.completeFirstFactor(user, FirstFactor.GITHUB);
        } catch (RuntimeException e) {
            // An error here (the DB not answering while issuing the refresh token) also goes through the failure
            // handler: this method runs inside the login filter's try block, so a thrown AuthenticationException
            // becomes a 401 OAUTH_LOGIN_FAILED with an error envelope, not a bare 500.
            throw failed(e);
        }

        // A session: 200 with the token pair. A second step is due: 202 with the challenge and no token at all, which
        // Next
        // turns into a redirect to the code page. Either way the response is never cached.
        response.setStatus(
                result instanceof FirstFactorResult.Session
                        ? HttpServletResponse.SC_OK
                        : HttpServletResponse.SC_ACCEPTED);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        Object body = switch (result) {
            case FirstFactorResult.Session session -> session.tokens();
            case FirstFactorResult.Challenge challenge -> challenge.challenge();
        };
        objectMapper.writeValue(response.getOutputStream(), ApiResponse.of(body));
        log.info("github login ok userId={} created={}", principal.userId(), principal.created());
    }

    private static OAuth2AuthenticationException failed(RuntimeException cause) {
        return new OAuth2AuthenticationException(
                new OAuth2Error(GithubOAuth2UserService.LOGIN_FAILED), "GitHub login failed", cause);
    }
}
