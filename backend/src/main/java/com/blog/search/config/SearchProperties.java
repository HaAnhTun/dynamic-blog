package com.blog.search.config;

import com.fasterxml.jackson.annotation.JsonValue;
import java.time.Duration;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Search settings, bound from {@code app.search.*}.
 *
 * @param engine engine that answers {@code GET /api/v1/search} ({@code SEARCH_ENGINE}); Postgres by default
 * @param meili  Meilisearch: only called when {@code engine} is meilisearch, or when an admin builds the index
 */
@ConfigurationProperties("app.search")
public record SearchProperties(
        @DefaultValue("postgres") Engine engine,
        @DefaultValue Meili meili) {

    public enum Engine {
        POSTGRES,
        MEILISEARCH;

        /** Name in JSON and in the environment variable: lowercase. */
        @JsonValue
        public String value() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /**
     * {@link #toString()} does not print the key: this record may end up in a log or in a Spring bind error report.
     *
     * @param url            {@code MEILI_URL}; empty means not configured (every call becomes an engine error, search degraded)
     * @param masterKey      {@code MEILI_MASTER_KEY}: used only to create the two child keys, never for queries
     * @param indexName      {@code MEILI_INDEX_NAME}: the serving index
     * @param connectTimeout wait for opening a connection, every call
     * @param searchTimeout  wait for the answer of one search (contract: 800 ms, then return the Postgres result)
     * @param adminTimeout   wait for the answer of a write, a task read, a key creation: a document body is much larger than a search
     */
    public record Meili(
            @DefaultValue("") String url,
            @DefaultValue("") String masterKey,
            @DefaultValue("content_v1") String indexName,
            @DefaultValue("500ms") Duration connectTimeout,
            @DefaultValue("800ms") Duration searchTimeout,
            @DefaultValue("10s") Duration adminTimeout) {

        private static final Pattern INDEX_NAME = Pattern.compile("content_[A-Za-z0-9_-]{1,100}");

        public Meili {
            url = url == null ? "" : url.strip();
            masterKey = masterKey == null ? "" : masterKey.strip();
            indexName = indexName == null || indexName.isBlank() ? "content_v1" : indexName.strip();
            // The search key only sees content_*: any other name would make every search degraded and nobody would know
            // why.
            if (!INDEX_NAME.matcher(indexName).matches()) {
                throw new IllegalArgumentException("app.search.meili.index-name must match content_[A-Za-z0-9_-]+");
            }
        }

        public boolean configured() {
            return !url.isEmpty() && !masterKey.isEmpty();
        }

        @Override
        public String toString() {
            return "Meili[url=" + (url.isEmpty() ? "<empty>" : "<set>") + ", masterKey="
                    + (masterKey.isEmpty() ? "<empty>" : "<set>") + ", indexName=" + indexName + ", connectTimeout="
                    + connectTimeout + ", searchTimeout=" + searchTimeout + ", adminTimeout=" + adminTimeout + "]";
        }
    }
}
