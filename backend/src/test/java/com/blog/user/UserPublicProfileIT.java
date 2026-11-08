package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.oauth.GithubProfile;
import com.blog.auth.service.RefreshTokenService;
import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.common.security.AdminAccountProperties;
import com.blog.common.security.AdminGithubLink;
import com.blog.common.security.SeedAdmin;
import com.blog.fixtures.vi.IdentityViNames;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.GithubAccountService;
import com.blog.user.service.GithubAccountService.UserLogin;
import jakarta.persistence.EntityManagerFactory;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ResultSetExtractor;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Public profile: the {@code public_slug} handle of new users (generated, collisions, races, immutable), {@code GET
 * /api/v1/users/{slug}} (exactly seven fields, nothing private, the 404s), the {@code GET /api/v1/posts?author=} filter and
 * {@code profileSlug} in the author of posts and comments. The migration that fills slugs for old rows: UserPublicSlugMigrationIT.
 */
@AutoConfigureMockMvc
class UserPublicProfileIT extends AbstractIntegrationTest {

    private static final String USERS = "/api/v1/users/";
    private static final List<String> PROFILE_FIELDS =
            List.of("slug", "displayName", "githubLogin", "avatarUrl", "siteOwner", "joinedAt", "publishedPosts");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private GithubAccountService githubAccountService;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private EntityManagerFactory entityManagerFactory;

    private CommentFixtures f;

    @BeforeEach
    void setUp() {
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    // --- Slug of new users ------------------------------------------------------------------------------

    @Test
    void first_login_generates_slug_from_login_same_base_takes_smallest_free_suffix_and_slug_never_changes() {
        long n = auth.nextGithubId();
        String base = "slug-moi-" + n;
        long firstId = auth.nextGithubId();
        UserLogin first = githubAccountService.recordLogin(profile(firstId, "Slug-Moi-" + n));
        assertThat(first.created()).isTrue();
        assertThat(slugOf(first.userId())).isEqualTo(base);
        // A login that already looks like "base-2" keeps its own base; the next person with the same base skips it and
        // takes "-3".
        UserLogin shaped = githubAccountService.recordLogin(profile(auth.nextGithubId(), base + "-2"));
        assertThat(slugOf(shaped.userId())).isEqualTo(base + "-2");
        UserLogin third = githubAccountService.recordLogin(profile(auth.nextGithubId(), "slug--moi-" + n));
        assertThat(slugOf(third.userId())).isEqualTo(base + "-3");

        // Changing the GitHub login: login and name follow GitHub, the slug stays (DO UPDATE does not touch
        // public_slug).
        UserLogin renamed = githubAccountService.recordLogin(profile(firstId, "doi-ten-" + n));
        assertThat(renamed.created()).isFalse();
        assertThat(renamed.userId()).isEqualTo(first.userId());
        Map<String, Object> row =
                jdbcTemplate.queryForMap("SELECT github_login, public_slug FROM users WHERE id = ?", first.userId());
        assertThat(row.get("github_login")).isEqualTo("doi-ten-" + n);
        assertThat(row.get("public_slug")).isEqualTo(base);
        // A new login equal to the base of an old slug still cannot take that slug.
        UserLogin fourth = githubAccountService.recordLogin(profile(auth.nextGithubId(), "slug-moi-" + n));
        assertThat(slugOf(fourth.userId())).isEqualTo(base + "-4");

        // Saving the entity does not write the slug (updatable = false), even if that save writes other columns.
        User loaded = userRepository.findById(first.userId()).orElseThrow();
        loaded.setPublicSlug("ghi-qua-entity-" + n);
        loaded.setDisplayName("Name via entity " + n);
        userRepository.save(loaded);
        row = jdbcTemplate.queryForMap("SELECT display_name, public_slug FROM users WHERE id = ?", first.userId());
        assertThat(row.get("display_name")).isEqualTo("Name via entity " + n);
        assertThat(row.get("public_slug")).isEqualTo(base);
    }

    @Test
    void two_simultaneous_first_logins_with_the_same_base_queue_on_the_slug_lock_and_get_different_slugs()
            throws Exception {
        long n = auth.nextGithubId();
        String base = "dua-slug-" + n;
        GithubProfile a = profile(auth.nextGithubId(), "Dua-Slug-" + n);
        GithubProfile b = profile(auth.nextGithubId(), "dua-slug-" + n);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try (HeldTransaction held = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.query("SELECT pg_advisory_xact_lock(hashtext('public-slug'))", (ResultSetExtractor<Void>)
                        rs -> null))) {
            Future<UserLogin> loginA = pool.submit(() -> githubAccountService.recordLogin(a));
            Future<UserLogin> loginB = pool.submit(() -> githubAccountService.recordLogin(b));
            // Both have passed the GitHub id lock and the "does a row exist yet" query, and are waiting on exactly the
            // slug lock: nobody has picked a slug yet.
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "hashtext('public-slug')", 2);
            held.commit();
            UUID userA = loginA.get(30, TimeUnit.SECONDS).userId();
            UUID userB = loginB.get(30, TimeUnit.SECONDS).userId();
            assertThat(List.of(slugOf(userA), slugOf(userB))).containsExactlyInAnyOrder(base, base + "-2");
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void merging_reader_into_admin_on_github_link_keeps_admins_own_slug_even_on_later_github_login() {
        String email = "slug-gop-" + f.suffix + "@blog.local";
        User admin = auth.createAccount(email, UserRole.ADMIN);
        long githubId = auth.nextGithubId();
        UserLogin reader = githubAccountService.recordLogin(profile(githubId, "slug-gop-" + f.suffix));
        String readerSlug = slugOf(reader.userId());

        AdminAccountProperties properties = new Binder(new MapConfigurationPropertySource(
                        Map.of("app.admin.email", email, "app.admin.github-id", Long.toString(githubId))))
                .bind("app.admin", AdminAccountProperties.class)
                .get();
        new AdminGithubLink(properties, jdbcTemplate, refreshTokenService, transactionManager)
                .run(new DefaultApplicationArguments());

        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM users WHERE id = ?", Long.class, reader.userId()))
                .isZero();
        assertThat(slugOf(admin.getId())).isEqualTo(admin.getPublicSlug());
        UserLogin asAdmin = githubAccountService.recordLogin(profile(githubId, "slug-gop-moi-" + f.suffix));
        assertThat(asAdmin.userId()).isEqualTo(admin.getId());
        assertThat(slugOf(admin.getId())).isEqualTo(admin.getPublicSlug()).isNotEqualTo(readerSlug);
    }

    // --- GET /api/v1/users/{slug} -------------------------------------------------------------------------

    @Test
    void profile_of_reader_author_and_site_owner_has_exactly_seven_fields_and_leaks_no_email_role_id_or_status()
            throws Exception {
        long githubId = auth.nextGithubId();
        User reader = auth.createReader(githubId, "ho-so-doc-gia-" + f.suffix);
        JsonNode readerProfile = profile200(reader.getPublicSlug(), reader.getId(), null);
        assertThat(readerProfile.path("slug").asString()).isEqualTo(reader.getPublicSlug());
        assertThat(readerProfile.path("displayName").asString()).isEqualTo(reader.getDisplayName());
        assertThat(readerProfile.path("githubLogin").asString()).isEqualTo(reader.getGithubLogin());
        assertThat(readerProfile.path("avatarUrl").asString()).isEqualTo(reader.getAvatarUrl());
        assertThat(readerProfile.path("siteOwner").asBoolean()).isFalse();
        assertThat(Instant.parse(readerProfile.path("joinedAt").asString())).isEqualTo(createdAt(reader.getId()));
        assertThat(readerProfile.path("publishedPosts").asLong()).isZero();

        // An author with only a password: no login, no avatar; only PUBLISHED posts are counted.
        Reader author = f.author("ho-so-tac-gia");
        f.publishedPostBy(author.bearer(), "Profile post one");
        f.publishedPostBy(author.bearer(), "Profile post two");
        f.unpublish(f.publishedPostBy(author.bearer(), "Profile unpublished post"));
        f.archive(f.publishedPostBy(author.bearer(), "Profile archived post"));
        draftBy(author.bearer(), "Profile draft " + f.suffix);
        String authorSlug = slugOf(author.id());
        String email = jdbcTemplate.queryForObject("SELECT email FROM users WHERE id = ?", String.class, author.id());
        JsonNode authorProfile = profile200(authorSlug, author.id(), email);
        assertThat(authorProfile.path("displayName").asString()).isEqualTo(author.displayName());
        assertThat(authorProfile.path("githubLogin").isNull()).isTrue();
        assertThat(authorProfile.path("avatarUrl").isNull()).isTrue();
        assertThat(authorProfile.path("siteOwner").asBoolean()).isFalse();
        assertThat(authorProfile.path("publishedPosts").asLong()).isEqualTo(2);

        // The site owner: the seed row is shared, so the expected values are read from the DB.
        Map<String, Object> seed =
                jdbcTemplate.queryForMap("SELECT public_slug, email FROM users WHERE id = ?", SeedAdmin.ID);
        JsonNode ownerProfile = profile200((String) seed.get("public_slug"), SeedAdmin.ID, (String) seed.get("email"));
        assertThat(ownerProfile.path("siteOwner").asBoolean()).isTrue();
        assertThat(ownerProfile.path("publishedPosts").asLong())
                .isEqualTo(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM posts WHERE author_id = ? AND status = 'PUBLISHED'",
                        Long.class,
                        SeedAdmin.ID));
    }

    @Test
    void unknown_malformed_slug_and_suspended_person_give_the_same_404_USER_NOT_FOUND_and_malformed_slug_runs_no_sql()
            throws Exception {
        User suspended = auth.createReader(auth.nextGithubId(), "ho-so-bi-khoa-" + f.suffix, UserStatus.SUSPENDED);
        List<String> bodies = new ArrayList<>();
        bodies.add(notFound(USERS + "khong-co-ai-" + f.suffix));
        bodies.add(notFound(USERS + suspended.getPublicSlug()));
        for (String malformed :
                List.of("Hoa-Hong", "a--b", "-a", "a-", "a_b", IdentityViNames.O_HORN, "x".repeat(65))) {
            long statements = statementsFor(() -> bodies.add(notFound(USERS + malformed)));
            assertThat(statements)
                    .as("malformed slug '%s' never reaches the DB", malformed)
                    .isZero();
        }
        // The same body, except traceId: the asker cannot tell a suspended person from a nonexistent one.
        assertThat(bodies.stream()
                        .map(body -> body.replaceAll("\"traceId\":\"[^\"]*\"", ""))
                        .distinct())
                .hasSize(1);

        // Control: unsuspending brings the profile back, with the same old slug.
        auth.setStatus(suspended.getId(), UserStatus.ACTIVE);
        mockMvc.perform(get(USERS + suspended.getPublicSlug())).andExpect(status().isOk());
    }

    // --- GET /api/v1/posts?author= -----------------------------------------------------------------------

    @Test
    void posts_by_author_only_has_published_posts_of_that_person_newest_first_paged_and_combined_with_category()
            throws Exception {
        CommentFixtures other = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Reader author = f.author("loc-tac-gia");
        Reader someoneElse = f.author("loc-nguoi-khac");
        Post older = f.publishedPostBy(author.bearer(), "Filter older post");
        Post newer = other.publishedPostBy(author.bearer(), "Filter newer post");
        f.unpublish(f.publishedPostBy(author.bearer(), "Filter unpublished post"));
        f.archive(f.publishedPostBy(author.bearer(), "Filter archived post"));
        draftBy(author.bearer(), "Filter draft " + f.suffix);
        f.publishedPostBy(someoneElse.bearer(), "Filter someone else's post");
        String slug = slugOf(author.id());

        JsonNode page = list(get("/api/v1/posts").param("author", slug));
        assertThat(slugs(page)).containsExactly(newer.slug(), older.slug());
        assertThat(page.path("pagination").path("totalElements").asLong()).isEqualTo(2);
        for (JsonNode post : page.path("data")) {
            assertThat(post.path("status").asString()).isEqualTo("PUBLISHED");
            assertThat(post.path("author").path("profileSlug").asString()).isEqualTo(slug);
        }
        JsonNode firstPage = list(get("/api/v1/posts").param("author", slug).param("size", "1"));
        assertThat(slugs(firstPage)).containsExactly(newer.slug());
        assertThat(firstPage.path("pagination").path("totalPages").asInt()).isEqualTo(2);

        // Combined with the category (AND): an old post in f's category, a new post in other's category.
        String category = jdbcTemplate.queryForObject(
                "SELECT c.slug FROM posts p JOIN categories c " + "ON c.id = p.category_id WHERE p.id = ?",
                String.class,
                older.id());
        assertThat(slugs(list(get("/api/v1/posts").param("author", slug).param("category", category))))
                .containsExactly(older.slug());

        // popular does not go with any filter, author included.
        MockHttpServletResponse popular = mockMvc.perform(
                        get("/api/v1/posts").param("author", slug).param("sort", "popular"))
                .andReturn()
                .getResponse();
        assertThat(popular.getStatus()).isEqualTo(400);
        assertThat(objectMapper
                        .readTree(popular.getContentAsString(StandardCharsets.UTF_8))
                        .path("error")
                        .path("code")
                        .asString())
                .isEqualTo("VALIDATION_ERROR");

        // Unknown slug: an empty page. Malformed: an empty page, never reaching the DB.
        assertThat(list(get("/api/v1/posts").param("author", "khong-co-ai-" + f.suffix))
                        .path("data")
                        .size())
                .isZero();
        for (String malformed : List.of("Loc Tac Gia", "a--b", "x".repeat(65))) {
            long statements =
                    statementsFor(() -> assertThat(list(get("/api/v1/posts").param("author", malformed))
                                    .path("pagination")
                                    .path("totalElements")
                                    .asLong())
                            .isZero());
            assertThat(statements)
                    .as("malformed author '%s' never reaches the DB", malformed)
                    .isZero();
        }
    }

    // --- profileSlug in the author of posts and comments ------------------------------------------------

    @Test
    void author_of_post_and_comment_carries_profileSlug_and_is_null_for_suspended_person() throws Exception {
        Reader author = f.author("slug-bai");
        Post post = f.publishedPostBy(author.bearer(), "Post carrying the author slug");
        JsonNode detail = objectMapper.readTree(mockMvc.perform(get("/api/v1/posts/" + post.slug()))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString(StandardCharsets.UTF_8));
        assertThat(detail.path("data").path("author").path("profileSlug").asString())
                .isEqualTo(slugOf(author.id()));

        Reader reader = f.reader("slug-binh-luan");
        UUID comment = f.createdId(f.create(reader, post, "Comment with a path to the profile"));
        assertThat(commentAuthor(post, comment).path("profileSlug").asString()).isEqualTo(slugOf(reader.id()));

        // A suspended person's comment still shows, but their profile is 404: there is no path to link to.
        auth.setStatus(reader.id(), UserStatus.SUSPENDED);
        JsonNode suspendedAuthor = commentAuthor(post, comment);
        assertThat(suspendedAuthor.has("profileSlug")).isTrue();
        assertThat(suspendedAuthor.path("profileSlug").isNull()).isTrue();
        assertThat(suspendedAuthor.path("displayName").asString()).isEqualTo(reader.displayName());
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    private static GithubProfile profile(long githubId, String login) {
        return new GithubProfile(githubId, login, "Person " + login, null);
    }

    private String slugOf(UUID userId) {
        return jdbcTemplate.queryForObject("SELECT public_slug FROM users WHERE id = ?", String.class, userId);
    }

    private Instant createdAt(UUID userId) {
        return jdbcTemplate
                .queryForObject("SELECT created_at FROM users WHERE id = ?", Timestamp.class, userId)
                .toInstant();
    }

    /**
     * 200 with exactly seven fields (so no email, role, status, id or GitHub id), called anonymously; the whole body contains no
     * internal id or email anywhere. Returns {@code data}.
     */
    private JsonNode profile200(String slug, UUID id, String email) throws Exception {
        String body = mockMvc.perform(get(USERS + slug))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString(StandardCharsets.UTF_8);
        JsonNode root = objectMapper.readTree(body);
        assertThat(root.propertyNames()).containsExactly("data");
        assertThat(root.path("data").propertyNames()).containsExactlyInAnyOrderElementsOf(PROFILE_FIELDS);
        assertThat(body)
                .doesNotContain(id.toString())
                .doesNotContain("\"role\"")
                .doesNotContain("\"status\"")
                .doesNotContain("\"email\"")
                .doesNotContain("\"id\"")
                .doesNotContain("ACTIVE");
        if (email != null) {
            assertThat(body).doesNotContain(email);
        }
        return root.path("data");
    }

    private String notFound(String path) throws Exception {
        MockHttpServletResponse response =
                mockMvc.perform(get(path)).andReturn().getResponse();
        String body = response.getContentAsString(StandardCharsets.UTF_8);
        assertThat(response.getStatus()).as("%s: %s", path, body).isEqualTo(404);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .isEqualTo("USER_NOT_FOUND");
        return body;
    }

    private JsonNode list(MockHttpServletRequestBuilder request) throws Exception {
        return objectMapper.readTree(mockMvc.perform(request)
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString(StandardCharsets.UTF_8));
    }

    private static List<String> slugs(JsonNode page) {
        List<String> slugs = new ArrayList<>();
        page.path("data").forEach(post -> slugs.add(post.path("slug").asString()));
        return slugs;
    }

    /** A draft that was never published, under the token owner's name. */
    private void draftBy(String bearer, String title) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("title", title, "content", "Draft content"))))
                .andExpect(status().isCreated());
    }

    private JsonNode commentAuthor(Post post, UUID commentId) throws Exception {
        return CommentFixtures.thread(f.page(post), commentId).path("comment").path("author");
    }

    private interface Request {
        void run() throws Exception;
    }

    /** The number of SQL statements Hibernate prepares in one request, like PostReadModelIT: statistics are on only around that exact request. */
    private long statementsFor(Request request) throws Exception {
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
}
