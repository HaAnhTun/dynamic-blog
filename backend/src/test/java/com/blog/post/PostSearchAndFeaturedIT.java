package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.security.SeedAdmin;
import com.blog.fixtures.vi.ContentSearchVi;
import com.blog.post.repository.PostRepository;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import jakarta.persistence.EntityManagerFactory;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Full-text search and the `featured` flag.
 *
 * The test that matters most is {@code searchNeverReturnsAnUnpublishedDraft}. Search runs a
 * native query against a generated tsvector column, so it does not go through
 * {@code PostSpecifications.hasStatus} like every other public listing — the status filter is
 * a literal inside the SQL. Nothing but a test can keep those two in agreement, and getting it
 * wrong publishes every draft on the site to anyone with a search box.
 */
@AutoConfigureMockMvc
class PostSearchAndFeaturedIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private EntityManagerFactory entityManagerFactory;

    /** NUL: Postgres rejects it in text, so it once turned a search into a 409. */
    private static final String NUL = String.valueOf((char) 0);

    private String admin;
    private UUID category;

    @BeforeEach
    void seed() throws Exception {
        admin = auth.bearerForAdmin();
        category = createCategory().id();
    }

    // ---------------------------------------------------------------- search

    @Test
    void searchFindsAPostByAWordInItsTitle() throws Exception {
        publish("Tune query planner in Postgres", "noi dung khong lien quan");
        publish("Completely different", "cung khong lien quan");

        // containsExactly is safe here and not above: the search term is unique to this test,
        // so accumulated rows from other tests cannot match it. Where a term could collide —
        // "Postgres" appears in another test's title below — the assertion is containment.
        assertThat(searchTitles("query planner")).containsExactly("Tune query planner in Postgres");
    }

    @Test
    void searchFindsAPostByAWordOnlyInItsBody() throws Exception {
        // The reason title and body are both in the tsvector. A reader searching for a term
        // that appears in one paragraph of one article is the common case for a blog.
        publish("A harmless title", "This post mentions Testcontainers in the middle of the body.");

        assertThat(searchTitles("Testcontainers")).containsExactly("A harmless title");
    }

    @Test
    void searchRequiresAllTheWordsTyped() throws Exception {
        // plainto_tsquery ANDs the terms. Two words that each appear in a different post must
        // not match either of them, or a two-word search becomes a noisier search rather than
        // a narrower one.
        publish("Spring Boot and JPA", "noi dung");
        publish("Playwright on CI", "noi dung");

        assertThat(searchTitles("Spring Playwright")).isEmpty();
        assertThat(searchTitles("Spring JPA")).containsExactly("Spring Boot and JPA");
    }

    @Test
    void searchNeverReturnsAnUnpublishedDraft() throws Exception {
        // A word only this draft has. Not the draft word "nhap" anymore: since search folds accents on both sides,
        // "nhap"
        // would also match "dang nhap" (login) in a published post of another test class, and the empty result would
        // depend on which class runs first.
        String secret = uniqueWord();
        UUID draft = createPost("Secret draft about Kubernetes", "noi dung rieng tu " + secret);
        // Deliberately NOT published.

        // First prove the term is findable at all, otherwise an empty result proves nothing
        // about the status filter — it could just mean the tsvector never indexed the word.
        publish("Public post about Kubernetes", "noi dung");
        assertThat(searchTitles("Kubernetes")).containsExactly("Public post about Kubernetes");

        // Then prove the draft is the thing missing, by name.
        assertThat(searchTitles("Kubernetes")).doesNotContain("Secret draft about Kubernetes");
        assertThat(searchTitles(secret)).isEmpty();

        // And that it exists and contains the term — so the absence above is the filter
        // working, not the row being missing.
        mockMvc.perform(get("/api/v1/admin/posts/" + draft).header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("DRAFT"))
                .andExpect(jsonPath("$.data.title").value("Secret draft about Kubernetes"));
    }

    @Test
    void anUnpublishedPostDisappearsFromSearchAgain() throws Exception {
        UUID id = publish("Redis post to be withdrawn", "noi dung");
        assertThat(searchTitles("Redis")).containsExactly("Redis post to be withdrawn");

        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/unpublish").header("Authorization", admin))
                .andExpect(status().isOk());

        // The generated column is recomputed on write, but the status filter is what removes
        // the row — this is the same assertion in the other direction, and it would catch a
        // filter that only ever ran on insert.
        assertThat(searchTitles("Redis")).isEmpty();
    }

    @Test
    void searchMatchesVietnameseWithOrWithoutItsDiacritics() throws Exception {
        // "recursion" rather than a title like "Learn Spring Boot from scratch", and the reason is worth
        // recording: that title belongs to PostSlugAndUnpublishIT, which asserts its exact
        // slug. One container serves the whole JVM, so creating the same title here took
        // `hoc-spring-boot-tu-dau` first and the other test's post became
        // `hoc-spring-boot-tu-dau-2` — a failure in a file this one never touches. A fixture
        // in a shared-database suite needs a term no other test uses, in both directions:
        // unique enough that nothing else matches the search, and unique enough that nothing
        // else is disturbed by the row.
        publish(ContentSearchVi.RECURSION_TITLE, "noi dung");

        assertThat(searchTitles(ContentSearchVi.RECURSION_QUERY)).containsExactly(ContentSearchVi.RECURSION_TITLE);
        // The vi_unaccent configuration folds accents in both the text and the query, so typing without accents also
        // finds
        // that post. This line once pinned the limit of 'simple' ("de quy" returned nothing) so that adding unaccent
        // would show
        // up as a deliberate test change; now it pins the new behavior. Still unique: no other post in the test suite
        // has "quy".
        assertThat(searchTitles("de quy")).containsExactly(ContentSearchVi.RECURSION_TITLE);
    }

    @Test
    void anUnaccentedQueryFindsTheAccentedWords() throws Exception {
        // Each query comes with a word only this test has: plainto_tsquery ANDs the words, so the result is exactly
        // this
        // test's posts, even though posts of other classes also contain "hoc" or "duong". The query can only match
        // because accent folding makes "hoc" match the accented word.
        String marker = uniqueWord();
        publish(ContentSearchVi.LEARN_RUST_PREFIX + marker, "noi dung");
        publish(ContentSearchVi.ROAD_HOME_PREFIX + marker, "noi dung");
        publish(ContentSearchVi.THE_ROAD_PREFIX + marker, "noi dung");

        assertThat(searchTitles("hoc " + marker)).containsExactly(ContentSearchVi.LEARN_RUST_PREFIX + marker);
        // Both capital and lowercase d-with-stroke fold to d; the accented u and o fold to u and o.
        assertThat(searchTitles("duong " + marker))
                .containsExactlyInAnyOrder(
                        ContentSearchVi.ROAD_HOME_PREFIX + marker, ContentSearchVi.THE_ROAD_PREFIX + marker);
        // The accented form still matches as before, and also matches the capitalized post.
        assertThat(searchTitles(ContentSearchVi.ROAD_QUERY_PREFIX + marker))
                .containsExactlyInAnyOrder(
                        ContentSearchVi.ROAD_HOME_PREFIX + marker, ContentSearchVi.THE_ROAD_PREFIX + marker);
    }

    @Test
    void anUppercaseQueryWithOrWithoutDiacriticsStillMatches() throws Exception {
        String marker = uniqueWord();
        publish(ContentSearchVi.ROAD_OF_LEARNING_PREFIX + marker, "noi dung");

        // unaccent folds accents on capital letters too (D-with-stroke, O-with-dot), then 'simple' lowercases: the
        // order of the two dictionaries in the migration.
        assertThat(searchTitles(ContentSearchVi.LEARN_UPPER_PREFIX + marker.toUpperCase(Locale.ROOT)))
                .containsExactly(ContentSearchVi.ROAD_OF_LEARNING_PREFIX + marker);
        assertThat(searchTitles("DUONG HOC " + marker.toUpperCase(Locale.ROOT)))
                .containsExactly(ContentSearchVi.ROAD_OF_LEARNING_PREFIX + marker);
        assertThat(searchTitles(ContentSearchVi.ROAD_UPPER_PREFIX + marker))
                .containsExactly(ContentSearchVi.ROAD_OF_LEARNING_PREFIX + marker);
    }

    @Test
    void decomposedUnicodeMatchesComposedText() throws Exception {
        // NFD: the base letter followed by a separate combining mark (macOS, some keyboards, text pasted from a PDF).
        // Built with Normalizer instead of
        // typed in the source, to be sure this really is the decomposed string.
        String marker = uniqueWord();
        publish(ContentSearchVi.LEARNING_PATH_PREFIX + marker, "noi dung");
        String decomposed = Normalizer.normalize(ContentSearchVi.LEARN, Normalizer.Form.NFD);
        assertThat(decomposed).isNotEqualTo(ContentSearchVi.LEARN).hasSize(ContentSearchVi.LEARN.length() + 1);

        // The parser treats the combining mark as part of the word, and unaccent (since PG 13) also removes combining
        // marks.
        assertThat(searchTitles(decomposed + " " + marker))
                .containsExactly(ContentSearchVi.LEARNING_PATH_PREFIX + marker);

        // The opposite direction: text stored in NFD is found with NFC or without accents.
        String other = uniqueWord();
        String decomposedTitle = Normalizer.normalize(ContentSearchVi.NOODLES_PREFIX + other, Normalizer.Form.NFD);
        publish(decomposedTitle, "noi dung");
        assertThat(searchTitles(ContentSearchVi.NOODLES_QUERY_PREFIX + other)).containsExactly(decomposedTitle);
        assertThat(searchTitles("bun cha " + other)).containsExactly(decomposedTitle);
    }

    @Test
    void theUnaccentConfigurationFoldsAndTheGinIndexServesIt() {
        // Check the migration's configuration directly, not through the table: capital D-with-stroke becomes d, the
        // accented u/o lose their marks, lowercase.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT to_tsvector('vi_unaccent', '" + ContentSearchVi.ROAD_OF_LEARNING + "')::text",
                        String.class))
                .isEqualTo("'duong':1 'hoc':2");
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT plainto_tsquery('vi_unaccent', '" + ContentSearchVi.LEARN_UPPER + "')::text",
                        String.class))
                .isEqualTo("'hoc'");
        // Hyphenated words (hword and each part) and words mixed with digits (numword) are folded too.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT to_tsvector('vi_unaccent', '" + ContentSearchVi.HYPHEN_AND_NUMWORD + "')::text",
                        String.class))
                .isEqualTo("'da':2 'da-nang':1 'hoc2':4 'nang':3");
        // Exactly six word types of the default parser can contain non-ASCII letters that pass through unaccent; other
        // types keep 'simple'.
        assertThat(jdbcTemplate.queryForList("""
                SELECT t.alias FROM pg_ts_config_map m
                JOIN pg_ts_config c ON c.oid = m.mapcfg
                JOIN pg_ts_dict d ON d.oid = m.mapdict
                JOIN ts_token_type('default') t ON t.tokid = m.maptokentype
                WHERE c.cfgname = 'vi_unaccent' AND d.dictname = 'unaccent'
                ORDER BY t.alias""", String.class))
                .containsExactly("hword", "hword_numpart", "hword_part", "numhword", "numword", "word");

        // The GIN index recreated in the migration can serve an @@ query with the new configuration. At the blog's
        // table size, the planner is right not to
        // use it; seq scan is turned off so that the only remaining path for the @@ condition alone is the index, not
        // another scan.
        // Only the @@ condition, not the whole real search: that one also filters status and sorts by published_at, so
        // at this size the planner
        // picks the (status, published_at) index even with seq scan off, and the check would depend on the table's
        // statistics.
        // Every statement runs on ONE connection, in one transaction: SET LOCAL ends with the transaction, so it does
        // not leak into a later borrow of that connection by another test.
        List<String> plan = jdbcTemplate.execute((ConnectionCallback<List<String>>) connection -> {
            connection.setAutoCommit(false);
            try (Statement statement = connection.createStatement()) {
                statement.execute("SET LOCAL enable_seqscan = off");
                assertThat(setting(statement, "enable_seqscan")).isEqualTo("off");
                List<String> lines = new ArrayList<>();
                try (ResultSet rows = statement.executeQuery("""
                        EXPLAIN SELECT id FROM posts
                        WHERE search_vector @@ plainto_tsquery('vi_unaccent', 'hoc')""")) {
                    while (rows.next()) {
                        lines.add(rows.getString(1));
                    }
                }
                connection.rollback();
                // Control on that same connection: once the transaction is done, seq scan is back on.
                assertThat(setting(statement, "enable_seqscan")).isEqualTo("on");
                return lines;
            } finally {
                connection.setAutoCommit(true);
            }
        });
        String explained = String.join("\n", plan);
        assertThat(explained).as("EXPLAIN:%n%s", explained).contains("Index Scan on idx_posts_search_vector");
    }

    @Test
    void searchFoldsCase() throws Exception {
        publish("Tuning PostgreSQL", "noi dung");

        assertThat(searchTitles("postgresql")).containsExactly("Tuning PostgreSQL");
        assertThat(searchTitles("POSTGRESQL")).containsExactly("Tuning PostgreSQL");
    }

    @Test
    void aBlankQueryIsAnEmptyPageRatherThanAnError() throws Exception {
        publish("A post is here", "noi dung");

        // A search box that submits on empty is normal. 400 would be a worse answer than
        // "nothing matched yet", and the empty page must still carry valid pagination.
        mockMvc.perform(get("/api/v1/posts/search?q="))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").isArray())
                .andExpect(jsonPath("$.data").isEmpty())
                .andExpect(jsonPath("$.pagination.totalElements").value(0));

        mockMvc.perform(get("/api/v1/posts/search"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.pagination.totalElements").value(0));

        mockMvc.perform(get("/api/v1/posts/search?q=%20%20"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.pagination.totalElements").value(0));
    }

    @Test
    void punctuationDoesNotBreakTheQuery() throws Exception {
        publish("Regular post", "noi dung");

        // plainto_tsquery rather than to_tsquery exists for exactly this: a reader pasting
        // punctuation gets no results, not a 500 from a tsquery syntax error.
        for (String q : List.of("???", "&|!", "a & b", "'quoted'", "<script>")) {
            mockMvc.perform(get("/api/v1/posts/search").param("q", q)).andExpect(status().isOk());
        }
    }

    @Test
    void searchIsPublicAndNeedsNoToken() throws Exception {
        // Search with a word only this post has, not with the common word "doc" ("read"): since accent folding it also
        // matches "doc" in "Mo khoa doc gia" from
        // UserSuspensionIT, a published post, so containsExactly would depend on which class runs first.
        String marker = uniqueWord();
        publish("Everyone can read this", "noi dung " + marker);

        // No Authorization header anywhere in this test. Search sits under /api/v1/posts/**,
        // which is permitAll — but the filter chain's fallback is denyAll, so a path that is
        // not matched by a rule is refused. That makes this worth asserting rather than
        // assuming.
        assertThat(searchTitles(marker)).containsExactly("Everyone can read this");
    }

    @Test
    void searchPagesAndReportsItsTotal() throws Exception {
        for (int i = 1; i <= 3; i++) {
            publish("Kafka series part " + i, "noi dung");
        }

        String body = mockMvc.perform(get("/api/v1/posts/search?q=Kafka&page=0&size=2"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        JsonNode pagination = objectMapper.readTree(body).path("pagination");

        // The count query is a separate statement from the data query, so a totalElements that
        // tracks the page size instead of the match count is a real and easy mistake.
        assertThat(objectMapper.readTree(body).path("data").size()).isEqualTo(2);
        assertThat(pagination.path("totalElements").asInt()).isEqualTo(3);
        assertThat(pagination.path("totalPages").asInt()).isEqualTo(2);
    }

    @Test
    void aSearchResultCarriesTheSameSummaryShapeAsAListing() throws Exception {
        publish("Post with the full shape about Docker", "noi dung");

        mockMvc.perform(get("/api/v1/posts/search?q=Docker"))
                .andExpect(status().isOk())
                // A client should not need a second shape for search results.
                .andExpect(jsonPath("$.data[0].slug").isNotEmpty())
                .andExpect(jsonPath("$.data[0].status").value("PUBLISHED"))
                .andExpect(jsonPath("$.data[0].category.slug").isNotEmpty())
                .andExpect(jsonPath("$.data[0].readingMinutes").value(1))
                .andExpect(jsonPath("$.data[0].featured").value(false));
    }

    // ---------------------------------------------------------------- search filters

    @Test
    void filtering_by_category_tag_series_alone_or_combined_is_always_AND_and_multiple_tags_also_AND()
            throws Exception {
        String marker = uniqueWord();
        Taxon cat = createCategory();
        Taxon otherCat = createCategory();
        Taxon a = createTag();
        Taxon b = createTag();
        Taxon series = insertSeries();
        String both = "Two tags " + marker;
        String onlyA = "One tag " + marker;
        String elsewhere = "Other category " + marker;
        putInSeries(publishIn(both, "noi dung", cat, a, b), series, 1);
        publishIn(onlyA, "noi dung", cat, a);
        putInSeries(publishIn(elsewhere, "noi dung", otherCat, a, b), series, 2);

        assertThat(find("category", cat.slug())).containsExactlyInAnyOrder(both, onlyA);
        assertThat(find("tag", a.slug())).containsExactlyInAnyOrder(both, onlyA, elsewhere);
        assertThat(find("series", series.slug())).containsExactlyInAnyOrder(both, elsewhere);
        // Two tags: the post must have both. A repeated parameter or writing "a,b" counts as one; a repeated tag (even
        // with whitespace) counts once.
        assertThat(find("tag", a.slug(), "tag", b.slug())).containsExactlyInAnyOrder(both, elsewhere);
        assertThat(find("tag", a.slug() + "," + b.slug())).containsExactlyInAnyOrder(both, elsewhere);
        assertThat(find("tag", " " + a.slug() + " ", "tag", a.slug()))
                .containsExactlyInAnyOrder(both, onlyA, elsewhere);
        // A different kind also ANDs, and q narrows further inside the filter.
        assertThat(find("category", cat.slug(), "tag", b.slug())).containsExactly(both);
        assertThat(find("category", otherCat.slug(), "series", series.slug())).containsExactly(elsewhere);
        assertThat(find("q", "one", "category", cat.slug(), "tag", a.slug())).containsExactly(onlyA);
        assertThat(find("q", marker, "category", cat.slug(), "tag", a.slug(), "tag", b.slug(), "series", series.slug()))
                .containsExactly(both);
    }

    @Test
    void filter_only_orders_newest_first_with_q_orders_by_rank_then_ties_by_id() throws Exception {
        String marker = uniqueWord();
        Taxon cat = createCategory();
        String frequent = "Mentioned often " + marker;
        String recent = "Newer " + marker;
        setPublishedAt(publishIn(frequent, marker + " " + marker + " " + marker, cat), "2020-01-01T00:00:00Z");
        setPublishedAt(publishIn(recent, "noi dung", cat), "2020-01-02T00:00:00Z");

        assertThat(find("category", cat.slug())).containsExactly(recent, frequent);
        // With q the rank decides before the date: an older post that mentions the word four times is above a newer one
        // that mentions it once.
        assertThat(find("q", marker, "category", cat.slug())).containsExactly(frequent, recent);

        // Equal rank, same date: id descending (Postgres compares uuid like a hex string), so pages do not repeat
        // posts.
        String tie = uniqueWord();
        Taxon tieCat = createCategory();
        UUID one = publishIn("Tie one " + tie, "noi dung", tieCat);
        UUID two = publishIn("Tie two " + tie, "noi dung", tieCat);
        setPublishedAt(one, "2020-01-03T00:00:00Z");
        setPublishedAt(two, "2020-01-03T00:00:00Z");
        List<String> byIdDesc = one.toString().compareTo(two.toString()) > 0
                ? List.of("Tie one " + tie, "Tie two " + tie)
                : List.of("Tie two " + tie, "Tie one " + tie);
        assertThat(find("category", tieCat.slug())).isEqualTo(byIdDesc);
        assertThat(find("q", tie, "category", tieCat.slug())).isEqualTo(byIdDesc);
    }

    @Test
    void drafts_and_unpublished_posts_never_show_whatever_the_filter() throws Exception {
        String marker = uniqueWord();
        Taxon cat = createCategory();
        Taxon tag = createTag();
        Taxon series = insertSeries();
        String visible = "Public " + marker;
        putInSeries(publishIn(visible, "noi dung", cat, tag), series, 1);
        putInSeries(createPost("Draft " + marker, "noi dung", cat.id(), List.of(tag.id())), series, 2);
        UUID withdrawn = publishIn("Withdrawn " + marker, "noi dung", cat, tag);
        putInSeries(withdrawn, series, 3);
        mockMvc.perform(post("/api/v1/admin/posts/" + withdrawn + "/unpublish").header("Authorization", admin))
                .andExpect(status().isOk());

        for (List<String> params : List.of(
                List.of("category", cat.slug()),
                List.of("tag", tag.slug()),
                List.of("series", series.slug()),
                List.of("q", marker),
                List.of("q", marker, "category", cat.slug(), "tag", tag.slug(), "series", series.slug()))) {
            assertThat(find(params.toArray(String[]::new))).as("%s", params).containsExactly(visible);
        }
    }

    /**
     * Search (with text or filter only) omits posts by a suspended author; the /posts list still lists them, as
     * before. Only a USER can be suspended, so the author here is a USER account (an author who was demoted) with a published post.
     */
    @Test
    void post_of_suspended_author_never_shows_in_search_whatever_the_filter() throws Exception {
        String marker = uniqueWord();
        Taxon cat = createCategory();
        Taxon tag = createTag();
        User writer = auth.createReader(auth.nextGithubId(), "bi-khoa-" + marker);
        String title = "Suspended writer " + marker;
        UUID id = publishIn(title, "noi dung", cat, tag);
        assertThat(jdbcTemplate.update("UPDATE posts SET author_id = ? WHERE id = ?", writer.getId(), id))
                .isEqualTo(1);
        List<List<String>> searches =
                List.of(List.of("q", marker), List.of("category", cat.slug()), List.of("q", marker, "tag", tag.slug()));
        for (List<String> params : searches) {
            assertThat(find(params.toArray(String[]::new))).as("%s", params).containsExactly(title);
        }

        auth.setStatus(writer.getId(), UserStatus.SUSPENDED);
        for (List<String> params : searches) {
            assertThat(find(params.toArray(String[]::new))).as("%s", params).isEmpty();
        }
        assertThat(listTitles("/api/v1/posts?category=" + cat.slug())).containsExactly(title);

        auth.setStatus(writer.getId(), UserStatus.ACTIVE);
        assertThat(find("q", marker)).containsExactly(title);
    }

    @Test
    void unknown_malformed_repeated_or_over_limit_parameters_never_500_and_malformed_slug_never_reaches_DB()
            throws Exception {
        String marker = uniqueWord();
        Taxon cat = createCategory();
        Taxon tag = createTag();
        String title = "Parameter " + marker;
        publishIn(title, "noi dung", cat, tag);

        // Unknown slug: the SQL statement runs (control for the counter) and there is no post.
        assertThat(statementsDuring(
                        () -> assertThat(find("category", "khong-co-" + marker)).isEmpty()))
                .isPositive();
        // A malformed slug (uppercase, a repeated parameter turned into "a,b", NUL, over 255 characters), or nothing to
        // search for: an empty page with
        // no SQL statement at all.
        for (List<String> params : List.of(
                List.of("category", cat.slug().toUpperCase(Locale.ROOT)),
                List.of("category", cat.slug(), "category", cat.slug()),
                List.of("q", marker, "category", NUL),
                List.of("q", marker, "tag", tag.slug(), "tag", tag.slug() + NUL),
                List.of("series", "x".repeat(256)),
                List.of("q", NUL + " ", "tag", " "))) {
            assertThat(statementsDuring(() -> mockMvc.perform(searchRequest(params.toArray(String[]::new)))
                            .andExpect(status().isOk())
                            .andExpect(jsonPath("$.data").isEmpty())
                            .andExpect(jsonPath("$.pagination.totalElements").value(0))))
                    .as("%s", params)
                    .isZero();
        }
        // The post list uses the same slug check: NUL here was once a 409.
        for (String filter : List.of("category", "tag")) {
            mockMvc.perform(get("/api/v1/posts").param(filter, NUL))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data").isEmpty())
                    .andExpect(jsonPath("$.pagination.totalElements").value(0));
        }

        // At most 5 distinct tags; a repeated tag does not count extra.
        String[] fiveTags = {"tag", "a", "tag", "b", "tag", "c", "tag", "d", "tag", tag.slug(), "tag", tag.slug()};
        mockMvc.perform(searchRequest(fiveTags)).andExpect(status().isOk());
        mockMvc.perform(searchRequest(fiveTags).param("tag", "e"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));

        // q: at most 200 code points AFTER cleaning (an emoji outside the BMP counts as one, control characters do not
        // count); 201 is a 400.
        String emoji = new String(Character.toChars(0x1F600));
        for (String q : List.of("a".repeat(200), emoji.repeat(200), "a".repeat(200) + NUL + (char) 7)) {
            mockMvc.perform(get("/api/v1/posts/search").param("q", q)).andExpect(status().isOk());
        }
        mockMvc.perform(get("/api/v1/posts/search").param("q", "a".repeat(201)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        // NUL in q is dropped rather than becoming a 409: the rest still finds the post.
        assertThat(find("q", marker.substring(0, 6) + NUL + marker.substring(6)))
                .containsExactly(title);
    }

    @Test
    void pagination_keeps_the_filter_and_unaccented_search_stays_correct_with_a_filter() throws Exception {
        String marker = uniqueWord();
        Taxon cat = createCategory();
        Taxon tag = createTag();
        List<String> inCategory = new ArrayList<>();
        for (int i = 1; i <= 3; i++) {
            inCategory.add(ContentSearchVi.ROAD_OF_LEARNING_NUMBER_PREFIX + i + " " + marker);
            publishIn(inCategory.getLast(), "noi dung", cat, tag);
        }
        String outside = ContentSearchVi.ROAD_OF_LEARNING_OUTSIDE_PREFIX + marker;
        publishIn(outside, "noi dung", createCategory(), tag);

        // The total and page count are those of the filtered set; two pages together make all three posts, no repeats.
        for (List<String> params : List.of(
                List.of("category", cat.slug()),
                List.of("q", "duong hoc", "category", cat.slug(), "tag", tag.slug()))) {
            List<String> seen = new ArrayList<>();
            for (int page = 0; page < 2; page++) {
                JsonNode body = objectMapper.readTree(mockMvc.perform(searchRequest(params.toArray(String[]::new))
                                .param("page", String.valueOf(page))
                                .param("size", "2"))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString());
                assertThat(body.path("pagination").path("totalElements").asInt())
                        .as("%s", params)
                        .isEqualTo(3);
                assertThat(body.path("pagination").path("totalPages").asInt())
                        .as("%s", params)
                        .isEqualTo(2);
                body.path("data").forEach(post -> seen.add(post.path("title").asString()));
            }
            assertThat(seen).as("%s", params).containsExactlyInAnyOrderElementsOf(inCategory);
        }
        // Without accents or with accented capitals, same filter: only the posts in the filter.
        assertThat(find("q", "duong", "category", cat.slug())).containsExactlyInAnyOrderElementsOf(inCategory);
        List<String> tagged = new ArrayList<>(inCategory);
        tagged.add(outside);
        assertThat(find("q", ContentSearchVi.ROAD_OF_LEARNING_UPPER, "tag", tag.slug()))
                .containsExactlyInAnyOrderElementsOf(tagged);
    }

    /**
     * The filter path uses the existing index on data large enough for the planner to have to choose (2000 fake posts, 10 categories, 50
     * tags, 100 series), in a rolled-back transaction on ONE connection like TaxonomyIndexSchemaIT. The statement is exactly that of
     * {@link PostRepository.Search}, with the parameters replaced by constants.
     */
    @Test
    void search_filter_path_uses_index_on_2000_fake_posts_without_scanning_the_whole_posts_table() {
        String m = uniqueWord();
        Map<String, PostRepository.Search> shapes = new LinkedHashMap<>();
        // Word m37 is in 20 posts, all in category 8; tag 2 is in 80 posts, together with tag 8 in 40; series 5 has 5
        // posts.
        shapes.put("category + q", new PostRepository.Search(m + "37", "cm-" + m + "-8", null, List.of()));
        shapes.put(
                "two tags", new PostRepository.Search(null, null, null, List.of("the-" + m + "-2", "the-" + m + "-8")));
        shapes.put("series only", new PostRepository.Search(null, null, "se-" + m + "-5", List.of()));
        shapes.put("tag only", new PostRepository.Search(null, null, null, List.of("the-" + m + "-2")));
        Map<String, String> plans = jdbcTemplate.execute((ConnectionCallback<Map<String, String>>) connection -> {
            connection.setAutoCommit(false);
            try (Statement statement = connection.createStatement()) {
                for (String sql : syntheticPosts(m)) {
                    statement.execute(sql);
                }
                Map<String, String> explained = new LinkedHashMap<>();
                for (Map.Entry<String, PostRepository.Search> shape : shapes.entrySet()) {
                    PostRepository.Search search = shape.getValue();
                    // The first page with the API's default size (20).
                    explained.put(shape.getKey(), explain(statement, withLiterals(search.sql(), search) + " LIMIT 20"));
                    explained.put(
                            shape.getKey() + " (count)", explain(statement, withLiterals(search.countSql(), search)));
                }
                return explained;
            } finally {
                connection.rollback();
                connection.setAutoCommit(true);
            }
        });
        // ANALYZE writes the table's row count in place, not per transaction: measure again so later tests see the real
        // table.
        jdbcTemplate.execute("ANALYZE posts, post_tags, tags, categories, series");

        // Category + q: the planner was measured following the category index and then filtering @@; GIN is also
        // correct, depending on the statistics at run time.
        Map<String, List<String>> indexes = Map.of(
                "category + q", List.of("idx_posts_category_id", "idx_posts_search_vector"),
                "two tags", List.of("idx_post_tags_tag_id"),
                "series only", List.of("uq_posts_series_position"),
                "tag only", List.of("idx_post_tags_tag_id"));
        assertThat(plans).hasSize(2 * indexes.size());
        plans.forEach((shape, plan) -> assertThat(plan)
                .as("%s:%n%s", shape, plan)
                .containsAnyOf(indexes.get(shape.replace(" (count)", "")).toArray(String[]::new))
                .doesNotContain("Seq Scan on posts"));
    }

    @Test
    void vi_unaccent_splits_code_identifiers_exactly_as_the_documented_limitation() {
        // A dot keeps the whole identifier as one token: searching "json.loads" finds it, searching "loads" does not.
        assertThat(tsvector("json.loads")).isEqualTo("'json.loads':1");
        assertThat(matches("call json.loads here", "json.loads")).isTrue();
        assertThat(matches("call json.loads here", "loads")).isFalse();
        // An underscore splits words; + and # are dropped, so C++ and C# both end up as just "c".
        assertThat(tsvector("snake_case_name")).isEqualTo("'case':2 'name':3 'snake':1");
        assertThat(tsvector("C++")).isEqualTo("'c':1");
        assertThat(tsvector("C#")).isEqualTo("'c':1");
        // camelCase is one lowercase word; no substring search.
        assertThat(tsvector("maxReceiveCount")).isEqualTo("'maxreceivecount':1");
        assertThat(matches("maxReceiveCount", "receive")).isFalse();
    }

    // ---------------------------------------------------------------- featured

    @Test
    void theFeaturedFilterNarrowsTheListingAndItsAbsenceDoesNot() throws Exception {
        UUID starred = publish("Picked post", "noi dung");
        publish("Regular post", "noi dung");

        mockMvc.perform(post("/api/v1/admin/posts/" + starred + "/feature").header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.featured").value(true));

        // Containment rather than containsExactly, and the reason is not laziness.
        // AbstractIntegrationTest keeps one container for the JVM and these tests are not
        // transactional, so rows from every earlier test in the class — and from earlier
        // classes in the same run — are still there. An exact assertion over a global listing
        // would pass alone and fail in a suite, which is the worst kind of test.
        //
        // Both directions are still asserted, which is what makes it meaningful: the
        // featured listing must contain this test's featured post and must NOT contain the
        // one it deliberately left unfeatured.
        assertThat(listTitles("/api/v1/posts?featured=true")).contains("Picked post");
        assertThat(listTitles("/api/v1/posts?featured=true")).doesNotContain("Regular post");
        assertThat(listTitles("/api/v1/posts")).contains("Picked post", "Regular post");
    }

    @Test
    void featuredFalseIsNotTheSameRequestAsFeaturedAbsent() throws Exception {
        UUID starred = publish("Picked", "noi dung");
        publish("Not picked", "noi dung");
        mockMvc.perform(post("/api/v1/admin/posts/" + starred + "/feature").header("Authorization", admin))
                .andExpect(status().isOk());

        // The service takes a Boxed Boolean so that absent means "everything". A primitive
        // would have defaulted to false and turned a plain /posts request into
        // "only the posts that are not featured" — which is why `?featured=false` is
        // deliberately NOT a filter for the complement.
        assertThat(listTitles("/api/v1/posts?featured=false")).contains("Picked", "Not picked");
    }

    @Test
    void unfeatureReversesIt() throws Exception {
        UUID id = publish("Unpick", "noi dung");
        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/feature").header("Authorization", admin))
                .andExpect(status().isOk());
        assertThat(listTitles("/api/v1/posts?featured=true")).contains("Unpick");

        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/unfeature").header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.featured").value(false));

        // Scoped to this post: other tests in the class leave their own featured posts behind.
        assertThat(listTitles("/api/v1/posts?featured=true")).doesNotContain("Unpick");
    }

    @Test
    void featuringIsIdempotentUnlikePublishing() throws Exception {
        UUID id = publish("Called twice", "noi dung");

        // Deliberate asymmetry with publish/unpublish, which answer 422 on a no-op. Featuring
        // has no side effect to corrupt, and a UI toggle or a re-run of the seed script will
        // legitimately send it twice.
        for (int i = 0; i < 2; i++) {
            mockMvc.perform(post("/api/v1/admin/posts/" + id + "/feature").header("Authorization", admin))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.featured").value(true));
        }
    }

    @Test
    void aFeaturedDraftIsStillInvisibleToThePublic() throws Exception {
        UUID draft = createPost("Draft but picked", "noi dung");
        mockMvc.perform(post("/api/v1/admin/posts/" + draft + "/feature").header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.featured").value(true));

        // featured and published are independent, and the public query filters on both. A
        // homepage that read `featured` alone would publish a draft.
        assertThat(listTitles("/api/v1/posts?featured=true")).doesNotContain("Draft but picked");
        assertThat(listTitles("/api/v1/posts")).doesNotContain("Draft but picked");
    }

    @Test
    void anAuthorCannotFeatureSomeoneElsesPost() throws Exception {
        UUID adminPost = publish("Admin post", "noi dung");
        User other = auth.createAuthor("feature-" + UUID.randomUUID() + "@blog.local");

        // Featuring is ADMIN only, an author's own post included (SecurityMatrixIT): the
        // homepage is a site-level decision, not an ownership question.
        mockMvc.perform(post("/api/v1/admin/posts/" + adminPost + "/feature")
                        .header("Authorization", auth.bearerFor(other)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        mockMvc.perform(post("/api/v1/admin/posts/" + adminPost + "/unfeature")
                        .header("Authorization", auth.bearerFor(other)))
                .andExpect(status().isForbidden());
    }

    @Test
    void featuringNeedsAToken() throws Exception {
        UUID id = publish("Needs token", "noi dung");

        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/feature"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"));
    }

    // ---------------------------------------------------------------- reading time

    @Test
    void readingTimeGrowsWithTheBodyAndIsNeverZero() throws Exception {
        UUID shortPost = publish("Very short post", "one two three");
        UUID longPost = publish("Very long post", ("word ".repeat(1200)));

        // Never zero: a one-line post that claimed "0 minutes read" would read as a bug.
        mockMvc.perform(get("/api/v1/admin/posts/" + shortPost).header("Authorization", admin))
                .andExpect(jsonPath("$.data.readingMinutes").value(1));
        // 1200 tokens at 200 per minute is 6.
        mockMvc.perform(get("/api/v1/admin/posts/" + longPost).header("Authorization", admin))
                .andExpect(jsonPath("$.data.readingMinutes").value(6));
    }

    // ---------------------------------------------------------------- helpers

    /**
     * A word only this test uses: 12 random ASCII letters, no digits, no dashes, so the parser keeps it as exactly one word. The DB
     * is shared by every test class and never cleaned, and an accented word matches all of its spellings.
     */
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

    /** The current value of a Postgres parameter, on the very connection of the statement. */
    private static String setting(Statement statement, String name) throws SQLException {
        try (ResultSet row = statement.executeQuery("SHOW " + name)) {
            assertThat(row.next()).isTrue();
            return row.getString(1);
        }
    }

    private List<String> searchTitles(String q) throws Exception {
        return titlesOf(
                mockMvc.perform(get("/api/v1/posts/search").param("q", q).param("size", "50"))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString());
    }

    private List<String> listTitles(String url) throws Exception {
        String joined = url.contains("?") ? url + "&size=50" : url + "?size=50";
        return titlesOf(mockMvc.perform(get(joined))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString());
    }

    private List<String> titlesOf(String body) {
        List<String> titles = new ArrayList<>();
        objectMapper
                .readTree(body)
                .path("data")
                .forEach(node -> titles.add(node.path("title").asString()));
        return titles;
    }

    /** {@code params} are pairs of name, value; a repeated name becomes a repeated parameter. */
    private static MockHttpServletRequestBuilder searchRequest(String... params) {
        MockHttpServletRequestBuilder request = get("/api/v1/posts/search");
        for (int i = 0; i < params.length; i += 2) {
            request.param(params[i], params[i + 1]);
        }
        return request;
    }

    /** The titles of the first page (size 50) for a filtered search, like {@link #searchTitles}. */
    private List<String> find(String... params) throws Exception {
        return titlesOf(mockMvc.perform(searchRequest(params).param("size", "50"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString());
    }

    private interface Request {
        void run() throws Exception;
    }

    /** The number of SQL statements Hibernate prepares while running one request, like PostReadModelIT. */
    private long statementsDuring(Request request) throws Exception {
        Statistics statistics =
                entityManagerFactory.unwrap(SessionFactory.class).getStatistics();
        boolean wasEnabled = statistics.isStatisticsEnabled();
        statistics.setStatisticsEnabled(true);
        try {
            statistics.clear();
            request.run();
            return statistics.getPrepareStatementCount();
        } finally {
            statistics.setStatisticsEnabled(wasEnabled);
        }
    }

    private String tsvector(String text) {
        return jdbcTemplate.queryForObject("SELECT to_tsvector('vi_unaccent', ?)::text", String.class, text);
    }

    private boolean matches(String text, String query) {
        return Boolean.TRUE.equals(jdbcTemplate.queryForObject(
                "SELECT to_tsvector('vi_unaccent', ?) @@ plainto_tsquery('vi_unaccent', ?)",
                Boolean.class,
                text,
                query));
    }

    /**
     * Fake data for the measurement, then ANALYZE: post g (1..2000) belongs to category g % 10 + 1, carries tags g % 50 + 1 and
     * 7g % 50 + 1, every fourth post is in a series (100 series, 5 posts each), every twentieth post is a draft.
     */
    private static List<String> syntheticPosts(String m) {
        return List.of(
                        "INSERT INTO categories (name, slug) SELECT 'Fake {m} ' || g, 'cm-{m}-' || g "
                                + "FROM generate_series(1, 10) g",
                        "INSERT INTO tags (name, slug) SELECT 'Fake {m} ' || g, 'the-{m}-' || g FROM generate_series(1, 50) g",
                        "INSERT INTO series (title, slug) SELECT 'Fake {m} ' || g, 'se-{m}-' || g "
                                + "FROM generate_series(1, 100) g",
                        """
                INSERT INTO posts (title, slug, content, status, author_id, category_id, published_at,
                                   series_id, series_position)
                SELECT 'Fake post ' || g, 'gia-{m}-' || g, 'noi dung gia {m}' || g % 100,
                       CASE WHEN g % 20 = 0 THEN 'DRAFT' ELSE 'PUBLISHED' END, '{admin}', c.id,
                       CASE WHEN g % 20 = 0 THEN NULL ELSE now() - make_interval(hours => g) END,
                       s.id, CASE WHEN g % 4 = 0 THEN g / 400 + 1 END
                FROM generate_series(1, 2000) g
                JOIN categories c ON c.slug = 'cm-{m}-' || (g % 10 + 1)
                LEFT JOIN series s ON g % 4 = 0 AND s.slug = 'se-{m}-' || (g / 4 % 100 + 1)""",
                        """
                INSERT INTO post_tags (post_id, tag_id)
                SELECT p.id, t.id FROM posts p
                CROSS JOIN LATERAL (VALUES (split_part(p.slug, '-', 3)::int % 50 + 1),
                                           (split_part(p.slug, '-', 3)::int * 7 % 50 + 1)) v(n)
                JOIN tags t ON t.slug = 'the-{m}-' || v.n
                WHERE p.slug LIKE 'gia-{m}-%'
                ON CONFLICT DO NOTHING""",
                        "ANALYZE posts, post_tags, tags, categories, series")
                .stream()
                .map(sql -> sql.replace("{m}", m).replace("{admin}", SeedAdmin.ID.toString()))
                .toList();
    }

    /** The statement of {@link PostRepository.Search} with the parameters replaced by constants: the test's values, no quotes. */
    private static String withLiterals(String sql, PostRepository.Search search) {
        return sql.replace(":q", "'" + search.text() + "'")
                .replace(":category", "'" + search.category() + "'")
                .replace(":series", "'" + search.series() + "'")
                .replace(
                        ":tags",
                        search.tags().stream().map(tag -> "'" + tag + "'").collect(Collectors.joining(", ")))
                .replace(":tagCount", String.valueOf(search.tags().size()));
    }

    private static String explain(Statement statement, String sql) throws SQLException {
        List<String> lines = new ArrayList<>();
        try (ResultSet rows = statement.executeQuery("EXPLAIN (ANALYZE, TIMING OFF, SUMMARY OFF) " + sql)) {
            while (rows.next()) {
                lines.add(rows.getString(1));
            }
        }
        return String.join("\n", lines);
    }

    private record Taxon(UUID id, String slug) {}

    private Taxon taxon(String body) {
        JsonNode data = objectMapper.readTree(body).path("data");
        return new Taxon(
                UUID.fromString(data.path("id").asString()), data.path("slug").asString());
    }

    private Taxon createCategory() throws Exception {
        return taxon(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"Category " + UUID.randomUUID() + "\"}"))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString());
    }

    private Taxon createTag() throws Exception {
        return taxon(mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"Tag " + uniqueWord() + "\"}"))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString());
    }

    /** A series written straight with SQL, like PostReadModelIT: the test only needs the slug and the members. */
    private Taxon insertSeries() {
        String slug = "series-" + uniqueWord();
        UUID id = jdbcTemplate.queryForObject(
                "INSERT INTO series (title, slug) VALUES (?, ?) RETURNING id", UUID.class, "Series " + slug, slug);
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

    /** A fixed publish date in the past: the order does not depend on the clock, and the post does not push to the top of the shared list. */
    private void setPublishedAt(UUID post, String instant) {
        assertThat(jdbcTemplate.update(
                        "UPDATE posts SET published_at = cast(? AS timestamptz) WHERE id = ?", instant, post))
                .isEqualTo(1);
    }

    private UUID createPost(String title, String content) throws Exception {
        return createPost(title, content, category, List.of());
    }

    private UUID createPost(String title, String content, UUID categoryId, List<UUID> tagIds) throws Exception {
        String payload = objectMapper.writeValueAsString(Map.of(
                "title",
                title,
                "content",
                content,
                "categoryId",
                categoryId.toString(),
                "tagIds",
                tagIds.stream().map(UUID::toString).toList()));
        String body = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return UUID.fromString(
                objectMapper.readTree(body).path("data").path("id").asString());
    }

    private UUID publish(String title, String content) throws Exception {
        UUID id = createPost(title, content);
        publish(id);
        return id;
    }

    /** A published post in a category, with the given tags. */
    private UUID publishIn(String title, String content, Taxon category, Taxon... tags) throws Exception {
        UUID id = createPost(
                title,
                content,
                category.id(),
                Arrays.stream(tags).map(Taxon::id).toList());
        publish(id);
        return id;
    }

    private void publish(UUID id) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
    }
}
