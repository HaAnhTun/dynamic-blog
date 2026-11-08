package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.post.config.ViewsProperties;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.DefaultApplicationArguments;

/**
 * An empty {@code VIEWS_TOKEN} on a public site: one WARN line at startup, startup is not refused. In that
 * case anyone who can reach the backend can add views, and views decide the "most read" order.
 */
class ViewsTokenWarningTest {

    private static final String RANDOM_TOKEN = "9d4f0b7a2c6e18530fa9d7b4c2e06a81b3f5d7092e4c6a8b0d2f4a6c8e0b2d46";

    private final Logger logger = (Logger) LoggerFactory.getLogger(ViewsTokenWarning.class);
    private final ListAppender<ILoggingEvent> logs = new ListAppender<>();

    @BeforeEach
    void capture() {
        logs.start();
        logger.addAppender(logs);
    }

    @AfterEach
    void release() {
        logger.detachAppender(logs);
    }

    @Test
    void public_site_with_empty_VIEWS_TOKEN_refuses_to_start_naming_the_variable() {
        for (String token : new String[] {"", "   ", null}) {
            assertThatThrownBy(() -> run("https://blog.example.com", token, true))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("VIEWS_TOKEN");
        }
    }

    @Test
    void production_by_default_without_opt_in_refuses_an_empty_token_even_on_localhost() {
        assertThatThrownBy(() -> run("http://localhost:3000", "", false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("VIEWS_TOKEN")
                .hasMessageContaining("APP_ALLOW_DEV_DEFAULTS");
        assertThatThrownBy(() -> run(null, "", false)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void production_with_a_token_starts() {
        assertThatCode(() -> run("https://blog.example.com", RANDOM_TOKEN, false))
                .doesNotThrowAnyException();
    }

    @Test
    void production_refuses_a_short_or_guessable_token_without_echoing_it() {
        for (String token : new String[] {"token", "k3Jd9fQx2LmP", "aaaaaaaaaaaaaaaaaaaaaaaa", "changemechangeme"}) {
            assertThatThrownBy(() -> run("https://blog.example.com", token, false))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("VIEWS_TOKEN")
                    .hasMessageContaining("openssl rand -hex 32")
                    .hasMessageNotContaining(token);
        }
    }

    @Test
    void an_opted_in_dev_machine_accepts_a_short_token() {
        assertThatCode(() -> run("http://localhost:3000", "dev", true)).doesNotThrowAnyException();
    }

    @Test
    void with_token_is_silent_and_never_prints_the_token() {
        run("https://blog.example.com", "token-chung-khong-duoc-in-ra", true);

        assertThat(logs.list).isEmpty();
    }

    @Test
    void opted_in_dev_machine_is_silent_even_with_empty_token() {
        run(null, "", true);
        run("http://localhost:3000", "", true);
        run("http://127.0.0.1:3100", null, true);

        assertThat(logs.list).isEmpty();
    }

    private void run(String siteUrl, String token, boolean devDefaultsAllowed) {
        new ViewsTokenWarning(
                        new ViewsProperties(token),
                        new ProductionMode(
                                new GithubOAuthProperties(null, null, null, siteUrl, null), devDefaultsAllowed))
                .run(new DefaultApplicationArguments());
    }

    private List<String> warnings() {
        return logs.list.stream()
                .filter(event -> event.getLevel() == Level.WARN)
                .map(ILoggingEvent::getFormattedMessage)
                .toList();
    }
}
