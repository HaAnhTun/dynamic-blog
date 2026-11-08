package com.blog.author;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.RoleChangeService;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Author application invariants: who can call which path, including locked accounts and roles other than
 * USER, lives in SecurityMatrixIT; the response shape lives in OpenApiConfigIT; the rate limit lives in
 * AuthorApplicationServiceTest.
 *
 * Each test creates its own applicant and admin: the rate limits (5 submissions per hour per person, 20 role changes
 * per 10 minutes per admin) live in the memory of the shared context, and the shared DB is never cleaned.
 */
@AutoConfigureMockMvc
class AuthorApplicationIT extends AbstractIntegrationTest {

    private static final String MINE = "/api/v1/me/author-application";
    private static final String APPLICATIONS = "/api/v1/admin/author-applications";

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
    private UserRepository userRepository;

    private String suffix;

    @BeforeEach
    void setUp() {
        suffix = UUID.randomUUID().toString().substring(0, 8);
    }

    // --- V28 schema ----------------------------------------------------------------------------------------

    @Test
    void v28_schema_keeps_one_pending_application_per_person_decided_matches_status_and_motivation_max_500_chars() {
        UUID user = reader("luoc-do").getId();
        insert(user, "PENDING", null, null);
        assertThatThrownBy(() -> insert(user, "PENDING", null, null))
                .isInstanceOf(DuplicateKeyException.class)
                .hasMessageContaining("uq_author_applications_one_pending");
        // Decided applications may exist in any number.
        insert(user, "REJECTED", Instant.now(), null);
        insert(user, "APPROVED", Instant.now(), null);
        assertViolation(() -> insert(user, "REJECTED", null, null), "chk_author_applications_decided");
        assertViolation(() -> insert(user, "PENDING", Instant.now(), null), "chk_author_applications_decided");
        assertViolation(() -> insert(user, "CANCELLED", Instant.now(), null), "chk_author_applications_status");
        assertViolation(
                () -> insert(user, "REJECTED", Instant.now(), "a".repeat(501)), "chk_author_applications_motivation");

        // Deleting the decider: the application stays, the decider becomes null. Deleting the applicant: all their
        // applications go too.
        User admin = auth.createAccount("luoc-do-admin-" + suffix + "@blog.local", UserRole.ADMIN);
        UUID decided = insert(user, "REJECTED", Instant.now(), null);
        jdbcTemplate.update("UPDATE author_applications SET decided_by = ? WHERE id = ?", admin.getId(), decided);
        jdbcTemplate.update("DELETE FROM users WHERE id = ?", admin.getId());
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT decided_by FROM author_applications WHERE id = ?", UUID.class, decided))
                .isNull();
        jdbcTemplate.update("DELETE FROM users WHERE id = ?", user);
        assertThat(applicationsOf(user)).isZero();
    }

    // --- Submitting ---------------------------------------------------------------------------------------

    @Test
    void two_concurrent_submissions_by_one_person_yield_one_201_one_409_pending_and_one_pending_application()
            throws Exception {
        User applicant = reader("dong-thoi");
        String bearer = auth.bearerFor(applicant);
        List<MockHttpServletResponse> responses = new ArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        // Hold the applicant's users row: the first INSERT stops at the foreign key check, the second waits on that
        // very
        // uncommitted application at the one-pending-application index. Both passed every service check, so only the DB
        // decides who wins.
        try (HeldTransaction row = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForList("SELECT id FROM users WHERE id = ? FOR UPDATE", applicant.getId()))) {
            CountDownLatch start = new CountDownLatch(1);
            Callable<MockHttpServletResponse> submit = () -> {
                start.await();
                return apply(bearer, null);
            };
            List<Future<MockHttpServletResponse>> calls = List.of(pool.submit(submit), pool.submit(submit));
            start.countDown();
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "INSERT INTO author_applications", 2);
            row.commit();
            for (Future<MockHttpServletResponse> call : calls) {
                responses.add(call.get(30, TimeUnit.SECONDS));
            }
        } finally {
            pool.shutdownNow();
        }

        assertThat(responses).extracting(MockHttpServletResponse::getStatus).containsExactlyInAnyOrder(201, 409);
        assertError(
                responses.stream().filter(r -> r.getStatus() == 409).findFirst().orElseThrow(),
                409,
                "AUTHOR_APPLICATION_PENDING");
        assertThat(applicationsOf(applicant.getId())).isEqualTo(1);
    }

    @Test
    void motivation_is_trimmed_blank_is_null_and_max_500_chars_counted_by_code_point() throws Exception {
        // A character outside the BMP: one code point, two Java chars (like char_length in the V28 CHECK).
        String smile = Character.toString(0x1F600);
        String an = auth.bearerFor(reader("loi-ngo-an"));
        assertError(apply(an, smile.repeat(501)), 400, "VALIDATION_ERROR");
        JsonNode longest = data(expect(apply(an, "  " + smile.repeat(500) + "\n"), 201));
        assertThat(longest.path("motivation").asString()).isEqualTo(smile.repeat(500));

        JsonNode blank = data(expect(apply(auth.bearerFor(reader("loi-ngo-binh")), " \n\t "), 201));
        assertThat(blank.path("motivation").isNull()).isTrue();
    }

    @Test
    void rejected_can_only_resubmit_after_30_days_and_get_returns_only_callers_latest_application() throws Exception {
        // Five submissions, exactly the hourly limit of one person.
        String applicant = auth.bearerFor(reader("nop-lai"));
        String admin = newAdmin("nop-lai");
        UUID first = id(expect(apply(applicant, "First time"), 201));
        assertError(apply(applicant, "Second time"), 409, "AUTHOR_APPLICATION_PENDING");
        expect(decide(admin, first, "reject"), 200);

        JsonNode rejected = mine(applicant);
        assertThat(rejected.path("application").path("id").asString()).isEqualTo(first.toString());
        assertThat(rejected.path("application").path("status").asString()).isEqualTo("REJECTED");
        assertThat(rejected.path("canApply").asBoolean()).isFalse();
        assertThat(Instant.parse(rejected.path("reapplyAfter").asString()))
                .isEqualTo(decidedAt(first).plus(30, ChronoUnit.DAYS));
        assertError(apply(applicant, null), 409, "AUTHOR_APPLICATION_COOLDOWN");

        setDecidedAt(first, Instant.now().minus(29, ChronoUnit.DAYS));
        assertError(apply(applicant, null), 409, "AUTHOR_APPLICATION_COOLDOWN");
        setDecidedAt(first, Instant.now().minus(31, ChronoUnit.DAYS));
        JsonNode free = mine(applicant);
        assertThat(free.path("canApply").asBoolean()).isTrue();
        assertThat(free.path("reapplyAfter").isNull()).isTrue();
        UUID second = id(expect(apply(applicant, null), 201));

        JsonNode latest = mine(applicant);
        assertThat(latest.path("application").path("id").asString()).isEqualTo(second.toString());
        assertThat(latest.path("application").path("status").asString()).isEqualTo("PENDING");
        assertThat(latest.path("canApply").asBoolean()).isFalse();
        // No path shows this person's application to anyone else.
        JsonNode stranger = mine(auth.bearerFor(reader("nop-lai-nguoi-khac")));
        assertThat(stranger.path("application").isNull()).isTrue();
        assertThat(stranger.path("canApply").asBoolean()).isTrue();
    }

    // --- Approving and rejecting -------------------------------------------------------------------------

    @Test
    void
            approve_goes_through_role_change_service_reader_becomes_author_old_session_dies_and_second_approve_changes_nothing()
                    throws Exception {
        User applicant = reader("duyet");
        String session = auth.verifiedRefreshToken(applicant);
        UUID application = id(expect(apply(auth.bearerFor(applicant), null), 201));
        User actor = auth.createAccount("nguoi-duyet-" + suffix + "@blog.local", UserRole.ADMIN);
        String admin = auth.bearerFor(actor);

        Logger logger = (Logger) LoggerFactory.getLogger(RoleChangeService.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        try {
            JsonNode approved = data(expect(decide(admin, application, "approve"), 200));
            assertThat(approved.path("status").asString()).isEqualTo("APPROVED");
            assertThat(approved.path("applicant").path("role").asString()).isEqualTo("AUTHOR");
            JsonNode again = data(expect(decide(admin, application, "approve"), 200));
            assertThat(again.path("decidedAt").asString())
                    .isEqualTo(approved.path("decidedAt").asString());
        } finally {
            logger.detachAppender(logs);
        }

        // Exactly one role change, logged like every manual change; the decider is the admin in the token.
        assertThat(logs.list)
                .singleElement()
                .satisfies(event -> assertThat(event.getFormattedMessage())
                        .contains("actor=" + actor.getId(), "target=" + applicant.getId(), "from=USER", "to=AUTHOR"));
        assertThat(roleOf(applicant.getId())).isEqualTo("AUTHOR");
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT decided_by FROM author_applications WHERE id = ?", UUID.class, application))
                .isEqualTo(actor.getId());
        assertError(decide(admin, application, "reject"), 409, "AUTHOR_APPLICATION_DECIDED");

        // The old session dies (EXPIRED: the frontend deletes the cookie); logging in again gives a token carrying
        // AUTHOR that can enter the CMS.
        assertError(refresh(session), 401, "REFRESH_TOKEN_EXPIRED");
        String author =
                auth.bearerFor(userRepository.findById(applicant.getId()).orElseThrow());
        expect(
                mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", author))
                        .andReturn()
                        .getResponse(),
                200);
    }

    @Test
    void reject_commits_while_approve_waits_for_roster_lock_then_approve_is_409_and_promotion_rolls_back()
            throws Exception {
        User applicant = reader("dua");
        // One live session, and the access token of that very session: the count of live tokens below stays at one.
        UUID application =
                id(expect(apply("Bearer " + auth.verifiedSession(applicant).accessToken(), null), 201));
        String admin = newAdmin("dua");

        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction roster = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForObject(
                        "SELECT 1 FROM pg_advisory_xact_lock(hashtext('admin-roster'))", Integer.class))) {
            // The approval has read the PENDING application and waits for the roster lock; the rejection does not need
            // that lock, so it commits first.
            Future<MockHttpServletResponse> approval = pool.submit(() -> decide(admin, application, "approve"));
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "admin-roster", 1);
            expect(decide(admin, application, "reject"), 200);
            roster.commit();
            assertError(approval.get(30, TimeUnit.SECONDS), 409, "AUTHOR_APPLICATION_DECIDED");
        } finally {
            pool.shutdownNow();
        }

        // The promotion and its session revocation roll back together with the approval.
        assertThat(statusOf(application)).isEqualTo("REJECTED");
        assertThat(roleOf(applicant.getId())).isEqualTo("USER");
        assertThat(liveTokens(applicant.getId())).isEqualTo(1);
        // Sequentially too: a rejected application cannot be approved, and rejecting again changes nothing.
        Instant decidedAt = decidedAt(application);
        assertError(decide(admin, application, "approve"), 409, "AUTHOR_APPLICATION_DECIDED");
        expect(decide(admin, application, "reject"), 200);
        assertThat(decidedAt(application)).isEqualTo(decidedAt);
        assertThat(roleOf(applicant.getId())).isEqualTo("USER");
    }

    @Test
    void duplicate_approve_waiting_for_roster_lock_when_already_approved_elsewhere_is_200_and_does_not_promote_again()
            throws Exception {
        User applicant = reader("trung");
        // One live session, and the access token of that very session: the count of live tokens below stays at one.
        UUID application =
                id(expect(apply("Bearer " + auth.verifiedSession(applicant).accessToken(), null), 201));
        String admin = newAdmin("trung");

        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction roster = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForObject(
                        "SELECT 1 FROM pg_advisory_xact_lock(hashtext('admin-roster'))", Integer.class))) {
            Future<MockHttpServletResponse> approval = pool.submit(() -> decide(admin, application, "approve"));
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "admin-roster", 1);
            // Another admin already approved the application, then demoted the applicant to USER while this approval
            // waited for the lock.
            jdbcTemplate.update(
                    "UPDATE author_applications SET status = 'APPROVED', decided_at = now() WHERE id = ?", application);
            roster.commit();
            assertThat(approval.get(30, TimeUnit.SECONDS).getStatus()).isEqualTo(200);
        } finally {
            pool.shutdownNow();
        }
        assertThat(roleOf(applicant.getId())).isEqualTo("USER");
        assertThat(liveTokens(applicant.getId())).isEqualTo(1);
    }

    @Test
    void nobody_can_approve_their_own_application() throws Exception {
        User applicant = reader("tu-duyet");
        UUID application = id(expect(apply(auth.bearerFor(applicant), null), 201));
        // Submitted while still a reader, then made ADMIN by hand before anyone could decide.
        auth.setRole(applicant.getId(), UserRole.ADMIN);
        String self = auth.bearerFor(userRepository.findById(applicant.getId()).orElseThrow());

        assertError(decide(self, application, "approve"), 403, "FORBIDDEN");
        assertThat(statusOf(application)).isEqualTo("PENDING");
    }

    @Test
    void admin_queue_is_oldest_first_and_applicant_has_no_email() throws Exception {
        String email = "nguoi-nop-co-email-" + suffix + "@blog.local";
        UUID withEmail = auth.createAccount(email, UserRole.USER).getId();
        // createAccount sets the display name together with the email: change it, so the final check can only catch the
        // email field.
        jdbcTemplate.update("UPDATE users SET display_name = ? WHERE id = ?", "Applicant " + suffix, withEmail);
        // Back to 2001: these two applications head the queue, even though the shared DB still holds pending
        // applications of other classes.
        UUID older = insertPendingAt(withEmail, Instant.parse("2001-01-01T00:00:00Z"));
        UUID newer = insertPendingAt(reader("hang-cho").getId(), Instant.parse("2001-01-02T00:00:00Z"));

        MockHttpServletResponse response = expect(
                mockMvc.perform(get(APPLICATIONS).header("Authorization", newAdmin("hang-cho")))
                        .andReturn()
                        .getResponse(),
                200);
        JsonNode page = data(response);
        assertThat(List.of(
                        page.get(0).path("id").asString(),
                        page.get(1).path("id").asString()))
                .containsExactly(older.toString(), newer.toString());
        assertThat(page.get(0).propertyNames())
                .containsExactlyInAnyOrder("id", "status", "motivation", "createdAt", "decidedAt", "applicant");
        assertThat(page.get(0).path("applicant").propertyNames())
                .containsExactlyInAnyOrder("id", "displayName", "githubLogin", "avatarUrl", "role", "status");
        assertThat(response.getContentAsString(UTF_8)).doesNotContain(email);
    }

    // --- Helpers ------------------------------------------------------------------------------------------

    private User reader(String stem) {
        return auth.createReader(auth.nextGithubId(), stem + "-" + suffix);
    }

    private String newAdmin(String stem) {
        return auth.bearerFor(auth.createAccount(stem + "-" + suffix + "@blog.local", UserRole.ADMIN));
    }

    /** A null {@code motivation} is sent as {@code "motivation": null}. */
    private MockHttpServletResponse apply(String bearer, String motivation) throws Exception {
        return mockMvc.perform(post(MINE)
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Collections.singletonMap("motivation", motivation))))
                .andReturn()
                .getResponse();
    }

    /**
     * {@code decision} is either {@code approve} or {@code reject}. An approval carries the acting administrator's own code, which
     * it only reads when a reader is promoted (audit 111).
     */
    private MockHttpServletResponse decide(String bearer, UUID application, String decision) throws Exception {
        var request = post(APPLICATIONS + "/" + application + "/" + decision).header("Authorization", bearer);
        if (decision.equals("approve")) {
            request = request.contentType(APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(Map.of("code", auth.freshCodeForBearer(bearer))));
        }
        return mockMvc.perform(request).andReturn().getResponse();
    }

    private JsonNode mine(String bearer) throws Exception {
        return data(expect(
                mockMvc.perform(get(MINE).header("Authorization", bearer))
                        .andReturn()
                        .getResponse(),
                200));
    }

    private MockHttpServletResponse refresh(String refreshToken) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("refreshToken", refreshToken))))
                .andReturn()
                .getResponse();
    }

    /** An application written directly with SQL; {@code createdAt} keeps the DB default. */
    private UUID insert(UUID userId, String status, Instant decidedAt, String motivation) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO author_applications (id, user_id, status, decided_at, motivation)"
                        + " VALUES (?, ?, ?, ?, ?)",
                id,
                userId,
                status,
                utc(decidedAt),
                motivation);
        return id;
    }

    private UUID insertPendingAt(UUID userId, Instant createdAt) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO author_applications (id, user_id, created_at) VALUES (?, ?, ?)",
                id,
                userId,
                utc(createdAt));
        return id;
    }

    private void setDecidedAt(UUID application, Instant decidedAt) {
        assertThat(jdbcTemplate.update(
                        "UPDATE author_applications SET decided_at = ? WHERE id = ?", utc(decidedAt), application))
                .isEqualTo(1);
    }

    private Instant decidedAt(UUID application) {
        return jdbcTemplate
                .queryForObject(
                        "SELECT decided_at FROM author_applications WHERE id = ?", OffsetDateTime.class, application)
                .toInstant();
    }

    private String statusOf(UUID application) {
        return jdbcTemplate.queryForObject(
                "SELECT status FROM author_applications WHERE id = ?", String.class, application);
    }

    private long applicationsOf(UUID userId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM author_applications WHERE user_id = ?", Long.class, userId);
    }

    private String roleOf(UUID userId) {
        return jdbcTemplate.queryForObject("SELECT role FROM users WHERE id = ?", String.class, userId);
    }

    private long liveTokens(UUID userId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", Long.class, userId);
    }

    private static OffsetDateTime utc(Instant instant) {
        return instant == null ? null : OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }

    private MockHttpServletResponse expect(MockHttpServletResponse response, int status) throws Exception {
        assertThat(response.getStatus()).as(response.getContentAsString(UTF_8)).isEqualTo(status);
        return response;
    }

    private JsonNode data(MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(response.getContentAsString(UTF_8)).path("data");
    }

    private UUID id(MockHttpServletResponse response) throws Exception {
        return UUID.fromString(data(response).path("id").asString());
    }

    private void assertError(MockHttpServletResponse response, int status, String code) throws Exception {
        String body = response.getContentAsString(UTF_8);
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .as(body)
                .isEqualTo(code);
    }

    private static void assertViolation(ThrowingCallable write, String constraint) {
        assertThatThrownBy(write)
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining(constraint);
    }
}
