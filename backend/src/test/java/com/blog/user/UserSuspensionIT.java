package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.GithubLoginFlow;
import com.blog.support.GithubStub;
import com.blog.user.repository.UserRepository;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Suspending a reader through the admin API, seen from the suspended person's side: every session is revoked, refresh
 * and {@code /auth/me} get 403, and every write is blocked even with a still-valid access token (a write reads the status in the
 * DB, it does not trust the token). Public reads still work and do not check the account status, so until the old access token expires,
 * {@code mine} and {@code liked} still follow that token. After unsuspending, logging in again works.
 *
 * The reader logs in through the real GitHub flow with GithubStub, so there is a real refresh token as in production.
 */
@AutoConfigureMockMvc
class UserSuspensionIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthTestSupport auth;

    private CommentFixtures f;
    private GithubLoginFlow flow;
    private String admin;

    @BeforeEach
    void setUp() {
        GITHUB.reset();
        flow = new GithubLoginFlow(mockMvc, GITHUB);
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        admin = auth.bearerForAdmin();
    }

    @AfterEach
    void resetStub() {
        GITHUB.reset();
    }

    @Test
    void suspension_revokes_every_session_so_refresh_and_login_again_both_get_403() throws Exception {
        Account account = account("khoa-phien");
        Session phone = login(account);
        Session laptop = login(account);
        assertThat(liveTokens(account)).isEqualTo(2);

        JsonNode suspended = f.data(setStatus(account, "SUSPENDED").andExpect(status().isOk()));
        assertThat(suspended.path("status").asString()).isEqualTo("SUSPENDED");
        assertThat(liveTokens(account)).isZero();

        for (Session session : new Session[] {phone, laptop}) {
            f.assertError(refresh(session.refreshToken()), 403, "USER_SUSPENDED");
        }
        // Logging in with GitHub again cannot open a new session either.
        f.assertError(flow.login(account.profile()).getResponse(), 403, "USER_SUSPENDED");
        assertThat(liveTokens(account)).isZero();
    }

    @Test
    void suspension_revokes_the_access_token_already_issued() throws Exception {
        Account account = account("khoa-thu-hoi");
        Reader reader = login(account).reader();
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", reader.bearer()))
                .andExpect(status().isOk());

        setStatus(account, "SUSPENDED").andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", reader.bearer()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void valid_access_token_of_suspended_person_cannot_write_anything_but_can_still_read() throws Exception {
        Post post = f.publishedPost("Suspended person");
        Account account = account("khoa-ghi");
        Reader loggedIn = login(account).reader();
        UUID own = f.createdId(f.create(loggedIn, post, "Written before suspension"));
        UUID other = f.createdId(f.create(f.reader("khac"), post, "Comment from someone else"));
        like(loggedIn, post, "PUT").andExpect(status().isOk());
        bookmark(loggedIn, post.slug(), "PUT").andExpect(status().isOk());

        setStatus(account, "SUSPENDED").andExpect(status().isOk());
        // Suspending also revokes the access tokens issued so far (tokens_valid_after) and ends their sessions: see
        // suspension_revokes_the_access_token_already_issued. A token minted after the suspension stands for one the
        // filter still accepts, to keep proving that the write guards themselves refuse a suspended person.
        Reader reader = new Reader(
                loggedIn.id(),
                auth.bearerFor(userRepository.findById(loggedIn.id()).orElseThrow()),
                loggedIn.login(),
                loggedIn.displayName());

        // The access token is still valid and the filter still accepts it, but every write reads the status in the DB.
        f.assertError(
                mockMvc.perform(get("/api/v1/auth/me").header("Authorization", reader.bearer())),
                403,
                "USER_SUSPENDED");
        f.assertError(f.create(reader, post, "Written after suspension"), 403, "USER_SUSPENDED");
        f.assertError(f.reply(reader, other, "Reply after suspension"), 403, "USER_SUSPENDED");
        f.assertError(f.edit(reader, own, "Edit after suspension"), 403, "USER_SUSPENDED");
        f.assertError(f.remove(reader, own), 403, "USER_SUSPENDED");
        f.assertError(like(reader, post, "PUT"), 403, "USER_SUSPENDED");
        f.assertError(like(reader, post, "DELETE"), 403, "USER_SUSPENDED");
        // The suspension check runs before everything else, so even a nonexistent post is 403, not 404.
        f.assertError(
                mockMvc.perform(put("/api/v1/posts/khong-co-bai-nay-" + f.suffix + "/like")
                        .header("Authorization", reader.bearer())),
                403,
                "USER_SUSPENDED");
        // Bookmarks are private data of the account, like the notification inbox: even reading is 403, even for a
        // nonexistent post.
        f.assertError(
                mockMvc.perform(get("/api/v1/me/bookmarks").header("Authorization", reader.bearer())),
                403,
                "USER_SUSPENDED");
        for (String method : List.of("GET", "PUT", "DELETE")) {
            f.assertError(bookmark(reader, post.slug(), method), 403, "USER_SUSPENDED");
            f.assertError(bookmark(reader, "khong-co-bai-nay-" + f.suffix, method), 403, "USER_SUSPENDED");
        }

        // None of the calls above changed anything.
        assertThat(f.countComments("user_id = ?", account.userId())).isEqualTo(1);
        assertThat(f.row(own).get("content")).isEqualTo("Written before suspension");
        assertThat(f.row(own).get("status")).isEqualTo("VISIBLE");
        assertThat(f.countComments("parent_id = ?", other)).isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM post_likes WHERE post_id = ? AND user_id = ?",
                        Long.class,
                        post.id(),
                        account.userId()))
                .isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM post_bookmarks WHERE post_id = ? AND user_id = ?",
                        Long.class,
                        post.id(),
                        account.userId()))
                .isEqualTo(1);

        // Public reads do not check the account status (no extra SQL statement on each read): still readable, and
        // until the old access token expires, mine and liked still follow that token as for any logged-in reader.
        JsonNode page = f.data(f.list(post, reader.bearer()).andExpect(status().isOk()));
        assertThat(CommentFixtures.rootIds(page)).containsExactly(own, other);
        assertThat(CommentFixtures.thread(page, own)
                        .path("comment")
                        .path("mine")
                        .asBoolean())
                .isTrue();
        assertThat(CommentFixtures.thread(page, other)
                        .path("comment")
                        .path("mine")
                        .asBoolean())
                .isFalse();
        JsonNode likes = f.data(like(reader, post, "GET").andExpect(status().isOk()));
        assertThat(likes.path("liked").asBoolean()).isTrue();
        assertThat(likes.path("count").asLong()).isEqualTo(1);
    }

    @Test
    void unsuspending_then_logging_in_again_works_as_before_and_old_session_does_not_revive() throws Exception {
        Post post = f.publishedPost("Unsuspended reader");
        Account account = account("mo-khoa");
        Session before = login(account);
        setStatus(account, "SUSPENDED").andExpect(status().isOk());

        JsonNode active = f.data(setStatus(account, "ACTIVE").andExpect(status().isOk()));
        assertThat(active.path("status").asString()).isEqualTo("ACTIVE");
        // Suspension revokes in bulk and also ends the token's expiry: EXPIRED, the answer that makes the frontend
        // delete the cookie.
        f.assertError(refresh(before.refreshToken()), 401, "REFRESH_TOKEN_EXPIRED");

        Session after = login(account);
        JsonNode me = f.data(mockMvc.perform(get("/api/v1/auth/me")
                        .header("Authorization", after.reader().bearer()))
                .andExpect(status().isOk()));
        assertThat(me.path("status").asString()).isEqualTo("ACTIVE");
        assertThat(me.path("githubLogin").asString()).isEqualTo(account.login());
        f.createdId(f.create(after.reader(), post, "Unsuspended now"));
        JsonNode liked = f.data(like(after.reader(), post, "PUT").andExpect(status().isOk()));
        assertThat(liked.path("liked").asBoolean()).isTrue();
        assertThat(liked.path("count").asLong()).isEqualTo(1);
        refresh(after.refreshToken()).andExpect(status().isOk());
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    /** A GitHub account (on GithubStub) that has never logged in; {@code userId} exists after the first login. */
    private record Account(long githubId, String login, Map<String, Object> profile, JdbcTemplate jdbc) {

        UUID userId() {
            return jdbc.queryForObject("SELECT id FROM users WHERE github_id = ?", UUID.class, githubId);
        }
    }

    /** One login session: the pair of tokens that the GitHub login returns. */
    private record Session(UUID userId, String accessToken, String refreshToken, String login) {

        Reader reader() {
            return new Reader(userId, "Bearer " + accessToken, login, null);
        }
    }

    private Account account(String stem) {
        long githubId = auth.nextGithubId();
        String login = stem + "-" + f.suffix;
        return new Account(githubId, login, GithubStub.profile(githubId, login, "Suspended " + f.suffix), jdbcTemplate);
    }

    private Session login(Account account) throws Exception {
        MockHttpServletResponse response = flow.login(account.profile()).getResponse();
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        JsonNode tokens = objectMapper.readTree(response.getContentAsString()).path("data");
        return new Session(
                account.userId(),
                tokens.path("accessToken").asString(),
                tokens.path("refreshToken").asString(),
                account.login());
    }

    private ResultActions setStatus(Account account, String requested) throws Exception {
        return mockMvc.perform(patch("/api/v1/admin/users/" + account.userId() + "/status")
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("status", requested))));
    }

    private ResultActions refresh(String refreshToken) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/refresh")
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("refreshToken", refreshToken))));
    }

    /** The likes of a post: {@code GET}, {@code PUT} (like) or {@code DELETE} (unlike). */
    private ResultActions like(Reader reader, Post post, String method) throws Exception {
        String path = "/api/v1/posts/" + post.slug() + "/like";
        MockHttpServletRequestBuilder request = switch (method) {
            case "PUT" -> put(path);
            case "DELETE" -> delete(path);
            default -> get(path);
        };
        return mockMvc.perform(request.header("Authorization", reader.bearer()));
    }

    /** The bookmark of a post: {@code GET} (status), {@code PUT} (save) or {@code DELETE} (unsave). */
    private ResultActions bookmark(Reader reader, String slug, String method) throws Exception {
        String path = "/api/v1/me/bookmarks/" + slug;
        MockHttpServletRequestBuilder request = switch (method) {
            case "PUT" -> put(path);
            case "DELETE" -> delete(path);
            default -> get(path);
        };
        return mockMvc.perform(request.header("Authorization", reader.bearer()));
    }

    private long liveTokens(Account account) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL",
                Long.class,
                account.userId());
    }
}
