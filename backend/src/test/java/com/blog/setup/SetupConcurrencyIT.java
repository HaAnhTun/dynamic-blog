package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.HeldTransaction;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * Many people with the right code at the same instant (the code leaked to a team chat, a double-clicked button): exactly
 * one claim wins and the others get 404, so the instance ends with exactly one set of owner credentials.
 *
 * The race is forced, not left to scheduling luck: a transaction holds the setup lock, every request is released, and the
 * test waits until Postgres reports all of them waiting on that lock before letting go. The pool is larger than the
 * default 10 so every request can hold its connection while waiting.
 */
@TestPropertySource(
        properties = {"app.rate-limit.setup.per-minute=100", "spring.datasource.hikari.maximum-pool-size=24"})
class SetupConcurrencyIT extends SetupIntegrationTest {

    private static final Path DATA_DIR = temporaryDirectory("setup-concurrency-it");
    private static final int REQUESTS = 12;

    @DynamicPropertySource
    static void isolated(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "setup_concurrency_it");
        registry.add("app.setup.data-dir", DATA_DIR::toString);
    }

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Test
    void parallel_claims_with_the_right_code_exactly_one_wins_and_the_others_get_404() throws Exception {
        assertThat(setupRequired()).isTrue();
        String code = readCode(DATA_DIR);

        List<MockHttpServletResponse> responses = new ArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(REQUESTS);
        try (HeldTransaction lock = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.execute("SELECT pg_advisory_xact_lock(hashtext('first-run-setup'))"))) {
            List<Future<MockHttpServletResponse>> calls = new ArrayList<>();
            for (int i = 0; i < REQUESTS; i++) {
                int n = i;
                calls.add(pool.submit(() -> setup(code, email(n), password(n), "Owner " + n)));
            }
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "first-run-setup", REQUESTS);
            lock.commit();
            for (Future<MockHttpServletResponse> call : calls) {
                responses.add(call.get(60, TimeUnit.SECONDS));
            }
        } finally {
            pool.shutdownNow();
        }

        List<Integer> statuses =
                responses.stream().map(MockHttpServletResponse::getStatus).toList();
        assertThat(statuses).filteredOn(status -> status == 201).hasSize(1);
        assertThat(statuses).filteredOn(status -> status == 404).hasSize(REQUESTS - 1);
        for (MockHttpServletResponse response : responses) {
            if (response.getStatus() == 404) {
                assertError(response, 404, "SETUP_CLOSED");
            }
        }

        // Exactly one set of credentials: the seeded row carries the winner's email, only the winner's password works.
        List<String> claimedEmails = jdbcTemplate.queryForList(
                "SELECT email FROM users WHERE email LIKE 'racer-%@example.test'", String.class);
        assertThat(claimedEmails).hasSize(1);
        String winner = claimedEmails.getFirst();
        assertThat(jdbcTemplate.queryForObject("SELECT email FROM users WHERE id = ?", String.class, SeedAdmin.ID))
                .isEqualTo(winner);
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM users WHERE role = 'ADMIN'", Long.class))
                .isEqualTo(1L);
        int winnerIndex = Integer.parseInt(winner.substring("racer-".length(), winner.indexOf('@')));
        for (int i = 0; i < REQUESTS; i++) {
            // 202: the owner is an ADMIN and the password is only the first factor.
            int expected = i == winnerIndex ? 202 : 401;
            assertThat(login(winner, password(i)).getStatus())
                    .as("password %d", i)
                    .isEqualTo(expected);
        }
        assertThat(setupRequired()).isFalse();
        assertThat(DATA_DIR.resolve("setup-code")).doesNotExist();
    }

    private static String email(int n) {
        return "racer-" + n + "@example.test";
    }

    private static String password(int n) {
        return STRONG_PASSWORD + "-" + n;
    }
}
