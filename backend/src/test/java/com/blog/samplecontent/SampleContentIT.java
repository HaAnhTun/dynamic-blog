package com.blog.samplecontent;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.i18n.LocalizedText;
import com.blog.samplecontent.service.SampleCatalog;
import com.blog.samplecontent.service.SampleCatalog.SampleItem;
import com.blog.samplecontent.service.SampleCatalog.SamplePost;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * {@code POST /api/v1/admin/sample-content}: the first call creates the four published posts (two articles in two
 * languages, linked as translations), the series, the category and the tags; a second call creates nothing; items that
 * already exist are reused, never duplicated; only an ADMIN may call it.
 *
 * The DB is shared by every IT, so each test starts from and leaves behind a database without the sample items (found by
 * their slugs and names, read from the packaged files). A fresh ADMIN account gives every test its own write rate-limit
 * bucket.
 */
@AutoConfigureMockMvc
class SampleContentIT extends AbstractIntegrationTest {

    private static final String URL = "/api/v1/admin/sample-content";

    private final SampleCatalog catalog = SampleCatalog.load();

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private User adminUser;
    private String admin;

    @BeforeEach
    void setUp() {
        wipe();
        adminUser = auth.createAccount("sample-admin-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        admin = auth.bearerFor(adminUser);
    }

    @AfterEach
    void cleanUp() {
        wipe();
    }

    /** Posts first (their slug history, revisions and tag links go with them), then what no post uses any more. */
    private void wipe() {
        List<String> series = names(catalog.series());
        List<String> categories = names(catalog.categories());
        List<String> tags = names(catalog.tags());
        jdbcTemplate.update("delete from posts where slug in (" + marks(slugs()) + ")", slugs().toArray());
        jdbcTemplate.update("delete from series where lower(title) in (" + marks(series) + ")", series.toArray());
        jdbcTemplate.update(
                "delete from categories where lower(name) in (" + marks(categories) + ")", categories.toArray());
        jdbcTemplate.update("delete from tags where lower(name) in (" + marks(tags) + ")", tags.toArray());
    }

    // --- Creation --------------------------------------------------------------------------------------

    @Test
    void the_first_call_creates_four_published_posts_the_series_the_category_and_the_tags() throws Exception {
        JsonNode result = data(load(admin).andExpect(status().isOk()));

        assertThat(result.path("posts").asInt()).isEqualTo(4);
        assertThat(result.path("series").asInt()).isEqualTo(1);
        assertThat(result.path("categories").asInt()).isEqualTo(1);
        assertThat(result.path("tags").asInt()).isEqualTo(2);
        assertThat(result.path("skipped").asInt()).isZero();

        // Published, none a draft, every one written by the calling admin, each in its own language.
        assertThat(count("select count(*) from posts where slug in (" + marks(slugs()) + ")", slugs()))
                .isEqualTo(4);
        assertThat(count(
                        "select count(*) from posts where status <> 'PUBLISHED' and slug in (" + marks(slugs()) + ")",
                        slugs()))
                .isZero();
        assertThat(count(
                        "select count(*) from posts where published_at is null and slug in (" + marks(slugs()) + ")",
                        slugs()))
                .isZero();
        List<Object> withAuthor = new ArrayList<>(slugs());
        withAuthor.add(adminUser.getId());
        assertThat(count(
                        "select count(*) from posts where slug in (" + marks(slugs()) + ") and author_id = ?",
                        withAuthor))
                .isEqualTo(4);
        for (SamplePost sample : catalog.posts()) {
            JsonNode post =
                    data(mockMvc.perform(get("/api/v1/posts/" + sample.slug())).andExpect(status().isOk()));
            assertThat(post.path("language").asString()).isEqualTo(sample.language());
            assertThat(post.path("title").asString()).isEqualTo(sample.title());
            assertThat(post.path("status").asString()).isEqualTo("PUBLISHED");
            assertThat(post.path("category").path("id").asString()).isNotBlank();
            assertThat(post.path("tags").size()).isEqualTo(sample.tagKeys().size());
        }
    }

    @Test
    void the_two_languages_of_each_article_are_linked_as_translations_of_each_other() throws Exception {
        load(admin).andExpect(status().isOk());

        for (String group : List.of("welcome", "markdown")) {
            List<SamplePost> pair = catalog.posts().stream()
                    .filter(p -> p.group().equals(group))
                    .toList();
            assertThat(pair).hasSize(2);
            assertThat(jdbcTemplate.queryForList(
                            "select distinct translation_group_id from posts where slug in (?, ?)",
                            UUID.class,
                            pair.get(0).slug(),
                            pair.get(1).slug()))
                    .hasSize(1)
                    .doesNotContainNull();
            for (int i = 0; i < 2; i++) {
                SamplePost self = pair.get(i);
                SamplePost sibling = pair.get(1 - i);
                JsonNode translations = data(mockMvc.perform(get("/api/v1/posts/" + self.slug()))
                                .andExpect(status().isOk()))
                        .path("translations");
                assertThat(translations.size()).isEqualTo(1);
                assertThat(translations.get(0).path("slug").asString()).isEqualTo(sibling.slug());
                assertThat(translations.get(0).path("language").asString()).isEqualTo(sibling.language());
            }
        }
        // The two articles are not translations of each other.
        assertThat(jdbcTemplate.queryForObject(
                        "select count(distinct translation_group_id) from posts where slug in (" + marks(slugs()) + ")",
                        Integer.class,
                        slugs().toArray()))
                .isEqualTo(2);
    }

    @Test
    void the_series_holds_the_four_posts_and_every_item_carries_its_translations() throws Exception {
        load(admin).andExpect(status().isOk());

        JsonNode series = adminSeries();
        assertThat(series.path("posts").size()).isEqualTo(4);
        List<String> memberSlugs = new ArrayList<>();
        series.path("posts").forEach(p -> memberSlugs.add(p.path("slug").asString()));
        assertThat(memberSlugs).containsExactlyInAnyOrderElementsOf(slugs());
        SampleItem sampleSeries = catalog.series().get(0);
        for (String language : sampleSeries.translations().keySet()) {
            LocalizedText expected = sampleSeries.translations().get(language);
            assertThat(series.path("translations").path(language).path("name").asString())
                    .isEqualTo(expected.name());
            assertThat(series.path("translations")
                            .path(language)
                            .path("description")
                            .asString())
                    .isEqualTo(expected.description());
        }

        JsonNode categories =
                data(mockMvc.perform(get("/api/v1/admin/categories").header("Authorization", admin))
                        .andExpect(status().isOk()));
        SampleItem sampleCategory = catalog.categories().get(0);
        JsonNode category = find(categories, sampleCategory);
        for (String language : sampleCategory.translations().keySet()) {
            assertThat(category.path("translations").path(language).path("name").asString())
                    .isEqualTo(sampleCategory.translations().get(language).name());
        }

        JsonNode tags = data(mockMvc.perform(get("/api/v1/admin/tags").header("Authorization", admin))
                .andExpect(status().isOk()));
        for (SampleItem sampleTag : catalog.tags()) {
            JsonNode tag = find(tags, sampleTag);
            for (String language : sampleTag.translations().keySet()) {
                assertThat(tag.path("translations").path(language).path("name").asString())
                        .isEqualTo(sampleTag.translations().get(language).name());
            }
        }
    }

    @Test
    void the_published_posts_show_up_in_the_public_list_of_each_language() throws Exception {
        load(admin).andExpect(status().isOk());

        for (String language : List.of("en", "vi")) {
            JsonNode page = data(
                    mockMvc.perform(get("/api/v1/posts").param("lang", language).param("size", "50"))
                            .andExpect(status().isOk()));
            List<String> listed = new ArrayList<>();
            page.forEach(p -> listed.add(p.path("slug").asString()));
            for (SamplePost sample : catalog.posts()) {
                if (sample.language().equals(language)) {
                    assertThat(listed).contains(sample.slug());
                } else {
                    assertThat(listed).doesNotContain(sample.slug());
                }
            }
        }
    }

    // --- Idempotency -----------------------------------------------------------------------------------

    @Test
    void a_second_call_creates_nothing_and_counts_every_item_as_skipped() throws Exception {
        load(admin).andExpect(status().isOk());
        long posts = totalPosts();
        long series = totalRows("series");
        long categories = totalRows("categories");
        long tags = totalRows("tags");

        JsonNode again = data(load(admin).andExpect(status().isOk()));

        assertThat(again.path("posts").asInt()).isZero();
        assertThat(again.path("series").asInt()).isZero();
        assertThat(again.path("categories").asInt()).isZero();
        assertThat(again.path("tags").asInt()).isZero();
        assertThat(again.path("skipped").asInt()).isEqualTo(4 + 1 + 1 + 2);
        assertThat(totalPosts()).isEqualTo(posts);
        assertThat(totalRows("series")).isEqualTo(series);
        assertThat(totalRows("categories")).isEqualTo(categories);
        assertThat(totalRows("tags")).isEqualTo(tags);
        assertThat(adminSeries().path("posts").size()).isEqualTo(4);
    }

    @Test
    void a_deleted_post_comes_back_linked_to_its_sibling_and_the_rest_is_untouched() throws Exception {
        load(admin).andExpect(status().isOk());
        SamplePost removed = catalog.posts().get(catalog.posts().size() - 1);
        UUID removedId = jdbcTemplate.queryForObject("select id from posts where slug = ?", UUID.class, removed.slug());
        mockMvc.perform(delete("/api/v1/admin/posts/" + removedId).header("Authorization", admin))
                .andExpect(status().isNoContent());

        JsonNode again = data(load(admin).andExpect(status().isOk()));

        assertThat(again.path("posts").asInt()).isEqualTo(1);
        assertThat(again.path("series").asInt()).isZero();
        assertThat(again.path("categories").asInt()).isZero();
        assertThat(again.path("tags").asInt()).isZero();
        assertThat(again.path("skipped").asInt()).isEqualTo(3 + 1 + 1 + 2);
        JsonNode back =
                data(mockMvc.perform(get("/api/v1/posts/" + removed.slug())).andExpect(status().isOk()));
        assertThat(back.path("translations").size()).isEqualTo(1);
        assertThat(back.path("status").asString()).isEqualTo("PUBLISHED");
    }

    @Test
    void a_category_that_already_exists_under_the_same_name_is_reused() throws Exception {
        SampleItem sampleCategory = catalog.categories().get(0);
        String name = sampleCategory.translations().get("en").name().toUpperCase(Locale.ROOT);
        JsonNode existing = data(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(java.util.Map.of("name", name))))
                .andExpect(status().isCreated()));

        JsonNode result = data(load(admin).andExpect(status().isOk()));

        assertThat(result.path("categories").asInt()).isZero();
        assertThat(result.path("posts").asInt()).isEqualTo(4);
        assertThat(jdbcTemplate.queryForList(
                        "select distinct category_id from posts where slug in (" + marks(slugs()) + ")",
                        UUID.class,
                        slugs().toArray()))
                .containsExactly(UUID.fromString(existing.path("id").asString()));
    }

    // --- Authorization ---------------------------------------------------------------------------------

    @Test
    void an_author_is_forbidden_and_an_anonymous_caller_is_unauthorized_and_nothing_is_created() throws Exception {
        String author = auth.bearerFor(auth.createAuthor("sample-author-" + UUID.randomUUID() + "@blog.local"));

        load(author).andExpect(status().isForbidden());
        mockMvc.perform(post(URL)).andExpect(status().isUnauthorized());

        assertThat(totalPosts()).isZero();
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    private ResultActions load(String bearer) throws Exception {
        return mockMvc.perform(post(URL).header("Authorization", bearer));
    }

    private JsonNode adminSeries() throws Exception {
        JsonNode all = data(mockMvc.perform(get("/api/v1/admin/series").header("Authorization", admin))
                .andExpect(status().isOk()));
        return find(all, catalog.series().get(0), "title");
    }

    private JsonNode find(JsonNode rows, SampleItem item) {
        return find(rows, item, "name");
    }

    /** The row whose name field equals the item's name in any language (the base text is the default locale's). */
    private JsonNode find(JsonNode rows, SampleItem item, String field) {
        List<String> names = names(List.of(item));
        for (JsonNode row : rows) {
            if (names.contains(row.path(field).asString().toLowerCase(Locale.ROOT))) {
                return row;
            }
        }
        throw new AssertionError("no row for " + item.key());
    }

    private List<String> slugs() {
        return catalog.posts().stream().map(SamplePost::slug).toList();
    }

    /** The lower-cased names of the items in every language. */
    private static List<String> names(List<SampleItem> items) {
        List<String> names = new ArrayList<>();
        items.forEach(item -> item.translations()
                .values()
                .forEach(text -> names.add(text.name().toLowerCase(Locale.ROOT))));
        return names;
    }

    private static String marks(List<?> values) {
        return String.join(", ", java.util.Collections.nCopies(values.size(), "?"));
    }

    private long count(String sql, List<?> args) {
        Long n = jdbcTemplate.queryForObject(sql, Long.class, args.toArray());
        return n == null ? 0 : n;
    }

    private long totalPosts() {
        return count("select count(*) from posts where slug in (" + marks(slugs()) + ")", slugs());
    }

    private long totalRows(String table) {
        Long n = jdbcTemplate.queryForObject("select count(*) from " + table, Long.class);
        return n == null ? 0 : n;
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString(UTF_8))
                .path("data");
    }
}
