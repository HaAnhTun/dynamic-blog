package com.blog.search.meili;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import com.blog.search.config.SearchProperties;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * Meilisearch keys: the value is derived as HMAC-SHA256(master, uid) and compared with an independently computed
 * vector (Python {@code hmac.new(master, uid, sha256).hexdigest()}); creation is idempotent and a key with the wrong
 * permissions is recreated. MeiliSearchIT checks the same derivation on a real container.
 */
class MeiliKeysTest {

    private static final String URL = "http://meili.test";
    private static final String MASTER = "test-master-key-at-least-32-characters-long";

    private final ObjectMapper objectMapper = JsonMapper.builder().build();
    private MockRestServiceServer server;
    private MeiliKeys keys;

    @BeforeEach
    void setUp() {
        RestClient.Builder builder = RestClient.builder();
        server = MockRestServiceServer.bindTo(builder).build();
        SearchProperties.Meili meili = new SearchProperties.Meili(
                URL, MASTER, "content_v1", Duration.ofMillis(500), Duration.ofMillis(800), Duration.ofSeconds(10));
        MeiliHttpClient client = new MeiliHttpClient(meili, objectMapper, builder, duration -> {}, () -> 0);
        keys = new MeiliKeys(client, new SearchProperties(SearchProperties.Engine.MEILISEARCH, meili));
    }

    @Test
    void key_value_is_lowercase_hex_of_hmac_sha256_master_uid() {
        assertThat(MeiliKeys.derive(MASTER, "3f6a9c2e-8b41-4d7a-9e15-6c0d2b7a4f81"))
                .isEqualTo("4a943b7ab5b94363e95cc1397a26fcd5a898e5638f6a0bc453bf857b25a657dd");
        assertThat(MeiliKeys.derive(MASTER, "a7d42e19-5c3b-4f86-b2a0-91e8d6c37f54"))
                .isEqualTo("71eb2f1a0c10e1cfd43aa7d95b2fc658278502a0d0d809096197783015421a5f");
        // The uid is always lowercase with dashes, as Meilisearch formats it before hashing.
        assertThat(MeiliKeys.derive(MASTER, "3F6A9C2E-8B41-4D7A-9E15-6C0D2B7A4F81"))
                .isEqualTo(MeiliKeys.derive(MASTER, MeiliKeys.SEARCH.uid()));
        assertThat(MeiliKeys.SEARCH.uid()).isEqualTo("3f6a9c2e-8b41-4d7a-9e15-6c0d2b7a4f81");
        assertThat(MeiliKeys.INDEXING.uid()).isEqualTo("a7d42e19-5c3b-4f86-b2a0-91e8d6c37f54");
    }

    @Test
    void both_keys_have_the_right_scope() {
        assertThat(MeiliKeys.SEARCH.actions()).containsExactly("search");
        assertThat(MeiliKeys.SEARCH.indexes()).containsExactly("content_*");
        assertThat(MeiliKeys.INDEXING.indexes()).containsExactly("*");
        assertThat(MeiliKeys.INDEXING.actions())
                .containsExactlyInAnyOrder(
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
                        "version");
        assertThat(MeiliKeys.INDEXING.actions()).noneMatch(action -> action.startsWith("keys") || action.equals("*"));
    }

    @Test
    void creates_missing_key_keeps_correct_key_and_recreates_key_with_wrong_permissions() {
        // The search key does not exist yet: create it, with a fixed uid and no expiry.
        server.expect(requestTo(URL + "/keys/" + MeiliKeys.SEARCH.uid()))
                .andExpect(method(HttpMethod.GET))
                .andExpect(header("Authorization", "Bearer " + MASTER))
                .andRespond(withStatus(HttpStatus.NOT_FOUND)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"code\":\"api_key_not_found\"}"));
        server.expect(requestTo(URL + "/keys"))
                .andExpect(method(HttpMethod.POST))
                .andExpect(content()
                        .json("{\"uid\":\"" + MeiliKeys.SEARCH.uid()
                                + "\",\"actions\":[\"search\"],\"indexes\":[\"content_*\"],\"expiresAt\":null}"))
                .andRespond(withStatus(HttpStatus.CREATED)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body(key(MeiliKeys.SEARCH, MeiliKeys.derive(MASTER, MeiliKeys.SEARCH.uid()))));
        // The indexing key exists but only on content_*: it cannot see the swap task, so delete and recreate it.
        server.expect(requestTo(URL + "/keys/" + MeiliKeys.INDEXING.uid()))
                .andRespond(withSuccess(
                        key(
                                new MeiliKeys.KeySpec(
                                        MeiliKeys.INDEXING.uid(),
                                        "old",
                                        MeiliKeys.INDEXING.actions(),
                                        List.of("content_*")),
                                null),
                        MediaType.APPLICATION_JSON));
        server.expect(requestTo(URL + "/keys/" + MeiliKeys.INDEXING.uid()))
                .andExpect(method(HttpMethod.DELETE))
                .andRespond(withStatus(HttpStatus.NO_CONTENT));
        server.expect(requestTo(URL + "/keys"))
                .andExpect(method(HttpMethod.POST))
                .andRespond(withStatus(HttpStatus.CREATED)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body(key(MeiliKeys.INDEXING, MeiliKeys.derive(MASTER, MeiliKeys.INDEXING.uid()))));

        keys.provision();
        server.verify();
        server.reset();

        // Next time: both are right, nothing is created.
        server.expect(requestTo(URL + "/keys/" + MeiliKeys.SEARCH.uid()))
                .andRespond(withSuccess(
                        key(MeiliKeys.SEARCH, MeiliKeys.derive(MASTER, MeiliKeys.SEARCH.uid())),
                        MediaType.APPLICATION_JSON));
        server.expect(requestTo(URL + "/keys/" + MeiliKeys.INDEXING.uid()))
                .andRespond(withSuccess(key(MeiliKeys.INDEXING, null), MediaType.APPLICATION_JSON));
        keys.provision();
        server.verify();
    }

    @Test
    void engine_value_differing_from_computed_value_is_a_key_error() {
        server.expect(requestTo(URL + "/keys/" + MeiliKeys.SEARCH.uid()))
                .andRespond(withSuccess(key(MeiliKeys.SEARCH, "0".repeat(64)), MediaType.APPLICATION_JSON));
        assertThatThrownBy(keys::provision)
                .isInstanceOfSatisfying(
                        MeiliException.class, e -> assertThat(e.code()).isEqualTo(MeiliException.Code.INVALID_API_KEY));
    }

    @Test
    void engine_absent_at_startup_does_not_throw_and_retries_with_pacing() {
        server.expect(requestTo(URL + "/keys/" + MeiliKeys.SEARCH.uid()))
                .andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE));
        keys.ensureProvisioned();
        // Right after: not yet time for a retry, nothing is called.
        keys.ensureProvisioned();
        server.verify();
    }

    private String key(MeiliKeys.KeySpec spec, String value) {
        Map<String, Object> body = new LinkedHashMap<>(
                Map.of("uid", spec.uid(), "name", spec.name(), "actions", spec.actions(), "indexes", spec.indexes()));
        body.put("expiresAt", null);
        if (value != null) {
            body.put("key", value);
        }
        return objectMapper.writeValueAsString(body);
    }
}
