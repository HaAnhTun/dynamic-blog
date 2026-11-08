package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.common.ratelimit.ClientIpProperties;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;

/**
 * An empty {@code CLIENT_IP_TOKEN} in production refuses to start (the backend could not tell the readers behind Next apart),
 * the same fail-closed rule as {@code VIEWS_TOKEN}.
 */
class ClientIpTokenCheckTest {

    private static final String RANDOM_TOKEN = "5b8e1d4a7c0f3926ad5b8e1d4a7c0f3926b1e4d7a0c3f6925a8b1e4d7a0c3f69";

    @Test
    void public_site_with_empty_CLIENT_IP_TOKEN_refuses_to_start_naming_the_variable() {
        for (String token : new String[] {"", "   ", null}) {
            assertThatThrownBy(() -> run("https://blog.example.com", token, true))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("CLIENT_IP_TOKEN");
        }
    }

    @Test
    void production_by_default_without_opt_in_refuses_an_empty_token_even_on_localhost() {
        assertThatThrownBy(() -> run("http://localhost:3000", "", false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("CLIENT_IP_TOKEN")
                .hasMessageContaining("APP_ALLOW_DEV_DEFAULTS");
        assertThatThrownBy(() -> run(null, "", false)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void production_refuses_a_short_or_guessable_token_without_echoing_it() {
        for (String token : new String[] {"token", "k3Jd9fQx2LmP", "aaaaaaaaaaaaaaaaaaaaaaaa", "changemechangeme"}) {
            assertThatThrownBy(() -> run("https://blog.example.com", token, false))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("CLIENT_IP_TOKEN")
                    .hasMessageContaining("openssl rand -hex 32")
                    .hasMessageNotContaining(token);
        }
    }

    @Test
    void an_opted_in_dev_machine_accepts_a_short_token() {
        assertThatCode(() -> run("http://localhost:3000", "dev", true)).doesNotThrowAnyException();
    }

    @Test
    void production_with_a_token_starts_and_the_message_of_a_refusal_never_holds_the_token() {
        assertThatCode(() -> run("https://blog.example.com", RANDOM_TOKEN, false))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> run("https://blog.example.com", "", false))
                .hasMessageNotContaining("token=")
                .hasMessageNotContaining("https://blog.example.com");
    }

    @Test
    void opted_in_dev_machine_accepts_an_empty_token() {
        assertThatCode(() -> {
                    run(null, "", true);
                    run("http://localhost:3000", "", true);
                    run("http://127.0.0.1:3100", null, true);
                })
                .doesNotThrowAnyException();
    }

    @Test
    void a_public_site_is_production_even_with_the_opt_in() {
        assertThatThrownBy(() -> run("https://blog.example.com", "", true)).isInstanceOf(IllegalStateException.class);
    }

    private void run(String siteUrl, String token, boolean devDefaultsAllowed) {
        new ClientIpTokenCheck(
                        new ClientIpProperties(token),
                        new ProductionMode(
                                new GithubOAuthProperties(null, null, null, siteUrl, null), devDefaultsAllowed))
                .run(new DefaultApplicationArguments());
    }
}
