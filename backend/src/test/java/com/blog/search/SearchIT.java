package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.security.SeedAdmin;
import com.blog.fixtures.vi.SearchVi;
import com.blog.search.service.StaticSearchContent;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * {@code GET /api/v1/search} on Postgres: checks parameters, groups and order, the shape of each row, the visibility
 * rules (drafts, withdrawn posts, suspended authors, readers), unaccented prefix matching of the in-place sources,
 * {@code type=post} with the same semantics as {@code /posts/search}, and {@code q} never reaching the log.
 *
 * The DB is shared by all test classes and never cleaned: each test searches for a word only it has, and checks only
 * its own part. The global 429 cap is in {@link SearchRateLimitIT} (own context, small limit).
 */
@AutoConfigureMockMvc
class SearchIT extends AbstractIntegrationTest {

    private static final Pattern UUID_LIKE =
            Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private StaticSearchContent staticContent;

    private String admin;

    @BeforeEach
    void signIn() {
        admin = auth.bearerForAdmin();
    }

    @Test
    void bad_parameters_are_400_with_fixed_message_and_blank_q_without_filters_gives_no_groups() throws Exception {
        mockMvc.perform(get("/api/v1/search"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.query").value(""))
                .andExpect(jsonPath("$.data.engine").value("postgres"))
                .andExpect(jsonPath("$.data.degraded").value(false))
                .andExpect(jsonPath("$.data.groups").isEmpty());
        assertThat(groups(search("q", "   ", "type", "post", "tag", " ", "category", "")))
                .isEmpty();

        String marker = uniqueWord();
        String emoji = new String(Character.toChars(0x1F600));
        for (String q : List.of("a".repeat(200), emoji.repeat(200))) {
            mockMvc.perform(get("/api/v1/search").param("q", q)).andExpect(status().isOk());
        }
        String[] tooMany = {
            "type", "post", "q", marker, "tag", "a", "tag", "b", "tag", "c", "tag", "d", "tag", "e", "tag", "f"
        };
        for (String[] params : List.of(
                new String[] {"q", marker + "a".repeat(200)},
                new String[] {"q", marker, "type", "bai-viet-" + marker},
                new String[] {"q", marker, "category", "cm-" + marker},
                new String[] {"q", marker, "type", "topic", "tag", "the-" + marker},
                new String[] {"q", marker, "type", "author", "series", "se-" + marker},
                tooMany,
                new String[] {"q", marker, "limit", "nhieu"})) {
            String body = mockMvc.perform(request(params))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"))
                    .andReturn()
                    .getResponse()
                    .getContentAsString();
            assertThat(body).as(String.join(" ", params)).doesNotContain(marker);
        }
    }

    @Test
    void groups_follow_contract_order_rows_carry_only_public_fields_and_title_match_ranks_first() throws Exception {
        String marker = uniqueWord();
        Taxon category = createCategory("Category " + marker, "Category description");
        Taxon tag = createTag("Tag " + marker);
        Taxon series = insertSeries("Series " + marker, "Series description");
        User author = auth.createAuthor(marker + "@blog.local");
        String title = "Post " + marker;
        UUID postId = publish(title, "noi dung", "  Excerpt with " + marker + "  ", category, tag);
        setAuthor(postId, author.getId());
        putInSeries(postId, series, 1);
        // A category matching only in its description, with more posts: still ranks after the category matching by
        // name.
        Taxon byDescription = createCategory("Description only " + uniqueWord(), "Mentions " + marker);
        publish("Post one " + uniqueWord(), "noi dung", null, byDescription);
        publish("Post two " + uniqueWord(), "noi dung", null, byDescription);

        JsonNode data = search("q", marker);
        assertThat(types(data)).containsExactly("post", "topic", "series", "author");

        JsonNode post = items(data, "post").get(0);
        assertThat(post.path("id").asString()).isEqualTo("post:" + slugOf(postId));
        assertThat(post.path("href").asString()).isEqualTo("/posts/" + slugOf(postId));
        assertThat(joined(post.path("title"))).isEqualTo(title);
        assertThat(marked(post.path("title"))).containsExactly(marker);
        assertThat(joined(post.path("description"))).isEqualTo("Excerpt with " + marker);
        JsonNode meta = post.path("meta");
        assertThat(meta.path("kind").asString()).isEqualTo("post");
        assertThat(meta.path("category").asString()).isEqualTo("Category " + marker);
        assertThat(meta.path("author").asString()).isEqualTo(author.getDisplayName());
        assertThat(meta.path("readingMinutes").asInt()).isEqualTo(1);
        assertThat(meta.path("publishedAt").isString()).isTrue();
        assertThat(texts(meta.path("tags"))).containsExactly("Tag " + marker);
        assertThat(post.path("post").path("slug").asString()).isEqualTo(slugOf(postId));
        assertThat(post.path("post").has("status")).isFalse();
        assertThat(groupOf(data, "post").has("page")).isFalse();

        List<JsonNode> topics = items(data, "topic");
        assertThat(topics)
                .extracting(item -> item.path("id").asString())
                .containsExactly(
                        "category:" + category.slug(), "tag:" + tag.slug(), "category:" + byDescription.slug());
        assertThat(topics.get(0).path("href").asString()).isEqualTo("/categories/" + category.slug());
        assertThat(topics.get(0).path("meta").path("kind").asString()).isEqualTo("category");
        assertThat(topics.get(0).path("meta").path("count").asInt()).isEqualTo(1);
        assertThat(topics.get(1).path("href").asString()).isEqualTo("/tags/" + tag.slug());
        assertThat(topics.get(1).path("meta").path("kind").asString()).isEqualTo("tag");
        assertThat(topics.get(1).has("description")).isFalse();
        assertThat(topics.get(2).path("meta").path("count").asInt()).isEqualTo(2);
        assertThat(marked(topics.get(2).path("description"))).containsExactly(marker);

        JsonNode seriesItem = items(data, "series").get(0);
        assertThat(seriesItem.path("id").asString()).isEqualTo("series:" + series.slug());
        assertThat(seriesItem.path("href").asString()).isEqualTo("/series/" + series.slug());
        assertThat(seriesItem.path("meta").path("parts").asInt()).isEqualTo(1);

        JsonNode authorItem = items(data, "author").get(0);
        String profile = "/u/" + author.getPublicSlug();
        assertThat(authorItem.path("id").asString()).isEqualTo("author:" + profile);
        assertThat(authorItem.path("href").asString()).isEqualTo(profile);
        assertThat(authorItem.path("meta").path("kind").asString()).isEqualTo("author");
        // Present even when null: the contract is string | null.
        assertThat(authorItem.path("meta").has("avatarUrl")).isTrue();
        assertThat(authorItem.path("meta").path("avatarUrl").isNull()).isTrue();

        for (JsonNode group : data.path("groups")) {
            for (JsonNode item : group.path("items")) {
                assertThat(UUID_LIKE.matcher(item.path("id").asString()).find())
                        .as(item.toString())
                        .isFalse();
                if (!"post".equals(group.path("type").asString())) {
                    assertThat(fieldNames(item))
                            .as(item.toString())
                            .doesNotContain("status", "email", "githubLogin", "role", "post");
                }
            }
        }

        // One tab: same rows, its own limit.
        assertThat(types(search("q", marker, "type", "topic"))).containsExactly("topic");
        assertThat(items(search("q", marker, "type", "topic", "limit", "1"), "topic"))
                .hasSize(1);
        assertThat(groupOf(search("q", marker, "type", "topic", "limit", "1"), "topic")
                        .path("total")
                        .asInt())
                .isEqualTo(3);
    }

    @Test
    void drafts_withdrawn_posts_readers_and_suspended_authors_never_show() throws Exception {
        String marker = uniqueWord();
        Taxon draftOnly = createCategory("Draft only " + marker, null);
        Taxon draftTag = createTag("Draft tag " + marker);
        Taxon draftSeries = insertSeries("Draft series " + marker, null);
        putInSeries(createPost("Draft " + marker, "noi dung " + marker, null, draftOnly, draftTag), draftSeries, 1);
        UUID withdrawn = publish("Withdrawn " + marker, "noi dung", null, draftOnly, draftTag);
        mockMvc.perform(post("/api/v1/admin/posts/" + withdrawn + "/unpublish").header("Authorization", admin))
                .andExpect(status().isOk());
        // A reader whose name matches but who has no published post.
        auth.createReader(auth.nextGithubId(), marker);

        assertThat(groups(search("q", marker))).isEmpty();
        for (String type : List.of("post", "topic", "series", "author")) {
            assertThat(groups(search("q", marker, "type", type))).as(type).isEmpty();
        }

        // An author (USER role after being demoted) with a published post: shown, until suspended.
        String locked = uniqueWord();
        User writer = auth.createReader(auth.nextGithubId(), locked);
        Taxon category = createCategory("Section " + locked, null);
        setAuthor(publish("Post of " + locked, "noi dung", null, category), writer.getId());
        assertThat(types(search("q", locked))).containsExactly("post", "topic", "author");
        assertThat(types(search("q", "", "type", "post", "category", category.slug())))
                .containsExactly("post");

        auth.setStatus(writer.getId(), UserStatus.SUSPENDED);
        // The category remains (counted like /topics and the category page, where the post is still listed); not the
        // post or person.
        assertThat(types(search("q", locked))).containsExactly("topic");
        assertThat(groups(search("q", "", "type", "post", "category", category.slug())))
                .isEmpty();
        assertThat(groups(search("q", locked, "type", "author"))).isEmpty();

        auth.setStatus(writer.getId(), UserStatus.ACTIVE);
        assertThat(types(search("q", locked))).containsExactly("post", "topic", "author");
    }

    @Test
    void site_owner_maps_to_about_and_in_place_sources_match_unaccented_prefix() throws Exception {
        String marker = uniqueWord();
        Taxon architecture = createCategory(SearchVi.ARCHITECTURE_PREFIX + marker, null);
        publish(SearchVi.ARCHITECTURE_POST_PREFIX + marker, "noi dung", null, architecture);

        JsonNode topic = items(search("q", "kien tr " + marker, "type", "topic"), "topic")
                .get(0);
        assertThat(topic.path("id").asString()).isEqualTo("category:" + architecture.slug());
        assertThat(marked(topic.path("title"))).containsExactly(SearchVi.ARCHITECTURE_FIRST_WORD, "tr", marker);
        // Posts match whole words: "kien tr" returns none of this test's posts.
        assertThat(groups(search("q", "kien tr " + marker, "type", "post"))).isEmpty();

        String owner = staticContent.owner().name();
        String ownerSlug =
                jdbcTemplate.queryForObject("SELECT public_slug FROM users WHERE id = ?", String.class, SeedAdmin.ID);
        List<JsonNode> authors = items(search("q", owner, "type", "author"), "author");
        assertThat(authors).anySatisfy(item -> {
            assertThat(item.path("id").asString()).isEqualTo("author:/about");
            assertThat(item.path("href").asString()).isEqualTo("/about");
            assertThat(joined(item.path("title"))).isEqualTo(owner);
        });
        assertThat(authors).noneMatch(item -> item.path("href").asString().equals("/u/" + ownerSlug));

        StaticSearchContent.CaseStudy study = staticContent.caseStudies().getFirst();
        JsonNode studies = search("q", study.title(), "type", "case-study");
        assertThat(items(studies, "case-study")).anySatisfy(item -> {
            assertThat(item.path("id").asString()).isEqualTo("case-study:" + study.slug());
            assertThat(item.path("href").asString()).isEqualTo(study.href());
            assertThat(joined(item.path("description"))).isEqualTo(study.summary());
        });
        StaticSearchContent.Page page = staticContent.pages().getFirst();
        assertThat(items(search("q", page.title(), "type", "page"), "page"))
                .anySatisfy(item -> assertThat(item.path("id").asString()).isEqualTo("page:" + page.href()));
        assertThat(types(search("q", study.title()))).contains("case-study");
    }

    @Test
    void type_post_with_filters_and_pagination_gives_same_result_as_posts_search() throws Exception {
        String marker = uniqueWord();
        Taxon category = createCategory("Filter " + marker, null);
        Taxon a = createTag("Tag a " + marker);
        Taxon b = createTag("Tag b " + marker);
        for (int i = 1; i <= 3; i++) {
            publish("Filter " + marker + " number " + i, "noi dung", null, category, a, b);
        }
        publish("Only tag a " + marker, "noi dung", null, category, a);
        publish("Outside section " + marker, "noi dung", null, createCategory("Other " + marker, null), a, b);

        for (String q : List.of(marker, "")) {
            for (int page = 0; page <= 2; page++) {
                String[] params = {
                    "q",
                    q,
                    "category",
                    category.slug(),
                    "tag",
                    a.slug(),
                    "tag",
                    b.slug(),
                    "page",
                    String.valueOf(page),
                    "size",
                    "2"
                };
                JsonNode legacy = objectMapper.readTree(mockMvc.perform(request("/api/v1/posts/search", params))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString());
                JsonNode group = groupOf(search(withType(params)), "post");
                assertThat(group.path("total").asInt())
                        .isEqualTo(3)
                        .isEqualTo(
                                legacy.path("pagination").path("totalElements").asInt());
                assertThat(group.path("page").asInt()).isEqualTo(page);
                assertThat(group.path("totalPages").asInt())
                        .isEqualTo(legacy.path("pagination").path("totalPages").asInt())
                        .isEqualTo(2);
                List<String> slugs = new ArrayList<>();
                group.path("items")
                        .forEach(
                                item -> slugs.add(item.path("post").path("slug").asString()));
                List<String> expected = new ArrayList<>();
                legacy.path("data")
                        .forEach(item -> expected.add(item.path("slug").asString()));
                assertThat(slugs).as("q=%s page=%d", q, page).isEqualTo(expected);
                if (q.isEmpty()) {
                    group.path("items")
                            .forEach(item ->
                                    assertThat(marked(item.path("title"))).isEmpty());
                }
            }
        }
        // Malformed slug: no posts, no groups.
        assertThat(groups(search(
                        "type", "post", "q", marker, "category", category.slug().toUpperCase())))
                .isEmpty();
        // Page size clamped to 50.
        assertThat(groupOf(search("type", "post", "q", marker, "size", "500"), "post")
                        .path("totalPages")
                        .asInt())
                .isEqualTo(1);
    }

    @Test
    void lang_narrows_posts_topics_and_series_to_that_language_with_localized_names_and_per_language_counts()
            throws Exception {
        String marker = uniqueWord();
        Taxon category = createCategory("Category " + marker, null);
        Taxon tag = createTag("Tag " + marker);
        Taxon series = insertSeries("Series " + marker, null);
        translate("categories", category.id(), "English category " + marker);
        translate("tags", tag.id(), "English tag " + marker);
        translate("series", series.id(), "English series " + marker);
        UUID viPost = publish("Post vi " + marker, "noi dung", null, category, tag);
        UUID enPost = publish("Post en " + marker, "noi dung", null, category, tag);
        setLanguage(enPost, "en");
        putInSeries(viPost, series, 1);
        putInSeries(enPost, series, 2);

        JsonNode english = search("q", marker, "lang", "en");
        assertThat(items(english, "post"))
                .extracting(item -> item.path("id").asString())
                .containsExactly("post:" + slugOf(enPost));
        assertThat(items(english, "topic"))
                .extracting(item -> joined(item.path("title")))
                .containsExactlyInAnyOrder("English category " + marker, "English tag " + marker);
        for (JsonNode topic : items(english, "topic")) {
            assertThat(topic.path("meta").path("count").asInt()).isEqualTo(1);
        }
        JsonNode englishSeries = items(english, "series").get(0);
        assertThat(joined(englishSeries.path("title"))).isEqualTo("English series " + marker);
        assertThat(englishSeries.path("meta").path("parts").asInt()).isEqualTo(1);

        // Vietnamese has no translation: the base names, counted over the Vietnamese post only.
        JsonNode vietnamese = search("q", marker, "lang", "vi");
        assertThat(items(vietnamese, "post"))
                .extracting(item -> item.path("id").asString())
                .containsExactly("post:" + slugOf(viPost));
        assertThat(items(vietnamese, "topic"))
                .extracting(item -> joined(item.path("title")))
                .containsExactlyInAnyOrder("Category " + marker, "Tag " + marker);
        assertThat(items(vietnamese, "series").get(0).path("meta").path("parts").asInt())
                .isEqualTo(1);

        // No lang: every language, base names, the whole counts.
        JsonNode every = search("q", marker);
        assertThat(items(every, "post")).hasSize(2);
        assertThat(items(every, "topic").get(0).path("meta").path("count").asInt())
                .isEqualTo(2);
        assertThat(items(every, "series").get(0).path("meta").path("parts").asInt())
                .isEqualTo(2);
        // The translated name is what an English search matches.
        assertThat(items(search("q", "English", "lang", "en", "type", "topic"), "topic"))
                .isNotEmpty();
    }

    @Test
    void lang_shows_no_topic_series_or_author_that_has_no_published_post_in_that_language() throws Exception {
        String marker = uniqueWord();
        Taxon category = createCategory("Category " + marker, null);
        Taxon draftCategory = createCategory("Draft language category " + marker, null);
        Taxon series = insertSeries("Series " + marker, null);
        User author = auth.createAuthor(marker + "@blog.local");
        UUID viPost = publish("Post vi " + marker, "noi dung", null, category);
        setAuthor(viPost, author.getId());
        putInSeries(viPost, series, 1);
        // An English draft, never published: it must not make anything visible in English.
        UUID enDraft = createPost("Draft en " + marker, "noi dung", null, draftCategory);
        setLanguage(enDraft, "en");

        JsonNode english = search("q", marker, "lang", "en");
        assertThat(types(english)).doesNotContain("topic", "series", "author", "post");
        JsonNode vietnamese = search("q", marker, "lang", "vi");
        assertThat(types(vietnamese)).containsExactly("post", "topic", "series", "author");
        assertThat(items(vietnamese, "topic"))
                .extracting(item -> item.path("id").asString())
                .containsExactly("category:" + category.slug());
        // Publishing the English post makes the author and its category appear in English, nothing else.
        mockMvc.perform(post("/api/v1/admin/posts/" + enDraft + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
        JsonNode published = search("q", marker, "lang", "en");
        assertThat(items(published, "topic"))
                .extracting(item -> item.path("id").asString())
                .containsExactly("category:" + draftCategory.slug());
        assertThat(types(published)).doesNotContain("series");
    }

    @Test
    void lang_filters_the_post_tab_with_filters_and_rejects_an_unknown_language() throws Exception {
        String marker = uniqueWord();
        Taxon category = createCategory("Category " + marker, null);
        UUID viPost = publish("Post vi " + marker, "noi dung", null, category);
        UUID enPost = publish("Post en " + marker, "noi dung", null, category);
        setLanguage(enPost, "en");

        assertThat(items(search("q", marker, "type", "post", "category", category.slug(), "lang", "en"), "post"))
                .extracting(item -> item.path("id").asString())
                .containsExactly("post:" + slugOf(enPost));
        assertThat(items(search("q", marker, "type", "post", "category", category.slug()), "post"))
                .hasSize(2);
        // Filters only, no text: still narrowed.
        assertThat(items(search("type", "post", "category", category.slug(), "lang", "vi"), "post"))
                .extracting(item -> item.path("id").asString())
                .containsExactly("post:" + slugOf(viPost));
        // Static pages stay language-agnostic.
        StaticSearchContent.Page page = staticContent.pages().getFirst();
        assertThat(types(search("q", page.title(), "type", "page", "lang", "en")))
                .containsExactly("page");

        mockMvc.perform(request(new String[] {"q", marker, "lang", "fr"}))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void q_never_reaches_the_log_even_on_400() throws Exception {
        String marker = uniqueWord();
        publish("Log post " + marker, "noi dung", null, createCategory("Log " + marker, null));
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        root.addAppender(logs);
        // The 400 answers are logged at DEBUG since issue 089 (anonymous traffic can cause them without limit): the
        // application
        // loggers go to DEBUG here, so the lines are captured and checked as before, DEBUG ones included.
        Logger application = (Logger) LoggerFactory.getLogger("com.blog");
        Level previousLevel = application.getLevel();
        application.setLevel(Level.DEBUG);
        // No words at all: Postgres sends a NOTICE echoing the query, which must not reach the log.
        String punctuation = "?!#%&~?!";
        try {
            search("q", marker);
            search("q", punctuation);
            search("q", marker, "type", "post", "tag", marker);
            mockMvc.perform(request(new String[] {"q", marker + "a".repeat(200)}))
                    .andExpect(status().isBadRequest());
            mockMvc.perform(request(new String[] {"q", marker, "type", marker})).andExpect(status().isBadRequest());
            mockMvc.perform(request(new String[] {"q", marker, "tag", marker})).andExpect(status().isBadRequest());
        } finally {
            application.setLevel(previousLevel);
            root.detachAppender(logs);
        }
        assertThat(logs.list).isNotEmpty();
        for (ILoggingEvent event : logs.list) {
            assertThat(event.getFormattedMessage()).doesNotContain(marker, punctuation);
            for (IThrowableProxy thrown = event.getThrowableProxy(); thrown != null; thrown = thrown.getCause()) {
                assertThat(String.valueOf(thrown.getMessage())).doesNotContain(marker, punctuation);
            }
        }
    }

    // ---------------------------------------------------------------- helpers

    /** 12 random ASCII letters, as in PostSearchAndFeaturedIT: a word only this test has. */
    private static String uniqueWord() {
        return UUID.randomUUID()
                .toString()
                .replace("-", "")
                .substring(0, 12)
                .chars()
                .map(c -> 'a' + Character.digit(c, 16))
                .collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append)
                .toString();
    }

    /** {@code params} are name, value pairs; a repeated name becomes a repeated parameter. */
    private static MockHttpServletRequestBuilder request(String path, String... params) {
        MockHttpServletRequestBuilder request = get(path);
        for (int i = 0; i < params.length; i += 2) {
            request.param(params[i], params[i + 1]);
        }
        return request;
    }

    private static MockHttpServletRequestBuilder request(String[] params) {
        return request("/api/v1/search", params);
    }

    private static String[] withType(String[] params) {
        List<String> all = new ArrayList<>(List.of("type", "post"));
        all.addAll(List.of(params));
        return all.toArray(String[]::new);
    }

    /** The {@code data} of a 200 search. */
    private JsonNode search(String... params) throws Exception {
        return objectMapper
                .readTree(mockMvc.perform(request(params))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data");
    }

    private static JsonNode groups(JsonNode data) {
        assertThat(data.path("groups").isArray()).as(data.toString()).isTrue();
        return data.path("groups");
    }

    private static List<String> types(JsonNode data) {
        List<String> types = new ArrayList<>();
        data.path("groups").forEach(group -> types.add(group.path("type").asString()));
        return types;
    }

    private static JsonNode groupOf(JsonNode data, String type) {
        for (JsonNode group : data.path("groups")) {
            if (group.path("type").asString().equals(type)) {
                return group;
            }
        }
        throw new AssertionError("No group " + type + ": " + data);
    }

    private static List<JsonNode> items(JsonNode data, String type) {
        List<JsonNode> items = new ArrayList<>();
        groupOf(data, type).path("items").forEach(items::add);
        return items;
    }

    private static String joined(JsonNode segments) {
        StringBuilder text = new StringBuilder();
        segments.forEach(segment -> text.append(segment.path("text").asString()));
        return text.toString();
    }

    private static List<String> marked(JsonNode segments) {
        List<String> marked = new ArrayList<>();
        segments.forEach(segment -> {
            if (segment.path("match").asBoolean()) {
                marked.add(segment.path("text").asString());
            }
        });
        return marked;
    }

    private static List<String> texts(JsonNode array) {
        List<String> texts = new ArrayList<>();
        array.forEach(node -> texts.add(node.asString()));
        return texts;
    }

    /** Names of every field at every level of a row. */
    private static List<String> fieldNames(JsonNode node) {
        List<String> names = new ArrayList<>();
        if (node.isObject()) {
            node.properties().forEach(entry -> {
                names.add(entry.getKey());
                names.addAll(fieldNames(entry.getValue()));
            });
        } else if (node.isArray()) {
            node.forEach(child -> names.addAll(fieldNames(child)));
        }
        return names;
    }

    private record Taxon(UUID id, String slug) {}

    private Taxon taxon(String body) {
        JsonNode data = objectMapper.readTree(body).path("data");
        return new Taxon(
                UUID.fromString(data.path("id").asString()), data.path("slug").asString());
    }

    private Taxon createCategory(String name, String description) throws Exception {
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

    private Taxon createTag(String name) throws Exception {
        return taxon(mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("name", name))))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString());
    }

    /** A series written straight with SQL, as in PostSearchAndFeaturedIT. */
    private Taxon insertSeries(String title, String description) {
        String slug = "series-" + uniqueWord();
        UUID id = jdbcTemplate.queryForObject(
                "INSERT INTO series (title, slug, description) VALUES (?, ?, ?) " + "RETURNING id",
                UUID.class,
                title,
                slug,
                description);
        return new Taxon(id, slug);
    }

    private void putInSeries(UUID post, Taxon series, int position) {
        assertThat(jdbcTemplate.update(
                        "UPDATE posts SET series_id = ?, series_position = ? WHERE id = ?",
                        series.id(),
                        position,
                        post))
                .isEqualTo(1);
    }

    /** An author other than the site owner: the admin creates and publishes, then the author is changed with SQL. */
    private void setAuthor(UUID post, UUID author) {
        assertThat(jdbcTemplate.update("UPDATE posts SET author_id = ? WHERE id = ?", author, post))
                .isEqualTo(1);
    }

    private void translate(String table, UUID id, String englishName) {
        assertThat(jdbcTemplate.update(
                        "UPDATE " + table + " SET translations = ?::jsonb WHERE id = ?",
                        objectMapper.writeValueAsString(Map.of("en", Map.of("name", englishName))),
                        id))
                .isEqualTo(1);
    }

    private void setLanguage(UUID post, String language) {
        assertThat(jdbcTemplate.update("UPDATE posts SET language = ? WHERE id = ?", language, post))
                .isEqualTo(1);
    }

    private String slugOf(UUID post) {
        return jdbcTemplate.queryForObject("SELECT slug FROM posts WHERE id = ?", String.class, post);
    }

    private UUID createPost(String title, String content, String excerpt, Taxon category, Taxon... tags)
            throws Exception {
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

    private UUID publish(String title, String content, String excerpt, Taxon category, Taxon... tags) throws Exception {
        UUID id = createPost(title, content, excerpt, category, tags);
        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
        return id;
    }
}
