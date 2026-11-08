package com.blog.search.meili;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withException;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.search.config.SearchProperties;
import java.io.IOException;
import java.net.ConnectException;
import java.net.ServerSocket;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * The Meilisearch client without a real engine: the task-wait state machine with a fake clock, error-to-code mapping,
 * which key is for what, and no error body or query reaching an error message or the log.
 */
class MeiliHttpClientTest {

    private static final String URL = "http://meili.test";
    private static final String MASTER = "test-master-key-at-least-32-characters-long";
    private static final String SECRET = "truyvanbimat";

    private final ObjectMapper objectMapper = JsonMapper.builder().build();
    private final List<Duration> sleeps = new ArrayList<>();
    private long now;
    private MockRestServiceServer server;
    private MeiliHttpClient client;
    private ListAppender<ILoggingEvent> logs;
    private Logger logger;

    @BeforeEach
    void setUp() {
        RestClient.Builder builder = RestClient.builder();
        server = MockRestServiceServer.bindTo(builder).build();
        client = new MeiliHttpClient(
                config(URL, MASTER),
                objectMapper,
                builder,
                duration -> {
                    sleeps.add(duration);
                    now += duration.toNanos();
                },
                () -> now);
        logs = new ListAppender<>();
        logs.start();
        logger = (Logger) LoggerFactory.getLogger(MeiliHttpClient.class);
        logger.addAppender(logs);
    }

    @AfterEach
    void tearDown() {
        logger.detachAppender(logs);
    }

    private static SearchProperties.Meili config(String url, String master) {
        return new SearchProperties.Meili(
                url, master, "content_v1", Duration.ofMillis(500), Duration.ofMillis(800), Duration.ofSeconds(10));
    }

    private void task(long uid, String body) {
        server.expect(requestTo(URL + "/tasks/" + uid))
                .andExpect(method(HttpMethod.GET))
                .andExpect(header("Authorization", "Bearer " + MeiliKeys.derive(MASTER, MeiliKeys.INDEXING.uid())))
                .andRespond(withSuccess(body, MediaType.APPLICATION_JSON));
    }

    @Test
    void waits_task_enqueued_processing_then_succeeded_with_25ms_doubling_pace() {
        task(7, "{\"uid\":7,\"status\":\"enqueued\"}");
        task(7, "{\"uid\":7,\"status\":\"processing\"}");
        task(7, "{\"uid\":7,\"status\":\"processing\"}");
        task(7, "{\"uid\":7,\"status\":\"succeeded\"}");

        MeiliTask done = client.waitForTask(7, Duration.ofSeconds(30));

        assertThat(done.status()).isEqualTo("succeeded");
        assertThat(done.finished()).isTrue();
        assertThat(sleeps).containsExactly(Duration.ofMillis(25), Duration.ofMillis(50), Duration.ofMillis(100));
        server.verify();
    }

    @Test
    void wait_pace_never_exceeds_1_second_and_expiry_is_task_timeout() {
        for (int i = 0; i < 9; i++) {
            task(8, "{\"uid\":8,\"status\":\"processing\"}");
        }

        assertThatThrownBy(() -> client.waitForTask(8, Duration.ofMillis(3000)))
                .isInstanceOf(MeiliException.class)
                .extracting(e -> ((MeiliException) e).code())
                .isEqualTo(MeiliException.Code.TASK_TIMEOUT);
        // 25+50+100+200+400+800 = 1575 ms, then the 1 s cap, then the remainder of the 3 s deadline.
        assertThat(sleeps)
                .containsExactly(
                        Duration.ofMillis(25),
                        Duration.ofMillis(50),
                        Duration.ofMillis(100),
                        Duration.ofMillis(200),
                        Duration.ofMillis(400),
                        Duration.ofMillis(800),
                        Duration.ofMillis(1000),
                        Duration.ofMillis(425));
        assertThat(sleeps).allSatisfy(sleep -> assertThat(sleep).isLessThanOrEqualTo(Duration.ofSeconds(1)));
    }

    @Test
    void task_failed_carries_the_task_error_code_and_canceled_has_its_own_code() {
        task(
                9,
                "{\"uid\":9,\"status\":\"failed\",\"error\":{\"message\":\"" + SECRET
                        + " is bad\",\"code\":\"invalid_document_id\",\"type\":\"invalid_request\"}}");
        task(10, "{\"uid\":10,\"status\":\"enqueued\"}");
        task(10, "{\"uid\":10,\"status\":\"canceled\"}");
        assertThatThrownBy(() -> client.waitForTask(9, Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(MeiliException.class, e -> {
                    assertThat(e.code()).isEqualTo(MeiliException.Code.TASK_FAILED);
                    assertThat(e.engineCode()).isEqualTo("invalid_document_id");
                    assertThat(e.getMessage()).doesNotContain(SECRET);
                    assertThat(e.code().engineWide()).isFalse();
                });

        assertThatThrownBy(() -> client.waitForTask(10, Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(
                        MeiliException.class, e -> assertThat(e.code()).isEqualTo(MeiliException.Code.TASK_CANCELED));
        server.verify();
        assertNoSecretLogged();
    }

    @Test
    void search_uses_search_key_writes_use_indexing_key_key_management_uses_master() {
        server.expect(requestTo(URL + "/multi-search"))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("Authorization", "Bearer " + MeiliKeys.derive(MASTER, MeiliKeys.SEARCH.uid())))
                .andRespond(withSuccess("{\"results\":[{\"hits\":[],\"totalHits\":0}]}", MediaType.APPLICATION_JSON));
        server.expect(requestTo(URL + "/indexes/content_v1/documents?primaryKey=id"))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("Authorization", "Bearer " + MeiliKeys.derive(MASTER, MeiliKeys.INDEXING.uid())))
                .andExpect(content().json("[{\"id\":\"post-1\"}]"))
                .andRespond(withStatus(HttpStatus.ACCEPTED)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"taskUid\":42,\"status\":\"enqueued\"}"));
        server.expect(requestTo(URL + "/keys/" + MeiliKeys.SEARCH.uid()))
                .andExpect(method(HttpMethod.GET))
                .andExpect(header("Authorization", "Bearer " + MASTER))
                .andRespond(withStatus(HttpStatus.NOT_FOUND)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"code\":\"api_key_not_found\"}"));

        assertThat(client.multiSearch(List.of(Map.of("indexUid", "content_v1", "q", "x"))))
                .hasSize(1);
        assertThat(client.addOrReplaceDocuments("content_v1", List.of(Map.of("id", "post-1"))))
                .isEqualTo(42);
        assertThat(client.getKey(MeiliKeys.SEARCH.uid())).isEmpty();
        server.verify();
    }

    @Test
    void http_error_becomes_a_code_without_copying_the_error_body() {
        String body = "{\"message\":\"Attribute `" + SECRET + "` is not filterable\",\"code\":\"%s\"}";
        List<Object[]> cases = List.of(
                new Object[] {
                    HttpStatus.SERVICE_UNAVAILABLE, "too_many_search_requests", MeiliException.Code.UNAVAILABLE
                },
                new Object[] {HttpStatus.INTERNAL_SERVER_ERROR, "internal", MeiliException.Code.SERVER_ERROR},
                new Object[] {HttpStatus.NOT_FOUND, "index_not_found", MeiliException.Code.INDEX_NOT_FOUND},
                new Object[] {HttpStatus.FORBIDDEN, "invalid_api_key", MeiliException.Code.INVALID_API_KEY},
                new Object[] {
                    HttpStatus.UNAUTHORIZED, "missing_authorization_header", MeiliException.Code.INVALID_API_KEY
                },
                new Object[] {HttpStatus.BAD_REQUEST, "invalid_search_filter", MeiliException.Code.INVALID_SEARCH_FILTER
                },
                new Object[] {HttpStatus.BAD_REQUEST, "invalid_search_q", MeiliException.Code.REQUEST_REJECTED});
        for (Object[] c : cases) {
            server.expect(requestTo(URL + "/multi-search"))
                    .andRespond(withStatus((HttpStatus) c[0])
                            .contentType(MediaType.APPLICATION_JSON)
                            .body(body.formatted(c[1])));
        }
        for (Object[] c : cases) {
            assertThatThrownBy(() -> client.multiSearch(List.of(Map.of("indexUid", "content_v1", "q", SECRET))))
                    .isInstanceOfSatisfying(MeiliException.class, e -> {
                        assertThat(e.code()).as(String.valueOf(c[1])).isEqualTo(c[2]);
                        assertThat(e.getMessage()).doesNotContain(SECRET, "filterable");
                        assertThat(e.getCause()).isNull();
                    });
        }
        server.verify();
        assertNoSecretLogged();
    }

    @Test
    void lost_connection_timeout_broken_body_and_unconfigured_are_all_engine_errors() {
        server.expect(requestTo(URL + "/multi-search")).andRespond(withException(new ConnectException("refused")));
        server.expect(requestTo(URL + "/multi-search"))
                .andRespond(withException(new HttpTimeoutException("request timed out")));
        server.expect(requestTo(URL + "/multi-search")).andRespond(withSuccess("<html>" + SECRET, MediaType.TEXT_HTML));
        server.expect(requestTo(URL + "/multi-search"))
                .andRespond(withSuccess("{\"results\":[]}", MediaType.APPLICATION_JSON));
        List<Map<String, Object>> queries = List.of(Map.of("indexUid", "content_v1", "q", SECRET));

        assertThat(codeOf(() -> client.multiSearch(queries))).isEqualTo(MeiliException.Code.CONNECTION_FAILED);
        assertThat(codeOf(() -> client.multiSearch(queries))).isEqualTo(MeiliException.Code.TIMEOUT);
        assertThat(codeOf(() -> client.multiSearch(queries))).isEqualTo(MeiliException.Code.INVALID_RESPONSE);
        assertThat(codeOf(() -> client.multiSearch(queries))).isEqualTo(MeiliException.Code.INVALID_RESPONSE);
        server.verify();

        MeiliHttpClient unconfigured =
                new MeiliHttpClient(config("", ""), objectMapper, RestClient.builder(), duration -> {}, () -> 0);
        assertThat(codeOf(() -> unconfigured.multiSearch(queries))).isEqualTo(MeiliException.Code.NOT_CONFIGURED);
        assertThat(unconfigured.healthy()).isFalse();
        assertNoSecretLogged();
    }

    @Test
    void really_closed_port_is_connection_failed_within_the_timeout() throws IOException {
        int port;
        try (ServerSocket socket = new ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        SearchProperties.Meili dead = config("http://127.0.0.1:" + port, MASTER);
        MeiliHttpClient real =
                new MeiliHttpClient(new SearchProperties(SearchProperties.Engine.MEILISEARCH, dead), objectMapper);
        long started = System.nanoTime();
        assertThat(codeOf(() -> real.multiSearch(List.of(Map.of("indexUid", "content_v1", "q", SECRET)))))
                .isIn(MeiliException.Code.CONNECTION_FAILED, MeiliException.Code.TIMEOUT);
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
        assertThat(real.healthy()).isFalse();
    }

    @Test
    void log_is_at_most_one_line_per_minute_with_only_the_code() {
        for (int i = 0; i < 3; i++) {
            server.expect(requestTo(URL + "/multi-search"))
                    .andRespond(withStatus(HttpStatus.BAD_GATEWAY)
                            .body("{\"message\":\"" + SECRET + "\",\"code\":\"bad\"}"));
        }
        for (int i = 0; i < 3; i++) {
            codeOf(() -> client.multiSearch(List.of(Map.of("indexUid", "content_v1", "q", SECRET))));
        }
        assertThat(logs.list).hasSize(1);
        assertThat(logs.list.getFirst().getFormattedMessage()).contains("code=SERVER_ERROR");
        assertNoSecretLogged();
    }

    @Test
    void malformed_index_uid_and_key_uid_are_rejected_before_calling() {
        assertThatThrownBy(() -> client.createIndex("../keys")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> client.deleteIndex("content v1")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> client.getKey("../indexes")).isInstanceOf(IllegalArgumentException.class);
        server.verify();
    }

    private static MeiliException.Code codeOf(Runnable call) {
        try {
            call.run();
        } catch (MeiliException e) {
            return e.code();
        }
        throw new AssertionError("MeiliException not thrown");
    }

    private void assertNoSecretLogged() {
        for (ILoggingEvent event : logs.list) {
            assertThat(event.getFormattedMessage()).doesNotContain(SECRET, MASTER);
            assertThat(event.getThrowableProxy()).isNull();
        }
    }
}
