package com.blog.analytics;

import static java.util.Map.entry;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.analytics.config.AnalyticsProperties;
import com.blog.analytics.dto.AnalyticsResponse;
import com.blog.analytics.dto.AnalyticsResponse.AnalyticsDay;
import com.blog.analytics.repository.AnalyticsRepository;
import com.blog.analytics.service.AnalyticsService;
import com.blog.analytics.service.ViewSourceClassifier;
import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.common.exception.ApiException;
import com.blog.post.config.ViewsProperties;
import com.blog.post.repository.PostViewRepository;
import com.blog.post.service.PostViewService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * View analytics: the {@code post_view_daily} table (V30), the write path {@code POST /api/v1/posts/{slug}/views}
 * with {@code X-View-Referrer}, and the {@code GET /api/v1/admin/analytics} report.
 *
 * The DB is shared and never cleaned: every assertion is scoped to the test's own post ids, or to days only this
 * class writes (year 2019 written straight with SQL, one month per test; year 2031 through a fixed clock). Views
 * recorded over HTTP land on today's date of the real clock. The midnight boundary is checked at the service level
 * with a fixed clock passed to the constructor: no extra Spring context. De-duplication and per-IP limiting live in
 * the Next route; the backend counts every call it accepts exactly once.
 */
@AutoConfigureMockMvc
class AnalyticsIT extends AbstractIntegrationTest {

    private static final String ANALYTICS = "/api/v1/admin/analytics";
    private static final List<String> SOURCES = List.of("direct", "search", "social", "github", "internal", "other");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private PostViewRepository postViewRepository;

    @Autowired
    private AnalyticsRepository analyticsRepository;

    @Autowired
    private ViewSourceClassifier classifier;

    @Autowired
    private AnalyticsProperties analyticsProperties;

    private CommentFixtures f;

    @BeforeEach
    void setUp() {
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    // --- V30 table ---------------------------------------------------------------------------------------

    @Test
    void daily_table_has_only_post_day_source_group_and_count_with_constraints_in_db() throws Exception {
        // Private by structure: no column exists for IP, user agent, session or referrer URL.
        assertThat(jdbcTemplate.queryForList("""
                SELECT column_name || ' ' || data_type || ' ' || is_nullable FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'post_view_daily' ORDER BY ordinal_position""", String.class))
                .containsExactly("post_id uuid NO", "day date NO", "source character varying NO", "views bigint NO");
        assertThat(jdbcTemplate.queryForObject("""
                SELECT pg_get_constraintdef(oid) FROM pg_constraint
                WHERE conrelid = 'post_view_daily'::regclass AND contype = 'p'""", String.class)).isEqualTo("PRIMARY KEY (post_id, day, source)");

        Post post = f.publishedPost("Post for the daily constraint check");
        insertDaily(post.id(), "2019-01-05", "search", 1);
        assertRejected("INSERT INTO post_view_daily VALUES (?, DATE '2019-01-05', 'search', 1)", post.id());
        assertRejected("INSERT INTO post_view_daily VALUES (?, DATE '2019-01-05', 'facebook', 1)", post.id());
        assertRejected("INSERT INTO post_view_daily VALUES (?, DATE '2019-01-05', 'DIRECT', 1)", post.id());
        assertRejected("INSERT INTO post_view_daily VALUES (?, DATE '2019-01-05', 'direct', -1)", post.id());
        assertRejected("INSERT INTO post_view_daily VALUES (?, NULL, 'direct', 1)", post.id());
        assertRejected("INSERT INTO post_view_daily VALUES (?, DATE '2019-01-05', 'direct', 1)", UUID.randomUUID());

        // Deleting a post takes its daily counts with it.
        f.deletePost(post);
        assertThat(count("SELECT count(*) FROM post_view_daily WHERE post_id = ?", post.id()))
                .isZero();
    }

    // --- Write --------------------------------------------------------------------------------------------

    @Test
    void each_accepted_view_adds_one_to_total_and_one_to_todays_row_of_source_group() throws Exception {
        Post post = f.publishedPost("Post measuring view sources");
        List<String> referrers = Arrays.asList(
                null,
                "",
                "www.google.com.vn",
                "l.facebook.com",
                "gist.github.com",
                "https://evil.example/x?y=1",
                "javascript:alert(1)",
                "l" + (char) 0xE1 + ".example",
                "Example.ORG.");
        LocalDate before = today();
        for (String referrer : referrers) {
            recordView(post.slug(), referrer).andExpect(status().isNoContent());
        }
        LocalDate after = today();

        assertThat(totalViews(post.id())).isEqualTo(referrers.size());
        assertThat(dailyBySource(post.id()))
                .containsExactlyInAnyOrderEntriesOf(
                        Map.of("direct", 2L, "search", 1L, "social", 1L, "github", 1L, "other", 4L));
        assertThat(jdbcTemplate.queryForList(
                        "SELECT DISTINCT day FROM post_view_daily WHERE post_id = ?", LocalDate.class, post.id()))
                .allSatisfy(day -> assertThat(day).isIn(before, after));
    }

    @Test
    void draft_withdrawn_post_and_unknown_slug_are_404_and_write_no_daily_row() throws Exception {
        Post draft = f.draftPost("Draft not counted per day");
        Post withdrawn = f.publishedPost("Withdrawn post not counted per day");
        f.unpublish(withdrawn);
        long rows = count("SELECT count(*) FROM post_view_daily");

        for (String slug : List.of(draft.slug(), withdrawn.slug(), "khong-co-bai-nay-" + f.suffix)) {
            assertError(recordView(slug, "www.google.com"), 404, "POST_NOT_FOUND");
        }

        assertThat(count("SELECT count(*) FROM post_view_daily")).isEqualTo(rows);
    }

    @Test
    void referrer_host_is_never_stored_in_any_table() throws Exception {
        Post post = f.publishedPost("Post for the source privacy check");
        String marker = "r" + UUID.randomUUID().toString().replace("-", "");
        recordView(post.slug(), marker + ".example").andExpect(status().isNoContent());
        recordView(post.slug(), "https://" + marker + ".example/p?q=" + marker).andExpect(status().isNoContent());
        // Control: both views were recorded, only under the group name.
        assertThat(dailyBySource(post.id())).containsExactly(entry("other", 2L));

        List<Map<String, Object>> columns = jdbcTemplate.queryForList("""
                SELECT table_name, column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')""");
        assertThat(columns).hasSizeGreaterThan(20);
        for (Map<String, Object> column : columns) {
            String sql = "SELECT count(*) FROM " + identifier(column.get("table_name")) + " WHERE "
                    + identifier(column.get("column_name")) + "::text LIKE ?";
            assertThat(count(sql, "%" + marker + "%"))
                    .as("%s.%s", column.get("table_name"), column.get("column_name"))
                    .isZero();
        }
    }

    @Test
    void eight_concurrent_views_of_one_post_count_eight_in_total_and_daily_row_without_lost_views_or_cross_locks()
            throws Exception {
        Post post = f.publishedPost("Post viewed in a burst");
        recordView(post.slug(), "t.co").andExpect(status().isNoContent());
        // Eight requests plus one lock-holding transaction plus one pg_stat_activity read: exactly fits the
        // 10-connection pool.
        int calls = 8;

        ExecutorService pool = Executors.newFixedThreadPool(calls);
        try (HeldTransaction row = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForList(
                        "SELECT view_count FROM post_views WHERE post_id = ? FOR UPDATE", post.id()))) {
            List<Future<MockHttpServletResponse>> responses = new ArrayList<>();
            for (int i = 0; i < calls; i++) {
                responses.add(pool.submit(() ->
                        recordView(post.slug(), "www.google.com").andReturn().getResponse()));
            }
            // All eight reached the total-increment statement and wait on that very row lock: real contention, not
            // thread-scheduling luck.
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "insert into post_views", calls);
            row.commit();
            for (Future<MockHttpServletResponse> response : responses) {
                assertThat(response.get(30, TimeUnit.SECONDS).getStatus()).isEqualTo(204);
            }
        } finally {
            pool.shutdownNow();
        }

        assertThat(totalViews(post.id())).isEqualTo(1 + calls);
        assertThat(dailyBySource(post.id()))
                .containsExactlyInAnyOrderEntriesOf(Map.of("social", 1L, "search", (long) calls));
    }

    // --- Day boundary ---------------------------------------------------------------------------------

    @Test
    void views_either_side_of_vietnam_midnight_fall_on_two_days_and_report_reads_same_time_zone() throws Exception {
        Reader author = f.author("thong-ke-nua-dem");
        Post post = f.publishedPostBy(author.bearer(), "Post viewed around midnight");
        // 23:59:59 on 9 May and 00:00:00 on 10 May Vietnam time (UTC+7): both are 9 May by the JVM's UTC.
        Instant lastSecond = Instant.parse("2031-05-09T16:59:59Z");
        Instant midnight = Instant.parse("2031-05-09T17:00:00Z");

        recordAt(lastSecond, post, "www.google.com");
        recordAt(midnight, post, "www.google.com");
        recordAt(midnight, post, null);

        assertThat(jdbcTemplate.queryForList("""
                SELECT day || ' ' || source || ' ' || views FROM post_view_daily WHERE post_id = ? ORDER BY day, source""", String.class, post.id()))
                .containsExactly("2031-05-09 search 1", "2031-05-10 direct 1", "2031-05-10 search 1");

        // The report's "today" is also the Vietnam-time date: the default range ends there, and tomorrow is rejected.
        AnalyticsResponse justBefore = reportAt(lastSecond, null, null, author.id());
        assertThat(justBefore.to()).isEqualTo(LocalDate.parse("2031-05-09"));
        assertThat(justBefore.from()).isEqualTo(LocalDate.parse("2031-04-10"));
        assertThat(justBefore.daily()).hasSize(30).last().isEqualTo(day("2031-05-09", 1));
        assertThat(justBefore.totals().views()).isEqualTo(1);
        assertThatThrownBy(() -> reportAt(lastSecond, null, LocalDate.parse("2031-05-10"), author.id()))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("to must not be after today");

        AnalyticsResponse justAfter = reportAt(midnight, null, null, author.id());
        assertThat(justAfter.to()).isEqualTo(LocalDate.parse("2031-05-10"));
        assertThat(justAfter.timeZone()).isEqualTo("Asia/Ho_Chi_Minh");
        assertThat(justAfter.daily().subList(28, 30)).containsExactly(day("2031-05-09", 1), day("2031-05-10", 2));
        assertThat(justAfter.totals().views()).isEqualTo(3);
        assertThat(justAfter.since()).isEqualTo(LocalDate.parse("2031-05-09"));
    }

    // --- Report: scope by role ------------------------------------------------------------------

    @Test
    void admin_sees_whole_site_while_author_sees_only_own_posts_in_every_figure() throws Exception {
        Reader a = f.author("thong-ke-a");
        Reader b = f.author("thong-ke-b");
        UUID a1 = f.publishedPostBy(a.bearer(), "Post A1").id();
        UUID a2 = insertDraft(a.id(), "Post A2");
        UUID b1 = f.publishedPostBy(b.bearer(), "Post B1").id();
        insertDaily(a1, "2019-03-01", "search", 5);
        insertDaily(a1, "2019-03-02", "direct", 3);
        insertDaily(a2, "2019-03-03", "other", 2);
        insertDaily(b1, "2019-03-01", "social", 7);
        insertDaily(b1, "2019-03-02", "search", 11);
        // Outside the range: not in the range's numbers, but it is B's first day with data.
        insertDaily(b1, "2019-02-20", "github", 4);
        setTotal(a1, 100);
        setTotal(a2, 20);
        setTotal(b1, 300);

        JsonNode ofA = report(a.bearer(), "2019-03-01", "2019-03-03");
        assertThat(dailyViews(ofA)).containsExactly(5L, 3L, 2L);
        assertThat(sources(ofA)).containsExactlyEntriesOf(sourceMap(3, 5, 0, 0, 0, 2));
        assertThat(topPosts(ofA)).containsExactly(a1 + " PUBLISHED 8", a2 + " DRAFT 2");
        assertThat(ofA.path("totals").path("views").asLong()).isEqualTo(10);
        assertThat(ofA.path("totals").path("allTimeViews").asLong()).isEqualTo(120);
        assertThat(ofA.path("since").asString()).isEqualTo("2019-03-01");

        JsonNode ofB = report(b.bearer(), "2019-03-01", "2019-03-03");
        assertThat(dailyViews(ofB)).containsExactly(7L, 11L, 0L);
        assertThat(sources(ofB)).containsExactlyEntriesOf(sourceMap(0, 11, 7, 0, 0, 0));
        assertThat(topPosts(ofB)).containsExactly(b1 + " PUBLISHED 18");
        assertThat(ofB.path("totals").path("views").asLong()).isEqualTo(18);
        assertThat(ofB.path("totals").path("allTimeViews").asLong()).isEqualTo(300);
        assertThat(ofB.path("since").asString()).isEqualTo("2019-02-20");

        // Only this class writes into March 2019, so the ADMIN figures for the range equal the two authors' sum.
        JsonNode global = report(auth.bearerForAdmin(), "2019-03-01", "2019-03-03");
        assertThat(dailyViews(global)).containsExactly(12L, 14L, 2L);
        assertThat(sources(global)).containsExactlyEntriesOf(sourceMap(3, 16, 7, 0, 0, 2));
        assertThat(topPosts(global)).containsExactly(b1 + " PUBLISHED 18", a1 + " PUBLISHED 8", a2 + " DRAFT 2");
        assertThat(global.path("totals").path("views").asLong()).isEqualTo(28);
        assertThat(global.path("totals").path("allTimeViews").asLong())
                .isEqualTo(count("SELECT coalesce(sum(view_count), 0) FROM post_views"));
        assertThat(global.path("since").asString())
                .isEqualTo(jdbcTemplate
                        .queryForObject("SELECT min(day) FROM post_view_daily", LocalDate.class)
                        .toString());
    }

    @Test
    void top_posts_max_ten_ties_by_title_then_id_and_summed_over_all_days_of_range() throws Exception {
        Reader author = f.author("thong-ke-top");
        Map<String, UUID> posts = new LinkedHashMap<>();
        for (String title : List.of(
                "Post 01", "Post 02", "Post 03", "Post 04", "Post 05", "Post 06", "Post 09", "Post 10", "Post 11",
                "Post 12")) {
            posts.put(title, insertDraft(author.id(), title));
        }
        UUID twinA = insertDraft(author.id(), "Same name post");
        UUID twinB = insertDraft(author.id(), "Same name post");
        insertDaily(posts.get("Post 01"), "2019-04-01", "direct", 30);
        insertDaily(posts.get("Post 01"), "2019-04-02", "search", 20);
        insertDaily(posts.get("Post 02"), "2019-04-02", "direct", 40);
        for (String tied : List.of("Post 06", "Post 04", "Post 05", "Post 03")) {
            insertDaily(posts.get(tied), "2019-04-01", "social", 30);
        }
        insertDaily(twinA, "2019-04-01", "direct", 20);
        insertDaily(twinB, "2019-04-02", "direct", 20);
        insertDaily(posts.get("Post 09"), "2019-04-01", "direct", 10);
        insertDaily(posts.get("Post 10"), "2019-04-01", "direct", 9);
        insertDaily(posts.get("Post 11"), "2019-04-01", "direct", 8);
        insertDaily(posts.get("Post 12"), "2019-04-01", "direct", 7);
        // Outside the range: must not be added.
        insertDaily(posts.get("Post 12"), "2019-04-03", "direct", 1000);

        JsonNode report = report(author.bearer(), "2019-04-01", "2019-04-02");

        // Postgres compares uuid byte by byte, which matches the string order of the lowercase hex form.
        List<UUID> twins =
                twinA.toString().compareTo(twinB.toString()) < 0 ? List.of(twinA, twinB) : List.of(twinB, twinA);
        assertThat(topPosts(report))
                .containsExactly(
                        posts.get("Post 01") + " DRAFT 50", posts.get("Post 02") + " DRAFT 40",
                        posts.get("Post 03") + " DRAFT 30", posts.get("Post 04") + " DRAFT 30",
                        posts.get("Post 05") + " DRAFT 30", posts.get("Post 06") + " DRAFT 30",
                        twins.get(0) + " DRAFT 20", twins.get(1) + " DRAFT 20",
                        posts.get("Post 09") + " DRAFT 10", posts.get("Post 10") + " DRAFT 9");
        JsonNode first = report.path("topPosts").get(0);
        assertThat(first.path("title").asString()).isEqualTo("Post 01");
        assertThat(first.path("slug").asString()).isEqualTo(slugOf(posts.get("Post 01")));
    }

    // --- Report: date range ---------------------------------------------------------------------------

    @Test
    void no_range_means_30_days_to_today_with_every_day_and_since_null_when_no_data() throws Exception {
        Reader author = f.author("thong-ke-rong");
        LocalDate before = today();
        JsonNode report = report(author.bearer(), null, null);
        LocalDate after = today();

        LocalDate to = LocalDate.parse(report.path("to").asString());
        assertThat(to).isIn(before, after);
        assertThat(report.path("from").asString()).isEqualTo(to.minusDays(29).toString());
        assertThat(report.path("timeZone").asString()).isEqualTo(analyticsProperties.timeZone());
        assertThat(report.path("since").isNull()).isTrue();
        List<String> days = new ArrayList<>();
        report.path("daily").forEach(day -> {
            days.add(day.path("day").asString());
            assertThat(day.path("views").asLong()).isZero();
        });
        assertThat(days).hasSize(30).startsWith(to.minusDays(29).toString()).endsWith(to.toString());
        assertThat(sources(report)).containsExactlyEntriesOf(sourceMap(0, 0, 0, 0, 0, 0));
        assertThat(report.path("topPosts").isEmpty()).isTrue();
        assertThat(report.path("totals").path("views").asLong()).isZero();
        assertThat(report.path("totals").path("allTimeViews").asLong()).isZero();

        // Blank parameters (a GET form sends empty fields) count as not sent; with only to, from is 29 days earlier.
        assertThat(LocalDate.parse(report(author.bearer(), "", "").path("to").asString()))
                .isIn(before, after, today());
        JsonNode onlyTo = report(author.bearer(), null, "2019-03-02");
        assertThat(onlyTo.path("from").asString()).isEqualTo("2019-02-01");
        assertThat(onlyTo.path("daily").size()).isEqualTo(30);
    }

    @Test
    void malformed_reversed_over_366_days_or_future_range_is_400_validation_error() throws Exception {
        String admin = auth.bearerForAdmin();
        // 366 days are allowed (the whole leap year 2020); a range across a month end has every day.
        assertThat(report(admin, "2020-01-01", "2020-12-31").path("daily").size())
                .isEqualTo(366);
        List<String> days = new ArrayList<>();
        report(admin, "2019-02-27", "2019-03-02")
                .path("daily")
                .forEach(day -> days.add(day.path("day").asString()));
        assertThat(days).containsExactly("2019-02-27", "2019-02-28", "2019-03-01", "2019-03-02");

        // Two days ahead: still the future even if the clock crosses midnight mid-test. The exact one-day boundary is
        // checked in the midnight test.
        String future = today().plusDays(2).toString();
        String[][] invalid = {
            {"2019-3-1", null},
            {"2019-02-30", null},
            {"hom-nay", null},
            {"2019-03-01T00:00", null},
            {null, "20190301"},
            {"2019-03-02", "2019-03-01"},
            {"2019-01-01", "2020-01-02"},
            {null, future},
            {future, null}
        };
        for (String[] range : invalid) {
            assertError(reportCall(admin, range[0], range[1]), 400, "VALIDATION_ERROR");
        }
        // Control: ending exactly today is accepted.
        reportCall(admin, null, today().toString()).andExpect(status().isOk());
    }

    // --- Assertions -------------------------------------------------------------------------------------------

    private void assertRejected(String sql, Object... args) {
        assertThatThrownBy(() -> jdbcTemplate.update(sql, args))
                .as(sql)
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        MockHttpServletResponse response = result.andReturn().getResponse();
        String body = response.getContentAsString(StandardCharsets.UTF_8);
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .as(body)
                .isEqualTo(code);
    }

    // --- Calls --------------------------------------------------------------------------------------------

    private ResultActions recordView(String slug, String referrer) throws Exception {
        MockHttpServletRequestBuilder request = post("/api/v1/posts/" + slug + "/views");
        return mockMvc.perform(referrer == null ? request : request.header("X-View-Referrer", referrer));
    }

    private ResultActions reportCall(String bearer, String from, String to) throws Exception {
        MockHttpServletRequestBuilder request = get(ANALYTICS).header("Authorization", bearer);
        if (from != null) {
            request.param("from", from);
        }
        if (to != null) {
            request.param("to", to);
        }
        return mockMvc.perform(request);
    }

    private JsonNode report(String bearer, String from, String to) throws Exception {
        MockHttpServletResponse response =
                reportCall(bearer, from, to).andReturn().getResponse();
        String body = response.getContentAsString(StandardCharsets.UTF_8);
        assertThat(response.getStatus()).as(body).isEqualTo(200);
        return objectMapper.readTree(body).path("data");
    }

    /** One view through the real service with the clock stopped at {@code at}, in a transaction as over HTTP. */
    private void recordAt(Instant at, Post post, String referrer) {
        PostViewService service = new PostViewService(
                postViewRepository,
                new ViewsProperties(""),
                classifier,
                new AnalyticsProperties("Asia/Ho_Chi_Minh"),
                Clock.fixed(at, ZoneOffset.UTC));
        new TransactionTemplate(transactionManager)
                .executeWithoutResult(status -> service.record(post.slug(), null, referrer));
    }

    private AnalyticsResponse reportAt(Instant at, LocalDate from, LocalDate to, UUID authorScope) {
        return new AnalyticsService(
                        analyticsRepository,
                        new AnalyticsProperties("Asia/Ho_Chi_Minh"),
                        Clock.fixed(at, ZoneOffset.UTC))
                .report(from, to, authorScope);
    }

    // --- Reads --------------------------------------------------------------------------------------------

    private LocalDate today() {
        return analyticsProperties.today(Clock.systemUTC());
    }

    private static AnalyticsDay day(String day, long views) {
        return new AnalyticsDay(LocalDate.parse(day), views);
    }

    private static List<Long> dailyViews(JsonNode report) {
        List<Long> views = new ArrayList<>();
        report.path("daily").forEach(day -> views.add(day.path("views").asLong()));
        return views;
    }

    private static Map<String, Long> sources(JsonNode report) {
        Map<String, Long> sources = new LinkedHashMap<>();
        report.path("sources")
                .forEach(source -> sources.put(
                        source.path("source").asString(), source.path("views").asLong()));
        return sources;
    }

    private static Map<String, Long> sourceMap(long... views) {
        Map<String, Long> map = new LinkedHashMap<>();
        for (int i = 0; i < SOURCES.size(); i++) {
            map.put(SOURCES.get(i), views[i]);
        }
        return map;
    }

    /** {@code "<id> <status> <views>"} of each most-read post, in the returned order. */
    private static List<String> topPosts(JsonNode report) {
        List<String> rows = new ArrayList<>();
        report.path("topPosts")
                .forEach(row -> rows.add(
                        row.path("id").asString() + " " + row.path("status").asString() + " "
                                + row.path("views").asLong()));
        return rows;
    }

    private Map<String, Long> dailyBySource(UUID postId) {
        Map<String, Long> bySource = new LinkedHashMap<>();
        jdbcTemplate.query(
                "SELECT source, sum(views) AS views FROM post_view_daily WHERE post_id = ? GROUP BY source",
                rs -> {
                    bySource.put(rs.getString("source"), rs.getLong("views"));
                },
                postId);
        return bySource;
    }

    private long totalViews(UUID postId) {
        return count("SELECT coalesce(sum(view_count), 0) FROM post_views WHERE post_id = ?", postId);
    }

    private String slugOf(UUID postId) {
        return jdbcTemplate.queryForObject("SELECT slug FROM posts WHERE id = ?", String.class, postId);
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    private static String identifier(Object name) {
        return '"' + name.toString().replace("\"", "\"\"") + '"';
    }

    // --- Direct SQL writes -----------------------------------------------------------------------------

    /**
     * An author's draft, written straight with SQL: the report counts posts of every status. Published posts always
     * go through the API, because a PUBLISHED post missing publishedAt or a category would leak into the public lists
     * that the other ITs walk through.
     */
    private UUID insertDraft(UUID authorId, String title) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update("""
                INSERT INTO posts (id, title, slug, content, status, author_id) VALUES (?, ?, ?, ?, 'DRAFT', ?)""", id, title, "thong-ke-" + id, "Content " + f.suffix, authorId);
        return id;
    }

    private void insertDaily(UUID postId, String day, String source, long views) {
        jdbcTemplate.update(
                "INSERT INTO post_view_daily (post_id, day, source, views) VALUES (?, ?, ?, ?)",
                postId,
                LocalDate.parse(day),
                source,
                views);
    }

    private void setTotal(UUID postId, long views) {
        jdbcTemplate.update("INSERT INTO post_views (post_id, view_count) VALUES (?, ?)", postId, views);
    }
}
