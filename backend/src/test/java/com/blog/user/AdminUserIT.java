package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.service.AdminUserService;
import com.blog.user.service.RoleChangeService;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
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
 * Minimal user management for the admin: {@code GET /api/v1/admin/users} and
 * {@code PATCH /api/v1/admin/users/{id}/status}. Only reader accounts (role USER) can be suspended; suspending revokes
 * every live refresh token. What a suspended person can still do is covered in UserSuspensionIT.
 *
 * Changing roles ({@code PATCH /api/v1/admin/users/{id}/role}) is here too; who may call it lives in SecurityMatrixIT,
 * the last ADMIN in LastAdminIT (own DB), and the rate limit in AdminUserServiceTest.
 *
 * The DB is shared by the whole test suite and never cleaned: the list is always read with {@code q} set to the test's own suffix,
 * which appears in the login or name of every account the test creates.
 */
@AutoConfigureMockMvc
class AdminUserIT extends AbstractIntegrationTest {

    private static final UUID SEEDED_ADMIN = UUID.fromString("00000000-0000-0000-0000-000000000001");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private String admin;
    private String suffix;

    @BeforeEach
    void setUp() {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
    }

    // --- List ------------------------------------------------------------------------------------------

    @Test
    void list_is_newest_first_has_no_email_and_filters_by_role_status_or_searches_by_login_and_name() throws Exception {
        User an = auth.createReader(auth.nextGithubId(), "nguoi-an-" + suffix);
        User binh = auth.createReader(auth.nextGithubId(), "nguoi-binh-" + suffix, UserStatus.SUSPENDED);
        String authorEmail = "tac-gia-" + suffix + "@blog.local";
        User author = auth.createAccount(authorEmail, UserRole.AUTHOR);
        // The fixture's default name contains the email; a real name in the CMS does not.
        jdbcTemplate.update("UPDATE users SET display_name = ? WHERE id = ?", "Author " + suffix, author.getId());
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MICROS);
        setCreatedAt(an, base);
        setCreatedAt(binh, base.plusSeconds(1));
        setCreatedAt(author, base.plusSeconds(2));

        MockHttpServletResponse response =
                list("q", suffix).andExpect(status().isOk()).andReturn().getResponse();
        JsonNode body = objectMapper.readTree(response.getContentAsString());

        assertThat(ids(body)).containsExactly(author.getId(), binh.getId(), an.getId());
        assertPagination(body, 0, 20, 3, 1);
        JsonNode reader = item(body, an.getId());
        assertThat(reader.propertyNames())
                .containsExactlyInAnyOrder(
                        "id", "displayName", "githubLogin", "avatarUrl", "role", "status", "createdAt", "lastLoginAt");
        assertThat(reader.path("displayName").asString()).isEqualTo("Reader nguoi-an-" + suffix);
        assertThat(reader.path("githubLogin").asString()).isEqualTo("nguoi-an-" + suffix);
        assertThat(reader.path("avatarUrl").asString()).startsWith("https://avatars.githubusercontent.com/u/");
        assertThat(reader.path("role").asString()).isEqualTo("USER");
        assertThat(reader.path("status").asString()).isEqualTo("ACTIVE");
        assertThat(Instant.parse(reader.path("createdAt").asString())).isEqualTo(base);
        assertThat(reader.path("lastLoginAt").isNull()).isFalse();
        assertThat(item(body, binh.getId()).path("status").asString()).isEqualTo("SUSPENDED");
        JsonNode cms = item(body, author.getId());
        assertThat(cms.path("role").asString()).isEqualTo("AUTHOR");
        assertThat(cms.path("githubLogin").isNull()).isTrue();
        assertThat(cms.path("avatarUrl").isNull()).isTrue();
        assertThat(cms.path("lastLoginAt").isNull()).isTrue();
        // No email, no hash: even for a password account.
        assertThat(response.getContentAsString())
                .doesNotContain(authorEmail)
                .doesNotContain("email")
                .doesNotContain("password")
                .doesNotContain("argon2");

        assertThat(listIds("q", suffix, "role", "USER")).containsExactly(binh.getId(), an.getId());
        assertThat(listIds("q", suffix, "role", "AUTHOR")).containsExactly(author.getId());
        assertThat(listIds("q", suffix, "role", "ADMIN")).isEmpty();
        assertThat(listIds("q", suffix, "status", "SUSPENDED")).containsExactly(binh.getId());
        assertThat(listIds("q", suffix, "role", "USER", "status", "ACTIVE")).containsExactly(an.getId());
        // An empty parameter means no filter, like "All" in the UI.
        assertThat(listIds("q", suffix, "role", "", "status", "")).hasSize(3);

        // The login, typed in capitals; and the display name.
        assertThat(listIds("q", "NGUOI-AN-" + suffix.toUpperCase(Locale.ROOT))).containsExactly(an.getId());
        assertThat(listIds("q", "ader nguoi-binh-" + suffix)).containsExactly(binh.getId());
        assertThat(listIds("q", "Author " + suffix)).containsExactly(author.getId());
        // The email is not something to search by.
        assertThat(listIds("q", authorEmail)).isEmpty();

        for (String[] invalid : List.of(
                new String[] {"role", "OWNER"},
                new String[] {"role", "user"},
                new String[] {"status", "BANNED"},
                new String[] {"page", "mot"})) {
            assertError(list(invalid), 400, "VALIDATION_ERROR");
        }
    }

    @Test
    void paging_and_page_size_are_clamped_to_1_through_100() throws Exception {
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MICROS);
        List<UUID> newestFirst = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            User reader = auth.createReader(auth.nextGithubId(), "trang-" + i + "-" + suffix);
            setCreatedAt(reader, base.plusSeconds(i));
            newestFirst.addFirst(reader.getId());
        }

        JsonNode first = body(list("q", suffix, "size", "2"));
        assertThat(ids(first)).containsExactlyElementsOf(newestFirst.subList(0, 2));
        assertPagination(first, 0, 2, 3, 2);
        JsonNode second = body(list("q", suffix, "size", "2", "page", "1"));
        assertThat(ids(second)).containsExactly(newestFirst.get(2));
        assertPagination(second, 1, 2, 3, 2);

        assertPagination(body(list("q", suffix, "size", "0")), 0, 1, 3, 3);
        JsonNode capped = body(list("q", suffix, "size", "1000", "page", "-3"));
        assertPagination(capped, 0, 100, 3, 1);
        assertThat(ids(capped)).containsExactlyElementsOf(newestFirst);
    }

    // --- Suspend and unsuspend -------------------------------------------------------------------------

    @Test
    void suspending_reader_revokes_every_live_refresh_token_and_unsuspending_restores_no_session() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "bi-khoa-" + suffix);
        String live = auth.verifiedRefreshToken(reader);
        auth.verifiedRefreshToken(reader);
        String used = auth.verifiedRefreshToken(reader);
        Instant usedAt = Instant.now().minus(1, ChronoUnit.DAYS).truncatedTo(ChronoUnit.MICROS);
        jdbcTemplate.update(
                "UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?",
                OffsetDateTime.ofInstant(usedAt, ZoneOffset.UTC),
                RefreshTokenService.hash(used));
        assertThat(liveTokens(reader.getId())).isEqualTo(2);

        JsonNode suspended = data(setStatus(admin, reader.getId(), "SUSPENDED").andExpect(status().isOk()));
        assertThat(suspended.propertyNames())
                .containsExactlyInAnyOrder(
                        "id", "displayName", "githubLogin", "avatarUrl", "role", "status", "createdAt", "lastLoginAt");
        assertThat(suspended.path("id").asString()).isEqualTo(reader.getId().toString());
        assertThat(suspended.path("status").asString()).isEqualTo("SUSPENDED");
        assertThat(suspended.path("role").asString()).isEqualTo("USER");
        assertThat(statusOf(reader.getId())).isEqualTo("SUSPENDED");
        assertThat(liveTokens(reader.getId())).isZero();
        // A token revoked earlier keeps its original revocation time.
        assertThat(jdbcTemplate
                        .queryForObject(
                                "SELECT revoked_at FROM refresh_tokens WHERE token_hash = ?",
                                OffsetDateTime.class,
                                RefreshTokenService.hash(used))
                        .toInstant())
                .isEqualTo(usedAt);

        // Suspending someone who is already suspended: 200, as before.
        assertThat(data(setStatus(admin, reader.getId(), "SUSPENDED").andExpect(status().isOk()))
                        .path("status")
                        .asString())
                .isEqualTo("SUSPENDED");

        JsonNode active = data(setStatus(admin, reader.getId(), "ACTIVE").andExpect(status().isOk()));
        assertThat(active.path("status").asString()).isEqualTo("ACTIVE");
        assertThat(statusOf(reader.getId())).isEqualTo("ACTIVE");
        // Unsuspending revives no session: the person logs in again. Mass revocation also ends the token's expiry,
        // so the answer is EXPIRED (the frontend deletes the cookie), not the REVOKED of a lost token-rotation race.
        assertThat(liveTokens(reader.getId())).isZero();
        assertError(refresh(live), 401, "REFRESH_TOKEN_EXPIRED");
        data(setStatus(admin, reader.getId(), "ACTIVE").andExpect(status().isOk()));
    }

    @Test
    void suspending_and_reactivating_a_reader_is_logged_with_the_acting_administrator_and_no_email() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "ghi-nhat-ky-" + suffix);

        try (LogCapture logs = LogCapture.of(AdminUserService.class)) {
            setStatus(admin, reader.getId(), "SUSPENDED").andExpect(status().isOk());
            setStatus(admin, reader.getId(), "ACTIVE").andExpect(status().isOk());

            assertThat(logs.messages())
                    .containsExactly(
                            "user status changed actor=" + SEEDED_ADMIN + " target=" + reader.getId()
                                    + " status=SUSPENDED",
                            "user status changed actor=" + SEEDED_ADMIN + " target=" + reader.getId()
                                    + " status=ACTIVE");
        }
    }

    @Test
    void role_and_unknown_fields_in_the_body_are_ignored() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "doi-vai-" + suffix);

        String body = objectMapper.writeValueAsString(Map.of(
                "status", "SUSPENDED", "role", "ADMIN", "id", SEEDED_ADMIN.toString(), "displayName", "Impersonation"));
        JsonNode result = data(mockMvc.perform(patch("/api/v1/admin/users/" + reader.getId() + "/status")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk()));

        assertThat(result.path("id").asString()).isEqualTo(reader.getId().toString());
        assertThat(result.path("role").asString()).isEqualTo("USER");
        assertThat(result.path("displayName").asString()).isEqualTo("Reader doi-vai-" + suffix);
        Map<String, Object> row =
                jdbcTemplate.queryForMap("SELECT role, status, display_name FROM users WHERE id = ?", reader.getId());
        assertThat(row.get("role")).isEqualTo("USER");
        assertThat(row.get("status")).isEqualTo("SUSPENDED");
        assertThat(row.get("display_name")).isEqualTo("Reader doi-vai-" + suffix);
        assertThat(statusOf(SEEDED_ADMIN)).isEqualTo("ACTIVE");
    }

    @Test
    void ADMIN_AUTHOR_and_oneself_cannot_be_suspended_and_unknown_id_is_404() throws Exception {
        User otherAdmin = auth.createAccount("admin-khac-" + suffix + "@blog.local", UserRole.ADMIN);
        User author = auth.createAuthor("tac-gia-khoa-" + suffix + "@blog.local");
        auth.verifiedRefreshToken(otherAdmin);

        for (User target : List.of(otherAdmin, author)) {
            for (String requested : List.of("SUSPENDED", "ACTIVE")) {
                assertError(setStatus(admin, target.getId(), requested), 409, "USER_NOT_SUSPENDABLE");
            }
            assertThat(statusOf(target.getId())).isEqualTo("ACTIVE");
        }
        assertThat(liveTokens(otherAdmin.getId())).isEqualTo(1);

        assertError(setStatus(admin, SEEDED_ADMIN, "SUSPENDED"), 409, "USER_NOT_SUSPENDABLE");
        assertThat(statusOf(SEEDED_ADMIN)).isEqualTo("ACTIVE");

        // A token still carrying the ADMIN claim of a DB account that was demoted to USER is rejected right at the door
        // (the role is read from the DB),
        // even before the "nobody suspends themselves" check above.
        User demoted = auth.createAccount("admin-bi-ha-" + suffix + "@blog.local", UserRole.ADMIN);
        String stillAdmin = auth.bearerFor(demoted);
        auth.setRole(demoted.getId(), UserRole.USER);
        assertError(setStatus(stillAdmin, demoted.getId(), "SUSPENDED"), 403, "FORBIDDEN");
        assertThat(statusOf(demoted.getId())).isEqualTo("ACTIVE");

        UUID unknown = UUID.randomUUID();
        assertError(setStatus(admin, unknown, "SUSPENDED"), 404, "USER_NOT_FOUND");
        assertError(setStatus(admin, unknown, "ACTIVE"), 404, "USER_NOT_FOUND");
    }

    @Test
    void malformed_id_or_invalid_status_is_400_and_changes_nothing() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "sai-dang-" + suffix);

        assertError(
                mockMvc.perform(patch("/api/v1/admin/users/khong-phai-uuid/status")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"status\":\"SUSPENDED\"}")),
                400,
                "VALIDATION_ERROR");
        for (String body : List.of(
                "{\"status\":\"BANNED\"}", "{\"status\":\"suspended\"}", "{}", "{\"status\":null}", "not JSON")) {
            assertError(
                    mockMvc.perform(patch("/api/v1/admin/users/" + reader.getId() + "/status")
                            .header("Authorization", admin)
                            .contentType(APPLICATION_JSON)
                            .content(body)),
                    400,
                    "VALIDATION_ERROR");
        }

        assertThat(statusOf(reader.getId())).isEqualTo("ACTIVE");
    }

    @Test
    void only_ADMIN_can_enter_the_users_area() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "khong-quyen-" + suffix);
        String readerToken = auth.bearerFor(reader);
        String authorToken = auth.bearerFor(auth.createAuthor("khong-quyen-" + suffix + "@blog.local"));

        for (String bearer : List.of(readerToken, authorToken)) {
            assertError(mockMvc.perform(get("/api/v1/admin/users").header("Authorization", bearer)), 403, "FORBIDDEN");
            assertError(setStatus(bearer, reader.getId(), "SUSPENDED"), 403, "FORBIDDEN");
        }
        assertError(mockMvc.perform(get("/api/v1/admin/users")), 401, "UNAUTHENTICATED");
        assertError(setStatus(null, reader.getId(), "SUSPENDED"), 401, "UNAUTHENTICATED");

        assertThat(statusOf(reader.getId())).isEqualTo("ACTIVE");
    }

    // --- Changing roles ---------------------------------------------------------------------------------
    //
    // The actor is an ADMIN of the test's own: the role-change limit is counted per admin, in the memory of the shared
    // context.

    @Test
    void ADMIN_changes_USER_to_AUTHOR_then_ADMIN_then_back_to_USER_and_each_time_returns_the_account_like_the_list()
            throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "doi-vai-tro-" + suffix);
        String actor = newAdmin("doi-vai-tro");

        for (String role : List.of("AUTHOR", "ADMIN", "USER")) {
            JsonNode changed = data(setRole(actor, reader.getId(), role).andExpect(status().isOk()));
            assertThat(changed.propertyNames())
                    .containsExactlyInAnyOrder(
                            "id",
                            "displayName",
                            "githubLogin",
                            "avatarUrl",
                            "role",
                            "status",
                            "createdAt",
                            "lastLoginAt");
            assertThat(changed.path("id").asString()).isEqualTo(reader.getId().toString());
            assertThat(changed.path("role").asString()).isEqualTo(role);
            assertThat(changed.path("status").asString()).isEqualTo("ACTIVE");
            assertThat(roleOf(reader.getId())).isEqualTo(role);
        }
    }

    @Test
    void
            setting_the_current_role_again_does_nothing_while_a_real_change_revokes_sessions_and_logs_one_line_with_ids_only()
                    throws Exception {
        String email = "giu-vai-tro-" + suffix + "@blog.local";
        User author = auth.createAccount(email, UserRole.AUTHOR);
        String session = auth.verifiedRefreshToken(author);
        User actor = auth.createAccount("nguoi-doi-vai-tro-" + suffix + "@blog.local", UserRole.ADMIN);
        Logger logger = (Logger) LoggerFactory.getLogger(RoleChangeService.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        try {
            JsonNode same = data(
                    setRole(auth.bearerFor(actor), author.getId(), "AUTHOR").andExpect(status().isOk()));
            assertThat(same.path("role").asString()).isEqualTo("AUTHOR");
            assertThat(liveTokens(author.getId())).isEqualTo(1);
            assertThat(logs.list).isEmpty();

            setRole(auth.bearerFor(actor), author.getId(), "USER").andExpect(status().isOk());
        } finally {
            logger.detachAppender(logs);
        }

        assertThat(liveTokens(author.getId())).isZero();
        assertThat(logs.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.INFO);
            assertThat(event.getFormattedMessage())
                    .contains("actor=" + actor.getId(), "target=" + author.getId(), "from=AUTHOR", "to=USER")
                    .doesNotContain(email);
        });
        // The old session is dead for good: EXPIRED makes the frontend delete the cookie, the person logs in again and
        // gets a token with the new role.
        assertError(refresh(session), 401, "REFRESH_TOKEN_EXPIRED");
    }

    @Test
    void wrong_or_missing_role_and_malformed_id_is_400_unknown_id_is_404_and_nothing_changes() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "vai-tro-sai-" + suffix);
        String actor = newAdmin("vai-tro-sai");

        assertError(
                mockMvc.perform(patch("/api/v1/admin/users/khong-phai-uuid/role")
                        .header("Authorization", actor)
                        .contentType(APPLICATION_JSON)
                        .content("{\"role\":\"ADMIN\"}")),
                400,
                "VALIDATION_ERROR");
        for (String body :
                List.of("{\"role\":\"OWNER\"}", "{\"role\":\"admin\"}", "{}", "{\"role\":null}", "not JSON")) {
            assertError(
                    mockMvc.perform(patch("/api/v1/admin/users/" + reader.getId() + "/role")
                            .header("Authorization", actor)
                            .contentType(APPLICATION_JSON)
                            .content(body)),
                    400,
                    "VALIDATION_ERROR");
        }
        assertError(setRole(actor, UUID.randomUUID(), "AUTHOR"), 404, "USER_NOT_FOUND");

        assertThat(roleOf(reader.getId())).isEqualTo("USER");
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    @Test
    void suspended_account_cannot_be_given_a_role_and_only_the_site_owner_can_change_the_site_owners_role()
            throws Exception {
        String actor = newAdmin("bao-ve");
        User suspended = auth.createReader(auth.nextGithubId(), "khoa-truoc-" + suffix, UserStatus.SUSPENDED);

        assertError(setRole(actor, suspended.getId(), "AUTHOR"), 409, "ROLE_TARGET_SUSPENDED");
        assertThat(roleOf(suspended.getId())).isEqualTo("USER");

        assertError(setRole(actor, SEEDED_ADMIN, "AUTHOR"), 409, "SITE_OWNER_PROTECTED");
        assertThat(roleOf(SEEDED_ADMIN)).isEqualTo("ADMIN");
    }

    /** With the acting administrator's own code, which only the changes that ask for one read (audit 111). */
    private ResultActions setRole(String bearer, UUID userId, String role) throws Exception {
        return mockMvc.perform(patch("/api/v1/admin/users/" + userId + "/role")
                .header("Authorization", bearer)
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                        Map.of("role", role, "code", auth.freshCodeForBearer(bearer)))));
    }

    private String newAdmin(String stem) {
        return auth.bearerFor(auth.createAccount(stem + "-" + suffix + "@blog.local", UserRole.ADMIN));
    }

    private String roleOf(UUID userId) {
        return jdbcTemplate.queryForObject("SELECT role FROM users WHERE id = ?", String.class, userId);
    }

    private ResultActions refresh(String refreshToken) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/refresh")
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("refreshToken", refreshToken))));
    }

    private ResultActions list(String... params) throws Exception {
        MockHttpServletRequestBuilder request = get("/api/v1/admin/users").header("Authorization", admin);
        for (int i = 0; i < params.length; i += 2) {
            request.param(params[i], params[i + 1]);
        }
        return mockMvc.perform(request);
    }

    private List<UUID> listIds(String... params) throws Exception {
        return ids(body(list(params)));
    }

    private ResultActions setStatus(String bearer, UUID userId, String requested) throws Exception {
        MockHttpServletRequestBuilder request = patch("/api/v1/admin/users/" + userId + "/status")
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("status", requested)));
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        return mockMvc.perform(request);
    }

    private void setCreatedAt(User user, Instant createdAt) {
        assertThat(jdbcTemplate.update(
                        "UPDATE users SET created_at = ? WHERE id = ?",
                        OffsetDateTime.ofInstant(createdAt, ZoneOffset.UTC),
                        user.getId()))
                .isEqualTo(1);
    }

    private String statusOf(UUID userId) {
        return jdbcTemplate.queryForObject("SELECT status FROM users WHERE id = ?", String.class, userId);
    }

    private long liveTokens(UUID userId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", Long.class, userId);
    }

    private JsonNode body(ResultActions result) throws Exception {
        return objectMapper.readTree(
                result.andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        String content = result.andReturn().getResponse().getContentAsString();
        assertThat(result.andReturn().getResponse().getStatus()).as(content).isEqualTo(status);
        assertThat(objectMapper.readTree(content).path("error").path("code").asString())
                .as(content)
                .isEqualTo(code);
    }

    private static List<UUID> ids(JsonNode body) {
        List<UUID> ids = new ArrayList<>();
        body.path("data")
                .forEach(item -> ids.add(UUID.fromString(item.path("id").asString())));
        return ids;
    }

    private static JsonNode item(JsonNode body, UUID id) {
        for (JsonNode item : body.path("data")) {
            if (id.toString().equals(item.path("id").asString())) {
                return item;
            }
        }
        throw new AssertionError("User not found: " + id + " in the list");
    }

    private static void assertPagination(JsonNode body, int page, int size, long totalElements, int totalPages) {
        JsonNode pagination = body.path("pagination");
        assertThat(pagination.path("page").asInt()).as("page").isEqualTo(page);
        assertThat(pagination.path("size").asInt()).as("size").isEqualTo(size);
        assertThat(pagination.path("totalElements").asLong())
                .as("totalElements")
                .isEqualTo(totalElements);
        assertThat(pagination.path("totalPages").asInt()).as("totalPages").isEqualTo(totalPages);
    }
}
