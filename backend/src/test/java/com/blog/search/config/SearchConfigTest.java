package com.blog.search.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.search.config.SearchProperties.Engine;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Startup check of the Meilisearch master key, like DevJwtSecretInProductionTest: checks the RULE without a context,
 * and that SearchConfig's factory method (a singleton built before Tomcat accepts connections) calls it. The message
 * never contains the key or SITE_URL.
 */
class SearchConfigTest {

    private static final String PUBLIC_SITE = "https://blog.example.com";
    private static final String GOOD_KEY = "mot-master-key-that-ngau-nhien-dai-hon-32-ky-tu";
    private static final String MEILI_URL = "http://meilisearch:7700";

    @ParameterizedTest
    @ValueSource(
            strings = {
                "",
                "ngan-qua-31-ky-tu-0123456789abc",
                SearchConfig.PLACEHOLDER_MASTER_KEY,
                "CHANGE-ME-OPENSSL-RAND-BASE64-48"
            })
    void public_site_using_meilisearch_with_blank_short_or_placeholder_key_is_rejected(String key) {
        for (SearchProperties properties : new SearchProperties[] {
            properties(Engine.MEILISEARCH, "", key),
            properties(Engine.MEILISEARCH, MEILI_URL, key),
            // Postgres engine but with MEILI_URL: the outbox and worker still write the index with this key.
            properties(Engine.POSTGRES, MEILI_URL, key)
        }) {
            Throwable thrown = catchThrowable(() -> SearchConfig.refuseUnsafeMeilisearch(properties, PUBLIC_SITE));
            assertThat(thrown)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("MEILI_MASTER_KEY")
                    .hasMessageContaining("SITE_URL")
                    .hasMessageContaining("openssl rand")
                    .hasMessageNotContaining(PUBLIC_SITE)
                    .hasMessageNotContaining(MEILI_URL);
            if (!key.isEmpty()) {
                assertThat(thrown).hasMessageNotContaining(key);
            }
        }
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"http://localhost:3000", "http://127.0.0.1:3100", "http://[::1]:3000"})
    void dev_machine_starts_with_any_key(String siteUrl) {
        assertThatCode(() ->
                        SearchConfig.refuseUnsafeMeilisearch(properties(Engine.MEILISEARCH, MEILI_URL, "dev"), siteUrl))
                .doesNotThrowAnyException();
    }

    @Test
    void postgres_only_search_needs_no_key_and_a_good_key_is_accepted() {
        assertThatCode(() -> SearchConfig.refuseUnsafeMeilisearch(properties(Engine.POSTGRES, "", ""), PUBLIC_SITE))
                .doesNotThrowAnyException();
        assertThatCode(() -> SearchConfig.refuseUnsafeMeilisearch(
                        properties(Engine.MEILISEARCH, MEILI_URL, GOOD_KEY), PUBLIC_SITE))
                .doesNotThrowAnyException();
        // Exactly 32 characters is enough; the placeholder pattern only matches the whole value.
        assertThatCode(() -> SearchConfig.refuseUnsafeMeilisearch(
                        properties(Engine.MEILISEARCH, MEILI_URL, "a".repeat(32)), PUBLIC_SITE))
                .doesNotThrowAnyException();
        assertThatCode(() -> SearchConfig.refuseUnsafeMeilisearch(
                        properties(Engine.MEILISEARCH, MEILI_URL, SearchConfig.PLACEHOLDER_MASTER_KEY + "x"),
                        PUBLIC_SITE))
                .doesNotThrowAnyException();
    }

    @Test
    void config_factory_method_applies_the_rule() {
        assertThatThrownBy(() -> new SearchConfig(
                        properties(Engine.MEILISEARCH, MEILI_URL, SearchConfig.PLACEHOLDER_MASTER_KEY),
                        oauth(PUBLIC_SITE)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("MEILI_MASTER_KEY");
        assertThatCode(() -> new SearchConfig(properties(Engine.MEILISEARCH, MEILI_URL, ""), oauth("")))
                .doesNotThrowAnyException();
    }

    private static SearchProperties properties(Engine engine, String url, String masterKey) {
        return new SearchProperties(
                engine,
                new SearchProperties.Meili(
                        url,
                        masterKey,
                        "content_v1",
                        Duration.ofMillis(500),
                        Duration.ofMillis(800),
                        Duration.ofSeconds(10)));
    }

    private static GithubOAuthProperties oauth(String siteUrl) {
        return new GithubOAuthProperties(null, null, null, siteUrl, null);
    }
}
