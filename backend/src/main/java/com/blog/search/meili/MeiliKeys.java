package com.blog.search.meili;

import com.blog.search.config.SearchProperties;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Duration;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * The two Meilisearch keys of the backend, created with the master key under fixed uids, idempotently: the search key
 * only has {@code search} on {@code content_*}; the indexing key writes and administers indexes, on {@code ["*"]} because
 * the index-swap task is a global task that an index-restricted key cannot see. The value need not be read back:
 * Meilisearch computes it as the lowercase hex of HMAC-SHA256(master key, uid), so the backend computes it itself
 * ({@link #derive}); MeiliSearchIT checks that against a real container.
 *
 * Meilisearch not running at startup is fine: only a log line, search is degraded, and the next search tries again (at
 * most every 30 seconds). The actions and indexes of a key cannot be edited: a mismatched key is deleted and recreated
 * with the same uid (the same value).
 */
@Component
public class MeiliKeys {

    private static final Logger log = LoggerFactory.getLogger(MeiliKeys.class);

    /**
     * @param indexes index name patterns; {@code content_*} matches every MEILI_INDEX_NAME that is accepted (SearchProperties)
     */
    public record KeySpec(String uid, String name, List<String> actions, List<String> indexes) {

        Map<String, Object> body() {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("uid", uid);
            body.put("name", name);
            body.put("actions", actions);
            body.put("indexes", indexes);
            body.put("expiresAt", null);
            return body;
        }
    }

    public static final KeySpec SEARCH =
            new KeySpec("3f6a9c2e-8b41-4d7a-9e15-6c0d2b7a4f81", "blog-search", List.of("search"), List.of("content_*"));
    public static final KeySpec INDEXING = new KeySpec(
            "a7d42e19-5c3b-4f86-b2a0-91e8d6c37f54",
            "blog-indexing",
            List.of(
                    "documents.add",
                    "documents.get",
                    "documents.delete",
                    "indexes.create",
                    "indexes.get",
                    "indexes.delete",
                    "indexes.swap",
                    "settings.get",
                    "settings.update",
                    "tasks.get",
                    "stats.get",
                    "version"),
            List.of("*"));

    private static final Duration RETRY = Duration.ofSeconds(30);

    private final MeiliHttpClient client;
    private final SearchProperties properties;
    private final Throttle retry = new Throttle(RETRY);
    private volatile boolean provisioned;

    public MeiliKeys(MeiliHttpClient client, SearchProperties properties) {
        this.client = client;
        this.properties = properties;
    }

    /** The value of the key with this uid: lowercase hex of HMAC-SHA256(master key, uid in hyphenated lowercase form). */
    public static String derive(String masterKey, String uid) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(masterKey.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of()
                    .formatHex(mac.doFinal(uid.toLowerCase(Locale.ROOT).getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is not available", e);
        }
    }

    /**
     * Creates missing keys, recreates keys whose permissions differ. Idempotent.
     *
     * @throws MeiliException when Meilisearch does not answer, or the value it holds differs from the computed one
     */
    public void provision() {
        for (KeySpec spec : List.of(SEARCH, INDEXING)) {
            ensure(spec);
        }
        if (!provisioned) {
            log.info("meilisearch keys ready search={} indexing={}", SEARCH.name(), INDEXING.name());
        }
        provisioned = true;
    }

    /** Before a search or write: does nothing when already done; otherwise tries, at most every 30 seconds, swallowing errors. */
    public void ensureProvisioned() {
        if (provisioned || !properties.meili().configured() || !retry.tryAcquire()) {
            return;
        }
        try {
            provision();
        } catch (MeiliException e) {
            // MeiliHttpClient already logged; the next call will fail with the same error and search is degraded.
        }
    }

    /** Meilisearch rejected a key (deleted, engine rebuilt): try to recreate it next time. */
    public void invalidate() {
        provisioned = false;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void provisionAtStartup() {
        if (properties.engine() == SearchProperties.Engine.MEILISEARCH
                && properties.meili().configured()) {
            ensureProvisioned();
        }
    }

    private void ensure(KeySpec spec) {
        JsonNode key = client.getKey(spec.uid()).orElse(null);
        if (key != null && !sameScope(key, spec)) {
            client.deleteKey(spec.uid());
            key = null;
        }
        if (key == null) {
            key = client.createKey(spec.body());
        }
        // If Meilisearch returns a value it must equal the computed one, otherwise every call with this key fails.
        JsonNode value = key.path("key");
        if (value.isString()
                && !value.asString().equals(derive(properties.meili().masterKey(), spec.uid()))) {
            log.warn("meilisearch key value differs from the derived value key={}", spec.name());
            throw new MeiliException(MeiliException.Code.INVALID_API_KEY);
        }
    }

    private static boolean sameScope(JsonNode key, KeySpec spec) {
        return strings(key.path("actions")).equals(Set.copyOf(spec.actions()))
                && strings(key.path("indexes")).equals(Set.copyOf(spec.indexes()))
                && key.path("expiresAt").isNull();
    }

    private static Set<String> strings(JsonNode array) {
        Set<String> values = new HashSet<>();
        array.forEach(node -> values.add(node.asString()));
        return values;
    }
}
