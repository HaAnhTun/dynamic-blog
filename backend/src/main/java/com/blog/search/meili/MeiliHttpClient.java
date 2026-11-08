package com.blog.search.meili;

import com.blog.search.config.SearchProperties;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * HTTP client for Meilisearch: a plain RestClient, no SDK, built like GithubHttpClients (JDK HttpClient, HTTP/1.1, no
 * redirect following, hard timeouts). Two RestClients on one HttpClient: search waits {@code search-timeout} (800 ms),
 * everything else waits {@code admin-timeout}.
 *
 * One key per job: search uses the search key, writes and task reads use the indexing key, only {@code /keys} uses the
 * master key. A key travels only in the {@code Authorization} header, never in a log or an error message.
 *
 * Every failure becomes a {@link MeiliException} with a code; the Meilisearch error body (which echoes the filter and
 * the query) goes nowhere. Log: the code and the class name, at most one line per minute.
 */
@Component
public class MeiliHttpClient {

    private static final Logger log = LoggerFactory.getLogger(MeiliHttpClient.class);

    private static final Pattern INDEX_UID = Pattern.compile("[A-Za-z0-9_-]{1,400}");
    private static final Pattern KEY_UID =
            Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern VERSION = Pattern.compile("[0-9A-Za-z.+-]{1,64}");
    static final Duration FIRST_POLL = Duration.ofMillis(25);
    static final Duration MAX_POLL = Duration.ofSeconds(1);

    /** Sleeps between two task polls; tests replace it with a fake clock. */
    @FunctionalInterface
    interface Sleeper {
        void sleep(Duration duration) throws InterruptedException;
    }

    private final boolean configured;
    private final ObjectMapper objectMapper;
    private final RestClient searchClient;
    private final RestClient adminClient;
    private final String masterKey;
    private final String searchKey;
    private final String indexingKey;
    private final Sleeper sleeper;
    private final LongSupplier nanoClock;
    private final Throttle failureLog = new Throttle(Duration.ofMinutes(1));

    @Autowired
    public MeiliHttpClient(SearchProperties properties, ObjectMapper objectMapper) {
        this(
                properties.meili(),
                objectMapper,
                builders(properties.meili()),
                duration -> Thread.sleep(duration),
                System::nanoTime);
    }

    /** Test: one builder for both RestClients (MockRestServiceServer attaches to it), a fake clock and a fake sleep. */
    MeiliHttpClient(
            SearchProperties.Meili config,
            ObjectMapper objectMapper,
            RestClient.Builder builder,
            Sleeper sleeper,
            LongSupplier nanoClock) {
        this(config, objectMapper, new RestClient.Builder[] {builder, builder}, sleeper, nanoClock);
    }

    private MeiliHttpClient(
            SearchProperties.Meili config,
            ObjectMapper objectMapper,
            RestClient.Builder[] builders,
            Sleeper sleeper,
            LongSupplier nanoClock) {
        this.configured = config.configured();
        this.objectMapper = objectMapper;
        if (configured) {
            builders[0].baseUrl(config.url());
            builders[1].baseUrl(config.url());
        }
        this.searchClient = builders[0].build();
        this.adminClient = builders[1].build();
        this.masterKey = config.masterKey();
        this.searchKey = configured ? MeiliKeys.derive(masterKey, MeiliKeys.SEARCH.uid()) : "";
        this.indexingKey = configured ? MeiliKeys.derive(masterKey, MeiliKeys.INDEXING.uid()) : "";
        this.sleeper = sleeper;
        this.nanoClock = nanoClock;
    }

    private static RestClient.Builder[] builders(SearchProperties.Meili config) {
        HttpClient http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(config.connectTimeout())
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        JdkClientHttpRequestFactory search = new JdkClientHttpRequestFactory(http);
        search.setReadTimeout(config.searchTimeout());
        JdkClientHttpRequestFactory admin = new JdkClientHttpRequestFactory(http);
        admin.setReadTimeout(config.adminTimeout());
        return new RestClient.Builder[] {
            RestClient.builder().requestFactory(search), RestClient.builder().requestFactory(admin)
        };
    }

    // ------------------------------------------------------------------------------------------------ search

    /**
     * {@code POST /multi-search} with the search key; each element of {@code queries} carries its own {@code indexUid}.
     *
     * @return the {@code results} array, in the same order as {@code queries}
     */
    public JsonNode multiSearch(List<Map<String, Object>> queries) {
        JsonNode results = expectOk(
                        send(
                                searchClient,
                                HttpMethod.POST,
                                searchKey,
                                Map.of("queries", queries),
                                "multi-search",
                                "/multi-search"),
                        "multi-search")
                .path("results");
        if (!results.isArray() || results.size() != queries.size()) {
            throw failed(new MeiliException(MeiliException.Code.INVALID_RESPONSE), "multi-search", null);
        }
        return results;
    }

    // ------------------------------------------------------------------------------------------------ index

    /** {@code GET /health}, no key needed: the process is alive, which says nothing about the index or the keys. */
    public boolean healthy() {
        try {
            return "available"
                    .equals(expectOk(send(adminClient, HttpMethod.GET, null, null, "health", "/health"), "health")
                            .path("status")
                            .asString(""));
        } catch (MeiliException e) {
            return false;
        }
    }

    public boolean indexExists(String indexUid) {
        Reply reply =
                send(adminClient, HttpMethod.GET, indexingKey, null, "indexes.get", "/indexes/{uid}", index(indexUid));
        if (reply.status() == 404) {
            return false;
        }
        expectOk(reply, "indexes.get");
        return true;
    }

    /** Creates an index with primary key {@code id} (do not let Meilisearch guess). @return the task uid */
    public long createIndex(String indexUid) {
        return taskUid(
                send(
                        adminClient,
                        HttpMethod.POST,
                        indexingKey,
                        Map.of("uid", index(indexUid), "primaryKey", "id"),
                        "indexes.create",
                        "/indexes"),
                "indexes.create");
    }

    public long deleteIndex(String indexUid) {
        return taskUid(
                send(
                        adminClient,
                        HttpMethod.DELETE,
                        indexingKey,
                        null,
                        "indexes.delete",
                        "/indexes/{uid}",
                        index(indexUid)),
                "indexes.delete");
    }

    public long updateSettings(String indexUid, Map<String, Object> settings) {
        return taskUid(
                send(
                        adminClient,
                        HttpMethod.PATCH,
                        indexingKey,
                        settings,
                        "settings.update",
                        "/indexes/{uid}/settings",
                        index(indexUid)),
                "settings.update");
    }

    /** Adds or fully replaces documents with the same id. @return the task uid */
    public long addOrReplaceDocuments(String indexUid, List<?> documents) {
        return taskUid(
                send(
                        adminClient,
                        HttpMethod.POST,
                        indexingKey,
                        documents,
                        "documents.add",
                        "/indexes/{uid}/documents?primaryKey=id",
                        index(indexUid)),
                "documents.add");
    }

    public long deleteDocuments(String indexUid, Collection<String> ids) {
        return taskUid(
                send(
                        adminClient,
                        HttpMethod.POST,
                        indexingKey,
                        List.copyOf(ids),
                        "documents.delete",
                        "/indexes/{uid}/documents/delete-batch",
                        index(indexUid)),
                "documents.delete");
    }

    public long numberOfDocuments(String indexUid) {
        JsonNode stats = expectOk(
                send(
                        adminClient,
                        HttpMethod.GET,
                        indexingKey,
                        null,
                        "stats.get",
                        "/indexes/{uid}/stats",
                        index(indexUid)),
                "stats.get");
        if (!stats.path("numberOfDocuments").isNumber()) {
            throw failed(new MeiliException(MeiliException.Code.INVALID_RESPONSE), "stats.get", null);
        }
        return stats.path("numberOfDocuments").asLong();
    }

    /** Swaps two indexes (atomically). This is a global task: only a key with indexes {@code ["*"]} sees it. */
    public long swapIndexes(String first, String second) {
        return taskUid(
                send(
                        adminClient,
                        HttpMethod.POST,
                        indexingKey,
                        List.of(Map.of("indexes", List.of(index(first), index(second)))),
                        "indexes.swap",
                        "/swap-indexes"),
                "indexes.swap");
    }

    /** Renames {@code from} to {@code to}, when {@code to} does not exist: a swap with {@code rename: true}, also a global task. */
    public long renameIndex(String from, String to) {
        return taskUid(
                send(
                        adminClient,
                        HttpMethod.POST,
                        indexingKey,
                        List.of(Map.of("indexes", List.of(index(from), index(to)), "rename", true)),
                        "indexes.swap",
                        "/swap-indexes"),
                "indexes.swap");
    }

    /**
     * One page of documents ({@code POST /indexes/{uid}/documents/fetch}) with the indexing key, only the requested fields,
     * in the engine's internal order.
     *
     * @return the {@code results} of the page, and {@code total}: the document count of the whole index
     */
    public DocumentPage fetchDocuments(String indexUid, long offset, int limit, List<String> fields) {
        JsonNode page = expectOk(
                send(
                        adminClient,
                        HttpMethod.POST,
                        indexingKey,
                        Map.of("offset", offset, "limit", limit, "fields", fields),
                        "documents.get",
                        "/indexes/{uid}/documents/fetch",
                        index(indexUid)),
                "documents.get");
        if (!page.path("results").isArray() || !page.path("total").isIntegralNumber()) {
            throw failed(new MeiliException(MeiliException.Code.INVALID_RESPONSE), "documents.get", null);
        }
        List<JsonNode> results = new ArrayList<>();
        page.path("results").forEach(results::add);
        return new DocumentPage(List.copyOf(results), page.path("total").asLong());
    }

    public record DocumentPage(List<JsonNode> results, long total) {}

    /** {@code GET /version} with the indexing key: the engine version, for example {@code 1.54.3}. */
    public String version() {
        JsonNode version = expectOk(
                        send(adminClient, HttpMethod.GET, indexingKey, null, "version", "/version"), "version")
                .path("pkgVersion");
        if (!version.isString() || !VERSION.matcher(version.asString()).matches()) {
            throw failed(new MeiliException(MeiliException.Code.INVALID_RESPONSE), "version", null);
        }
        return version.asString();
    }

    // ------------------------------------------------------------------------------------------------ task

    public MeiliTask getTask(long taskUid) {
        JsonNode task = expectOk(
                send(adminClient, HttpMethod.GET, indexingKey, null, "tasks.get", "/tasks/{uid}", taskUid),
                "tasks.get");
        String status = task.path("status").asString("");
        if (status.isEmpty()) {
            throw failed(new MeiliException(MeiliException.Code.INVALID_RESPONSE), "tasks.get", null);
        }
        JsonNode error = task.path("error").path("code");
        return new MeiliTask(taskUid, status, error.isString() ? error.asString() : null);
    }

    /**
     * Polls the task until it finishes: the first time immediately, then waits 25 ms, doubling each time, at most 1 second,
     * within {@code timeout}.
     *
     * @throws MeiliException {@code TASK_FAILED} (with the task error code), {@code TASK_CANCELED}, {@code TASK_TIMEOUT}
     */
    public MeiliTask waitForTask(long taskUid, Duration timeout) {
        long deadline = nanoClock.getAsLong() + timeout.toNanos();
        Duration pause = FIRST_POLL;
        while (true) {
            MeiliTask task = getTask(taskUid);
            switch (task.status()) {
                case "succeeded" -> {
                    return task;
                }
                case "failed" ->
                    throw failed(
                            new MeiliException(MeiliException.Code.TASK_FAILED, task.errorCode()), "tasks.wait", null);
                case "canceled" ->
                    throw failed(new MeiliException(MeiliException.Code.TASK_CANCELED), "tasks.wait", null);
                default -> {
                    // enqueued, processing: keep waiting.
                }
            }
            long remaining = deadline - nanoClock.getAsLong();
            if (remaining <= 0) {
                throw failed(new MeiliException(MeiliException.Code.TASK_TIMEOUT), "tasks.wait", null);
            }
            try {
                sleeper.sleep(pause.toNanos() < remaining ? pause : Duration.ofNanos(remaining));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw failed(new MeiliException(MeiliException.Code.TASK_TIMEOUT), "tasks.wait", null);
            }
            pause = pause.multipliedBy(2).compareTo(MAX_POLL) > 0 ? MAX_POLL : pause.multipliedBy(2);
        }
    }

    // ------------------------------------------------------------------------------------------------ keys

    /** {@code GET /keys/{uid}} with the master key; empty when it does not exist. */
    public Optional<JsonNode> getKey(String uid) {
        Reply reply = send(adminClient, HttpMethod.GET, masterKey, null, "keys.get", "/keys/{uid}", keyUid(uid));
        if (reply.status() == 404) {
            return Optional.empty();
        }
        return Optional.of(expectOk(reply, "keys.get"));
    }

    /** {@code POST /keys} with the master key. */
    public JsonNode createKey(Map<String, Object> key) {
        return expectOk(send(adminClient, HttpMethod.POST, masterKey, key, "keys.create", "/keys"), "keys.create");
    }

    public void deleteKey(String uid) {
        expectOk(
                send(adminClient, HttpMethod.DELETE, masterKey, null, "keys.delete", "/keys/{uid}", keyUid(uid)),
                "keys.delete");
    }

    // ------------------------------------------------------------------------------------------------ internals

    private record Reply(int status, byte[] body) {}

    /** One call. Network errors and timeouts become {@link MeiliException}; any HTTP status is returned for the caller to judge. */
    private Reply send(
            RestClient client,
            HttpMethod method,
            String key,
            Object body,
            String operation,
            String uri,
            Object... variables) {
        if (!configured) {
            throw failed(new MeiliException(MeiliException.Code.NOT_CONFIGURED), operation, null);
        }
        try {
            RestClient.RequestBodySpec request =
                    client.method(method).uri(uri, variables).accept(MediaType.APPLICATION_JSON);
            if (key != null) {
                request.header(HttpHeaders.AUTHORIZATION, "Bearer " + key);
            }
            if (body != null) {
                request.contentType(MediaType.APPLICATION_JSON).body(objectMapper.writeValueAsBytes(body));
            }
            return request.exchange(
                    (req, response) -> new Reply(
                            response.getStatusCode().value(), response.getBody().readAllBytes()),
                    true);
        } catch (ResourceAccessException e) {
            throw failed(new MeiliException(ioCode(e)), operation, e.getCause() == null ? e : e.getCause());
        } catch (RestClientException | JacksonException e) {
            throw failed(new MeiliException(MeiliException.Code.INVALID_RESPONSE), operation, e);
        }
    }

    private JsonNode expectOk(Reply reply, String operation) {
        if (reply.status() < 200 || reply.status() >= 300) {
            throw failed(statusFailure(reply), operation, null);
        }
        try {
            return reply.body().length == 0 ? objectMapper.createObjectNode() : objectMapper.readTree(reply.body());
        } catch (JacksonException e) {
            throw failed(new MeiliException(MeiliException.Code.INVALID_RESPONSE), operation, e);
        }
    }

    /** A write returns 202 with a {@code taskUid}. */
    private long taskUid(Reply reply, String operation) {
        JsonNode task = expectOk(reply, operation).path("taskUid");
        if (!task.isIntegralNumber()) {
            throw failed(new MeiliException(MeiliException.Code.INVALID_RESPONSE), operation, null);
        }
        return task.asLong();
    }

    /** Reads only the {@code code} of the error body, never the {@code message}. */
    private MeiliException statusFailure(Reply reply) {
        String code = null;
        try {
            JsonNode node = reply.body().length == 0
                    ? null
                    : objectMapper.readTree(reply.body()).path("code");
            code = node != null && node.isString() ? node.asString() : null;
        } catch (JacksonException e) {
            // The body is not JSON (proxy, error page): only the HTTP status decides.
        }
        int status = reply.status();
        if (status == 503) {
            return new MeiliException(MeiliException.Code.UNAVAILABLE, code);
        }
        if (status >= 500) {
            return new MeiliException(MeiliException.Code.SERVER_ERROR, code);
        }
        if ("index_not_found".equals(code)) {
            return new MeiliException(MeiliException.Code.INDEX_NOT_FOUND, code);
        }
        if (status == 401 || status == 403) {
            return new MeiliException(MeiliException.Code.INVALID_API_KEY, code);
        }
        if ("invalid_search_filter".equals(code)) {
            return new MeiliException(MeiliException.Code.INVALID_SEARCH_FILTER, code);
        }
        return new MeiliException(MeiliException.Code.REQUEST_REJECTED, code);
    }

    private static MeiliException.Code ioCode(ResourceAccessException e) {
        for (Throwable cause = e; cause != null; cause = cause.getCause()) {
            if (cause instanceof HttpConnectTimeoutException || cause instanceof ConnectException) {
                return MeiliException.Code.CONNECTION_FAILED;
            }
            if (cause instanceof HttpTimeoutException || cause instanceof SocketTimeoutException) {
                return MeiliException.Code.TIMEOUT;
            }
        }
        return MeiliException.Code.CONNECTION_FAILED;
    }

    /** Logs one line (at most one per minute): the operation, the code, the Meilisearch code and the class name; no message, no error body. */
    private MeiliException failed(MeiliException failure, String operation, Throwable cause) {
        if (failureLog.tryAcquire()) {
            log.warn(
                    "meilisearch call failed operation={} code={} engineCode={} cause={}",
                    operation,
                    failure.code(),
                    failure.engineCode(),
                    cause == null ? null : cause.getClass().getSimpleName());
        }
        return failure;
    }

    private static String index(String uid) {
        if (uid == null || !INDEX_UID.matcher(uid).matches()) {
            throw new IllegalArgumentException("Invalid index uid");
        }
        return uid;
    }

    private static String keyUid(String uid) {
        if (uid == null || !KEY_UID.matcher(uid).matches()) {
            throw new IllegalArgumentException("Invalid key uid");
        }
        return uid;
    }
}
