package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.auth.oauth.GithubOAuthProperties;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

/**
 * Startup warning when GitHub login points at a machine that is not GitHub, or when only one
 * half of the client id / secret pair is set.
 */
class OAuthProviderOverrideWarningTest {

    private final Logger logger = (Logger) LoggerFactory.getLogger(OAuthProviderOverrideWarning.class);
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
    void real_github_is_silent() {
        run("client-id", "id", "client-secret", "secret");

        assertThat(logs.list).isEmpty();
    }

    @Test
    void each_address_other_than_github_com_or_api_github_com_is_one_WARN() {
        run(
                "client-id",
                "id",
                "client-secret",
                "secret",
                "provider.token-uri",
                "http://127.0.0.1:8089/login/oauth/access_token",
                "provider.user-info-uri",
                "https://api.github.com.evil.example/user");

        assertThat(warnings()).hasSize(2);
        assertThat(warnings().get(0))
                .contains("app.oauth.github.provider.token-uri")
                .contains("127.0.0.1");
        assertThat(warnings().get(1)).contains("app.oauth.github.provider.user-info-uri");
    }

    @Test
    void when_disabled_address_is_not_examined_but_half_of_client_id_secret_pair_warns() {
        run("provider.token-uri", "http://127.0.0.1:8089/x");
        assertThat(logs.list).isEmpty();

        run("client-id", "id");
        run("client-secret", "secret");
        assertThat(warnings())
                .hasSize(2)
                .allSatisfy(message -> assertThat(message).contains("Only one of GITHUB_CLIENT_ID"));
    }

    private void run(String... keyValues) {
        Map<String, String> source = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            source.put("app.oauth.github." + keyValues[i], keyValues[i + 1]);
        }
        GithubOAuthProperties properties = new Binder(new MapConfigurationPropertySource(source))
                .bindOrCreate("app.oauth.github", GithubOAuthProperties.class);
        new OAuthProviderOverrideWarning(properties).run(new DefaultApplicationArguments());
    }

    private List<String> warnings() {
        return logs.list.stream()
                .filter(event -> event.getLevel() == Level.WARN)
                .map(ILoggingEvent::getFormattedMessage)
                .toList();
    }
}
