package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;

import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.ObjectMapper;

/**
 * The invariant "there is always at least one active ADMIN", on a database of its own: the shared DB of the test suite
 * accumulates the ADMINs of every class, so "the last ADMIN" can only be measured on a DB that Flyway has just built, where at the start of each test only the seed
 * admin is ADMIN. OAuth is off, no GitHub link: not needed for this invariant.
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
            "app.search.reconcile-cron=-"
        })
class LastAdminIT {

    @DynamicPropertySource
    static void isolatedDatabase(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "last_admin_it");
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private AuthTestSupport auth;

    @BeforeEach
    void onlyTheSeedIsAnActiveAdmin() {
        // The statement below demotes every other ADMIN: on the shared DB it would break every class that runs
        // afterwards.
        assertThat(jdbcTemplate.queryForObject("SELECT current_database()", String.class))
                .isEqualTo("last_admin_it");
        jdbcTemplate.update("UPDATE users SET role = 'USER' WHERE role = 'ADMIN' AND id <> ?", SeedAdmin.ID);
        jdbcTemplate.update("UPDATE users SET role = 'ADMIN', status = 'ACTIVE' WHERE id = ?", SeedAdmin.ID);
        assertThat(activeAdmins()).containsExactly(SeedAdmin.ID);
    }

    @Test
    void last_active_ADMIN_cannot_be_demoted_and_suspended_ADMIN_is_not_counted() throws Exception {
        String seed = auth.bearerForAdmin();
        for (String role : List.of("AUTHOR", "USER")) {
            assertError(setRole(seed, SeedAdmin.ID, role), 409, "LAST_ADMIN");
        }
        // A suspended ADMIN (only SQL can make one) cannot administer the site.
        User other = auth.createAccount("last-admin-other@blog.local", UserRole.ADMIN);
        auth.setStatus(other.getId(), UserStatus.SUSPENDED);
        assertError(setRole(seed, SeedAdmin.ID, "USER"), 409, "LAST_ADMIN");
        assertThat(activeAdmins()).containsExactly(SeedAdmin.ID);

        // Control: once the other person is active again the seed can demote itself, and the other person becomes the
        // last ADMIN.
        auth.setStatus(other.getId(), UserStatus.ACTIVE);
        assertThat(setRole(seed, SeedAdmin.ID, "AUTHOR").getStatus()).isEqualTo(200);
        assertError(setRole(auth.bearerFor(other), other.getId(), "USER"), 409, "LAST_ADMIN");
        assertThat(activeAdmins()).containsExactly(other.getId());
    }

    @Test
    void two_ADMINs_demoting_themselves_together_exactly_one_succeeds_and_one_ADMIN_remains() throws Exception {
        // Two ADMINs who are not the site owner (the owner's role can only be changed by the owner), and the owner is
        // suspended so is not counted.
        User a = auth.createAccount("last-admin-a@blog.local", UserRole.ADMIN);
        User b = auth.createAccount("last-admin-b@blog.local", UserRole.ADMIN);
        auth.setStatus(SeedAdmin.ID, UserStatus.SUSPENDED);

        List<MockHttpServletResponse> responses = race(
                a,
                b,
                () -> setRole(auth.bearerFor(a), a.getId(), "USER"),
                () -> setRole(auth.bearerFor(b), b.getId(), "USER"));

        assertThat(responses).extracting(MockHttpServletResponse::getStatus).containsExactlyInAnyOrder(200, 409);
        for (MockHttpServletResponse response : responses) {
            if (response.getStatus() == 409) {
                assertError(response, 409, "LAST_ADMIN");
            }
        }
        assertThat(activeAdmins()).hasSize(1);
    }

    @Test
    void two_ADMINs_demoting_each_other_at_once_the_one_waiting_for_the_lock_has_lost_permission_and_one_ADMIN_remains()
            throws Exception {
        User a = auth.createAccount("last-admin-c@blog.local", UserRole.ADMIN);
        User b = auth.createAccount("last-admin-d@blog.local", UserRole.ADMIN);
        auth.setStatus(SeedAdmin.ID, UserStatus.SUSPENDED);

        List<MockHttpServletResponse> responses = race(
                a,
                b,
                () -> setRole(auth.bearerFor(a), b.getId(), "USER"),
                () -> setRole(auth.bearerFor(b), a.getId(), "USER"));

        // The winner demotes the other; the other's request passed the permission check at the start but is stopped
        // after the lock (403).
        assertThat(responses).extracting(MockHttpServletResponse::getStatus).containsExactlyInAnyOrder(200, 403);
        assertThat(activeAdmins()).hasSize(1);
    }

    /**
     * Locks the rows of both ADMINs so each request stops at the role UPDATE statement, after its own admin count. Without the admin-roster lock
     * both would have counted the other and both pass; with it the later request waits at that lock and recounts after the first request commits.
     */
    private List<MockHttpServletResponse> race(
            User a, User b, Callable<MockHttpServletResponse> first, Callable<MockHttpServletResponse> second)
            throws Exception {
        List<MockHttpServletResponse> responses = new ArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try (HeldTransaction rows = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForList(
                        "SELECT id FROM users WHERE id IN (?, ?) FOR UPDATE", a.getId(), b.getId()))) {
            List<Future<MockHttpServletResponse>> calls = List.of(pool.submit(first), pool.submit(second));
            // An empty SQL fragment matches every statement: this DB only has the test's requests, so waiting at any
            // lock is fine.
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "", 2);
            rows.commit();
            for (Future<MockHttpServletResponse> call : calls) {
                responses.add(call.get(30, TimeUnit.SECONDS));
            }
        } finally {
            pool.shutdownNow();
        }
        return responses;
    }

    private MockHttpServletResponse setRole(String bearer, UUID userId, String role) throws Exception {
        return mockMvc.perform(patch("/api/v1/admin/users/" + userId + "/role")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("role", role, "code", auth.freshCodeForBearer(bearer)))))
                .andReturn()
                .getResponse();
    }

    private List<UUID> activeAdmins() {
        return jdbcTemplate.queryForList("SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'", UUID.class);
    }

    private void assertError(MockHttpServletResponse response, int status, String code) throws Exception {
        String body = response.getContentAsString(StandardCharsets.UTF_8);
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .as(body)
                .isEqualTo(code);
    }
}
