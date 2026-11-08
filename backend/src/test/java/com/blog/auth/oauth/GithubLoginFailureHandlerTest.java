package com.blog.auth.oauth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.exception.ErrorCode;
import java.io.EOFException;
import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketException;
import java.net.http.HttpTimeoutException;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.mock.http.MockHttpInputMessage;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.ProviderNotFoundException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthorizationException;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClientException;
import tools.jackson.core.JacksonException;
import tools.jackson.core.exc.JacksonIOException;
import tools.jackson.databind.json.JsonMapper;

/**
 * Classification of GitHub login failures on exception chains that an IT can hardly build: GitHub refusing the connection
 * outright (nothing listens on that port), an error carrying no OAuth code, and an error code typed by the user into the
 * {@code error} parameter of the callback.
 *
 * The exception chains are built exactly as Spring Security 7.1 and Spring 7.0 build them (read from the source): RestClient wraps an
 * IO error before any response into ResourceAccessException, while an IO error while reading the response body becomes a plain RestClientException
 * wrapping a message-read error; the token client wraps every RestClientException into
 * {@code OAuth2AuthorizationException(invalid_token_response)}, and the login provider wraps that further into an
 * OAuth2AuthenticationException with the same code. The profile-read stage (DefaultOAuth2UserService) wraps directly into
 * {@code invalid_user_info_response}.
 */
class GithubLoginFailureHandlerTest {

    private static final GithubLoginFailureHandler.Outcome UNAVAILABLE = new GithubLoginFailureHandler.Outcome(
            ErrorCode.OAUTH_PROVIDER_UNAVAILABLE, HttpStatus.BAD_GATEWAY, "GitHub could not be reached");

    @Test
    void github_refusing_connection_is_502_OAUTH_PROVIDER_UNAVAILABLE() {
        RestClientException refused = new ResourceAccessException("I/O error", new ConnectException("refused"));

        assertThat(GithubLoginFailureHandler.classify(fromTokenClient(refused))).isEqualTo(UNAVAILABLE);
    }

    @Test
    void
            github_sending_headers_then_stalling_past_timeout_while_reading_token_body_is_also_502_not_OAUTH_LOGIN_FAILED() {
        // DefaultRestClient.readWithMessageConverters: the body stream is closed after 10 seconds, and that IO error
        // arrives here wrapped in
        // a plain RestClientException, via a message-read error, not via ResourceAccessException.
        RestClientException stalled = new RestClientException(
                "Error while extracting response",
                new HttpMessageNotReadableException(
                        "An error occurred reading the OAuth 2.0 Access Token Response",
                        new HttpTimeoutException("request timed out"),
                        new MockHttpInputMessage(new byte[0])));

        assertThat(GithubLoginFailureHandler.classify(fromTokenClient(stalled))).isEqualTo(UNAVAILABLE);
    }

    @Test
    void connection_dropped_mid_github_profile_body_is_502() {
        // Jackson 3 wraps the IO error of the body stream in JacksonIOException; DefaultOAuth2UserService wraps the
        // RestClientException
        // into invalid_user_info_response.
        RestClientException truncated = new RestClientException(
                "Error while extracting response",
                new HttpMessageNotReadableException(
                        "JSON parse error",
                        JacksonIOException.construct(new EOFException("Unexpected end of stream")),
                        new MockHttpInputMessage(new byte[0])));
        OAuth2Error error = new OAuth2Error("invalid_user_info_response", "An error occurred ...", null);

        assertThat(GithubLoginFailureHandler.classify(
                        new OAuth2AuthenticationException(error, error.toString(), truncated)))
                .isEqualTo(UNAVAILABLE);
    }

    @Test
    void response_200_with_github_error_is_message_read_error_so_OAUTH_LOGIN_FAILED() {
        RestClientException unreadable = new RestClientException(
                "Error while extracting response",
                new HttpMessageNotReadableException(
                        "Missing required parameter: access_token", new MockHttpInputMessage(new byte[0])));

        assertThat(GithubLoginFailureHandler.classify(fromTokenClient(unreadable))
                        .code())
                .isEqualTo(ErrorCode.OAUTH_LOGIN_FAILED);
    }

    @Test
    void malformed_json_fully_sent_by_github_is_not_io_error_so_OAUTH_LOGIN_FAILED() {
        // A Jackson 3 parse error (the library both stages use) is a RuntimeException, not an IOException as in
        // Jackson 2: the rule "an IOException in the chain means GitHub could not answer" does not catch it by mistake.
        Throwable malformed = catchThrowable(() -> JsonMapper.builder().build().readTree("{\"access_token\":"));
        assertThat(malformed).isInstanceOf(JacksonException.class).isNotInstanceOf(IOException.class);
        RestClientException unparsable = new RestClientException(
                "Error while extracting response",
                new HttpMessageNotReadableException(
                        "JSON parse error", malformed, new MockHttpInputMessage(new byte[0])));

        assertThat(GithubLoginFailureHandler.classify(fromTokenClient(unparsable))
                        .code())
                .isEqualTo(ErrorCode.OAUTH_LOGIN_FAILED);
    }

    @Test
    void error_without_oauth_code_is_OAUTH_LOGIN_FAILED_not_NullPointerException() {
        assertThat(GithubLoginFailureHandler.classify(new ProviderNotFoundException("no provider"))
                        .code())
                .isEqualTo(ErrorCode.OAUTH_LOGIN_FAILED);
    }

    @Test
    void only_really_locked_account_is_USER_SUSPENDED_while_hand_typed_error_user_suspended_on_callback_is_not() {
        assertThat(GithubLoginFailureHandler.classify(new GithubOAuth2UserService.SuspendedAccountException())
                        .code())
                .isEqualTo(ErrorCode.USER_SUSPENDED);

        // Exactly how Spring wraps the callback's error=user_suspended parameter.
        OAuth2Error typed = new OAuth2Error("user_suspended");
        AuthenticationException fromCallback =
                new OAuth2AuthenticationException(typed, typed.toString(), new OAuth2AuthorizationException(typed));
        assertThat(GithubLoginFailureHandler.classify(fromCallback).code()).isEqualTo(ErrorCode.OAUTH_LOGIN_FAILED);
    }

    @Test
    void network_error_wrapped_in_login_failed_is_not_github_down() {
        // Example: the DB does not answer after the profile was fully read. Only the token exchange and profile read
        // stages are "GitHub".
        AuthenticationException wrapped = new OAuth2AuthenticationException(
                new OAuth2Error("login_failed"), "GitHub login failed", new ResourceAccessException("I/O error"));

        assertThat(GithubLoginFailureHandler.classify(wrapped).code()).isEqualTo(ErrorCode.OAUTH_LOGIN_FAILED);

        // Even when the chain has a real IOException: losing the connection to Postgres while writing the account.
        AuthenticationException databaseDown = new OAuth2AuthenticationException(
                new OAuth2Error("login_failed"),
                "GitHub login failed",
                new DataAccessResourceFailureException("I/O error", new SocketException("Connection reset")));

        assertThat(GithubLoginFailureHandler.classify(databaseDown).code()).isEqualTo(ErrorCode.OAUTH_LOGIN_FAILED);
    }

    @Test
    void unknown_oauth_error_code_from_callback_is_not_logged_verbatim() throws Exception {
        Logger logger = (Logger) LoggerFactory.getLogger(GithubLoginFailureHandler.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        try {
            OAuth2Error injected = new OAuth2Error("x\ngithub login ok userId=gia");
            MockHttpServletResponse response = new MockHttpServletResponse();
            new GithubLoginFailureHandler(JsonMapper.builder().build())
                    .onAuthenticationFailure(
                            new MockHttpServletRequest(),
                            response,
                            new OAuth2AuthenticationException(
                                    injected, injected.toString(), new OAuth2AuthorizationException(injected)));

            assertThat(response.getStatus()).isEqualTo(401);
            assertThat(logs.list)
                    .singleElement()
                    .satisfies(event -> assertThat(event.getFormattedMessage())
                            .contains("oauthError=<not-loggable>")
                            .doesNotContain("userId=gia")
                            .doesNotContain("\n"));
        } finally {
            logger.detachAppender(logs);
        }
    }

    /** Exactly the chain that Spring's token client and login provider build around a RestClientException. */
    private static AuthenticationException fromTokenClient(RestClientException cause) {
        OAuth2Error error = new OAuth2Error("invalid_token_response", "An error occurred ...", null);
        return new OAuth2AuthenticationException(
                error, error.toString(), new OAuth2AuthorizationException(error, cause));
    }
}
