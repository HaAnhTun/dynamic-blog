package com.blog.search.config;

import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.common.security.ProductionMode;
import java.util.Locale;
import java.util.Set;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * Enables {@link SearchProperties} ({@code app.search.*}), and applies a fail-fast startup check to the Meilisearch
 * master key: this configuration builds the same singletons before Tomcat accepts connections, so a broken rule means
 * the backend does not start.
 */
@Configuration
@EnableConfigurationProperties(SearchProperties.class)
public class SearchConfig {

    /** Stricter than the 16 bytes Meilisearch itself demands in production. */
    static final int MIN_MASTER_KEY_LENGTH = 32;
    /** The sample value of {@code MEILI_MASTER_KEY} in .env.example: anyone who reads the repository knows it. */
    public static final String PLACEHOLDER_MASTER_KEY = "change-me-openssl-rand-base64-48";

    private static final Set<String> PLACEHOLDERS = Set.of(PLACEHOLDER_MASTER_KEY);

    public SearchConfig(SearchProperties properties, GithubOAuthProperties oauth) {
        refuseUnsafeMeilisearch(properties, oauth.siteUrl());
    }

    /**
     * On a public site ({@link ProductionMode#isProduction}), when Meilisearch is used ({@code SEARCH_ENGINE=
     * meilisearch}, or {@code MEILI_URL} has a value: then the outbox and worker write the index), the master key must be
     * present, at least 32 characters long and not the sample value. The master key opens every index and every key of
     * the engine. Static so it can be checked without a context; the message names the variable, never the value.
     *
     * @throws IllegalStateException when the rule is not met
     */
    public static void refuseUnsafeMeilisearch(SearchProperties properties, String siteUrl) {
        SearchProperties.Meili meili = properties.meili();
        boolean used = properties.engine() == SearchProperties.Engine.MEILISEARCH
                || !meili.url().isEmpty();
        if (!used || !ProductionMode.isProduction(siteUrl)) {
            return;
        }
        String key = meili.masterKey();
        if (key.codePointCount(0, key.length()) < MIN_MASTER_KEY_LENGTH
                || PLACEHOLDERS.contains(key.toLowerCase(Locale.ROOT))) {
            throw new IllegalStateException("MEILI_MASTER_KEY must be a random value of at least "
                    + MIN_MASTER_KEY_LENGTH + " characters, not the placeholder from .env.example, when "
                    + "SEARCH_ENGINE=meilisearch or MEILI_URL is set and SITE_URL is not a loopback address: the master "
                    + "key opens every Meilisearch index and key. Generate one with: openssl rand -base64 48. "
                    + "For PostgreSQL search only, set SEARCH_ENGINE=postgres and leave MEILI_URL empty.");
        }
    }
}
