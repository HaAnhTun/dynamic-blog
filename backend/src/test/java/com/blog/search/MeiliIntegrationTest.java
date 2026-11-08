package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.search.config.SearchProperties;
import com.blog.search.index.SearchIndexer;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.MeiliTestContainer;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Shared context of the Meilisearch ITs: {@code SEARCH_ENGINE=meilisearch} pointing at {@link MeiliTestContainer}, on
 * a database of its own (only the seeded admin at the start), so an index built from the DB holds only these classes'
 * data. The subclasses share one context (same configuration). Each test creates its data around a word only it has,
 * then rebuilds the index.
 *
 * Like NewsletterIT: it does not extend AbstractIntegrationTest (that class's {@code @ServiceConnection} would win
 * over the dedicated database), GitHub login is off, background schedules are off.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import(AuthTestSupport.class)
@TestPropertySource(
        properties = {
            "app.oauth.github.client-id=",
            "app.oauth.github.client-secret=",
            "app.oauth.github.redirect-uri=",
            "app.oauth.github.site-url=",
            "app.admin.github-id=",
            "app.security.refresh-token-cleanup-cron=-",
            "app.newsletter.worker-enabled=false",
            "app.search.worker-enabled=false",
            "app.search.reconcile-cron=-",
            "app.search.engine=meilisearch",
            "app.search.meili.index-name=" + MeiliIntegrationTest.INDEX
        })
abstract class MeiliIntegrationTest {

    static final String INDEX = "content_it_v1";

    @DynamicPropertySource
    static void meilisearchAndDatabase(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "meili_search_it");
        registry.add("app.search.meili.url", MeiliTestContainer::url);
        registry.add("app.search.meili.master-key", () -> MeiliTestContainer.MASTER_KEY);
    }

    @Autowired
    MockMvc mockMvc;

    @Autowired
    ObjectMapper objectMapper;

    @Autowired
    JdbcTemplate jdbcTemplate;

    @Autowired
    AuthTestSupport auth;

    @Autowired
    SearchIndexer indexer;

    String admin;

    @BeforeEach
    void signIn() {
        admin = auth.bearerForAdmin();
    }

    /** Rebuilds the test index from the current DB. */
    void reindex() {
        indexer.build(INDEX);
    }

    // ------------------------------------------------------------------------------------------------ engine

    private final HttpClient masterHttp = HttpClient.newHttpClient();

    /** {@code GET} with the master key, outside all backend code; 200 or it throws. */
    JsonNode masterGet(String path) throws Exception {
        HttpResponse<String> response = masterHttp.send(
                HttpRequest.newBuilder(URI.create(MeiliTestContainer.url() + path))
                        .header("Authorization", "Bearer " + MeiliTestContainer.MASTER_KEY)
                        .GET()
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return objectMapper.readTree(response.body());
    }

    /** A document of an index, read with the master key; null when absent. */
    JsonNode indexedDocument(String index, String id) throws Exception {
        HttpResponse<String> response = masterHttp.send(
                HttpRequest.newBuilder(URI.create(MeiliTestContainer.url() + "/indexes/" + index + "/documents/" + id))
                        .header("Authorization", "Bearer " + MeiliTestContainer.MASTER_KEY)
                        .GET()
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() == 404) {
            return null;
        }
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return objectMapper.readTree(response.body());
    }

    /**
     * Same configuration as this context but a different URL or index name: for hand-built beans (dead engine, other
     * index).
     */
    static SearchProperties meiliProperties(String url, String index) {
        return new SearchProperties(
                SearchProperties.Engine.MEILISEARCH,
                new SearchProperties.Meili(
                        url,
                        MeiliTestContainer.MASTER_KEY,
                        index,
                        Duration.ofMillis(300),
                        Duration.ofMillis(800),
                        Duration.ofSeconds(5)));
    }

    /** Bearer of a fresh ADMIN: the per-admin reindex rate limit is not used up by other classes. */
    String freshAdmin() {
        return auth.bearerFor(auth.createAccount("admin-" + uniqueWord() + "@blog.local", UserRole.ADMIN));
    }

    // ------------------------------------------------------------------------------------------------ search

    /** 12 random ASCII letters: a word only this test has. */
    static String uniqueWord() {
        return UUID.randomUUID()
                .toString()
                .replace("-", "")
                .substring(0, 12)
                .chars()
                .map(c -> 'a' + Character.digit(c, 16))
                .collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append)
                .toString();
    }

    static MockHttpServletRequestBuilder request(String... params) {
        MockHttpServletRequestBuilder request = get("/api/v1/search");
        for (int i = 0; i < params.length; i += 2) {
            request.param(params[i], params[i + 1]);
        }
        return request;
    }

    /** The {@code data} of a 200 search. */
    JsonNode search(String... params) throws Exception {
        return objectMapper
                .readTree(mockMvc.perform(request(params))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data");
    }

    static List<String> types(JsonNode data) {
        List<String> types = new ArrayList<>();
        data.path("groups").forEach(group -> types.add(group.path("type").asString()));
        return types;
    }

    static JsonNode groupOf(JsonNode data, String type) {
        for (JsonNode group : data.path("groups")) {
            if (group.path("type").asString().equals(type)) {
                return group;
            }
        }
        throw new AssertionError("No group " + type + ": " + data);
    }

    static List<JsonNode> items(JsonNode data, String type) {
        List<JsonNode> items = new ArrayList<>();
        groupOf(data, type).path("items").forEach(items::add);
        return items;
    }

    static String joined(JsonNode segments) {
        StringBuilder text = new StringBuilder();
        segments.forEach(segment -> text.append(segment.path("text").asString()));
        return text.toString();
    }

    static List<String> marked(JsonNode segments) {
        List<String> marked = new ArrayList<>();
        segments.forEach(segment -> {
            if (segment.path("match").asBoolean()) {
                marked.add(segment.path("text").asString());
            }
        });
        return marked;
    }

    // ------------------------------------------------------------------------------------------------ data

    record Taxon(UUID id, String slug) {}

    private Taxon taxon(String body) {
        JsonNode data = objectMapper.readTree(body).path("data");
        return new Taxon(
                UUID.fromString(data.path("id").asString()), data.path("slug").asString());
    }

    Taxon createCategory(String name, String description) throws Exception {
        Map<String, String> payload =
                description == null ? Map.of("name", name) : Map.of("name", name, "description", description);
        return taxon(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(payload)))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString());
    }

    Taxon createTag(String name) throws Exception {
        return taxon(mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("name", name))))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString());
    }

    Taxon insertSeries(String title, String description) {
        String slug = "series-" + uniqueWord();
        UUID id = jdbcTemplate.queryForObject(
                "INSERT INTO series (title, slug, description) VALUES (?, ?, ?) " + "RETURNING id",
                UUID.class,
                title,
                slug,
                description);
        return new Taxon(id, slug);
    }

    void putInSeries(UUID post, Taxon series, int position) {
        assertThat(jdbcTemplate.update(
                        "UPDATE posts SET series_id = ?, series_position = ? WHERE id = ?",
                        series.id(),
                        position,
                        post))
                .isEqualTo(1);
    }

    void setAuthor(UUID post, UUID author) {
        assertThat(jdbcTemplate.update("UPDATE posts SET author_id = ? WHERE id = ?", author, post))
                .isEqualTo(1);
    }

    void setLanguage(UUID post, String language) {
        assertThat(jdbcTemplate.update("UPDATE posts SET language = ? WHERE id = ?", language, post))
                .isEqualTo(1);
    }

    /** Puts the posts in one translation group (written by SQL: the column is read-only on the entity). */
    void groupTranslations(UUID first, UUID second) {
        UUID group = UUID.randomUUID();
        assertThat(jdbcTemplate.update(
                        "UPDATE posts SET translation_group_id = ? WHERE id IN (?, ?)", group, first, second))
                .isEqualTo(2);
    }

    void unpublish(UUID post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post + "/unpublish").header("Authorization", admin))
                .andExpect(status().isOk());
    }

    /**
     * Bilingual data around one marker word: a vi post with an en translation (same category, tag, series, two
     * authors), a vi-only and an en-only category, and an en post that is a draft or unpublished (so its category and
     * author exist but are not visible in en). Every name contains the marker.
     */
    record LanguageData(
            String marker,
            Taxon both,
            Taxon viOnly,
            Taxon enOnly,
            Taxon enDraft,
            Taxon enUnpublished,
            Taxon tag,
            Taxon series,
            UUID viMain,
            UUID enTranslation,
            UUID viOnlyPost,
            UUID enOnlyPost,
            User viAuthor,
            User enAuthor) {}

    LanguageData bilingualData() throws Exception {
        String marker = uniqueWord();
        Taxon both = createCategory("Both " + marker, null);
        Taxon viOnly = createCategory("Only vi " + marker, null);
        Taxon enOnly = createCategory("Only en " + marker, null);
        Taxon enDraft = createCategory("Draft en " + marker, null);
        Taxon enUnpublished = createCategory("Unpublished en " + marker, null);
        Taxon tag = createTag("Tag " + marker);
        Taxon series = insertSeries("Series " + marker, null);
        User viAuthor = auth.createAuthor("vi-" + marker + "@blog.local");
        User enAuthor = auth.createAuthor("en-" + marker + "@blog.local");
        User draftAuthor = auth.createAuthor("draft-" + marker + "@blog.local");

        UUID viMain = publish("Main vi " + marker, "body", null, both, tag);
        setAuthor(viMain, viAuthor.getId());
        putInSeries(viMain, series, 1);
        UUID enTranslation = publish("Main en " + marker, "body", null, both, tag);
        setLanguage(enTranslation, "en");
        setAuthor(enTranslation, enAuthor.getId());
        putInSeries(enTranslation, series, 2);
        groupTranslations(viMain, enTranslation);
        UUID viOnlyPost = publish("Alone vi " + marker, "body", null, viOnly);
        setAuthor(viOnlyPost, viAuthor.getId());
        UUID enOnlyPost = publish("Alone en " + marker, "body", null, enOnly);
        setLanguage(enOnlyPost, "en");
        setAuthor(enOnlyPost, enAuthor.getId());
        UUID draft = createPost("Draft en " + marker, "body", null, enDraft);
        setLanguage(draft, "en");
        setAuthor(draft, draftAuthor.getId());
        UUID unpublished = publish("Unpublished en " + marker, "body", null, enUnpublished);
        setLanguage(unpublished, "en");
        setAuthor(unpublished, draftAuthor.getId());
        unpublish(unpublished);
        return new LanguageData(
                marker,
                both,
                viOnly,
                enOnly,
                enDraft,
                enUnpublished,
                tag,
                series,
                viMain,
                enTranslation,
                viOnlyPost,
                enOnlyPost,
                viAuthor,
                enAuthor);
    }

    String slugOf(UUID post) {
        return jdbcTemplate.queryForObject("SELECT slug FROM posts WHERE id = ?", String.class, post);
    }

    UUID createPost(String title, String content, String excerpt, Taxon category, Taxon... tags) throws Exception {
        Map<String, Object> payload = new HashMap<>(Map.of(
                "title",
                title,
                "content",
                content,
                "categoryId",
                category.id().toString(),
                "tagIds",
                Arrays.stream(tags).map(tag -> tag.id().toString()).toList()));
        if (excerpt != null) {
            payload.put("excerpt", excerpt);
        }
        String body = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(payload)))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return UUID.fromString(
                objectMapper.readTree(body).path("data").path("id").asString());
    }

    UUID publish(String title, String content, String excerpt, Taxon category, Taxon... tags) throws Exception {
        UUID id = createPost(title, content, excerpt, category, tags);
        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
        return id;
    }
}
