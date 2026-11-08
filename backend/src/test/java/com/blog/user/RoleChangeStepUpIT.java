package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.AuthTestSupport.EnrolledAccount;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

/**
 * The second proof of a role change (audit 111). Granting or taking away a privileged role is what a stolen administrator session
 * would use to leave a durable foothold, so a change to or from ADMIN, and a reader becoming an author (by hand or by approving
 * an application), needs a sign-in from the last 10 minutes AND the acting administrator's own code, like the password, the
 * authenticator and the reset of an author. Every test has an administrator of its own, enrolled with a known secret: the
 * database is shared by the suite, and one administrator's counters must not be another test's.
 */
@AutoConfigureMockMvc
class RoleChangeStepUpIT extends AbstractIntegrationTest {

    private static final String ADMIN_USERS = "/api/v1/admin/users/";
    private static final String APPLICATIONS = "/api/v1/admin/author-applications/";
    private static final long STALE_SECONDS = 11 * 60;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    /** An administrator with a known authenticator and the bearer of a session that signed in just now. */
    private record Operator(User user, EnrolledAccount mfa, String bearer) {
        String code() {
            return mfa.code();
        }
    }

    private Operator operator() {
        User admin = auth.createAccount("buoc-hai-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        EnrolledAccount mfa = auth.enroll(admin);
        return new Operator(admin, mfa, auth.bearerFor(admin));
    }

    private User account(UserRole role) {
        return auth.createAccount("doi-quyen-" + UUID.randomUUID() + "@blog.local", role);
    }

    private MockHttpServletResponse setRole(String bearer, User target, UserRole role, String code) throws Exception {
        Map<String, Object> body = new HashMap<>();
        body.put("role", role.name());
        if (code != null) {
            body.put("code", code);
        }
        return mockMvc.perform(patch(ADMIN_USERS + target.getId() + "/role")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn()
                .getResponse();
    }

    private UUID applicationOf(User reader) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO author_applications (id, user_id) VALUES (?, ?)", id, reader.getId());
        return id;
    }

    private MockHttpServletResponse approve(String bearer, UUID application, String code) throws Exception {
        var request = post(APPLICATIONS + application + "/approve").header("Authorization", bearer);
        if (code != null) {
            request = request.contentType(APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(Map.of("code", code)));
        }
        return mockMvc.perform(request).andReturn().getResponse();
    }

    private String roleOf(User user) {
        return jdbcTemplate.queryForObject("SELECT role FROM users WHERE id = ?", String.class, user.getId());
    }

    private long failedAttempts(User user) {
        return jdbcTemplate.queryForObject(
                "SELECT failed_attempts FROM user_mfa WHERE user_id = ?", Long.class, user.getId());
    }

    private long lastUsedStep(User user) {
        return jdbcTemplate.queryForObject(
                "SELECT last_used_step FROM user_mfa WHERE user_id = ?", Long.class, user.getId());
    }

    private void assertAnswer(MockHttpServletResponse response, int status, String code) throws Exception {
        String body = response.getContentAsString(StandardCharsets.UTF_8);
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        if (code != null) {
            assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                    .as(body)
                    .isEqualTo(code);
        }
    }

    // --- Which changes ask for the proof -------------------------------------------------------------------

    @ParameterizedTest(name = "{0} to {1} without a code answers MFA_CODE_INVALID and changes nothing")
    @CsvSource({"USER,AUTHOR", "USER,ADMIN", "AUTHOR,ADMIN", "ADMIN,AUTHOR", "ADMIN,USER"})
    void a_change_to_or_from_admin_or_a_reader_becoming_an_author_needs_the_code(UserRole from, UserRole to)
            throws Exception {
        Operator operator = operator();
        User target = account(from);

        // Missing, then blank: the same refusal, and nothing was guessed, so nothing is counted.
        assertAnswer(setRole(operator.bearer(), target, to, null), 401, "MFA_CODE_INVALID");
        assertAnswer(setRole(operator.bearer(), target, to, "   "), 401, "MFA_CODE_INVALID");

        assertThat(roleOf(target)).isEqualTo(from.name());
        assertThat(failedAttempts(operator.user())).isZero();
    }

    @Test
    void taking_an_author_back_to_a_reader_needs_no_code() throws Exception {
        Operator operator = operator();
        User author = account(UserRole.AUTHOR);

        assertAnswer(setRole(operator.bearer(), author, UserRole.USER, null), 200, null);

        assertThat(roleOf(author)).isEqualTo("USER");
    }

    @Test
    void a_change_to_the_role_the_account_has_needs_no_code_and_looks_at_none() throws Exception {
        Operator operator = operator();
        User admin = account(UserRole.ADMIN);
        long before = lastUsedStep(operator.user());

        assertAnswer(setRole(operator.bearer(), admin, UserRole.ADMIN, null), 200, null);
        assertAnswer(setRole(operator.bearer(), admin, UserRole.ADMIN, "000000"), 200, null);

        assertThat(failedAttempts(operator.user())).isZero();
        assertThat(lastUsedStep(operator.user())).isEqualTo(before);
    }

    // --- The proof ---------------------------------------------------------------------------------------

    @Test
    void a_wrong_code_is_refused_and_counted_and_the_change_does_not_happen() throws Exception {
        Operator operator = operator();
        User reader = account(UserRole.USER);

        assertAnswer(setRole(operator.bearer(), reader, UserRole.AUTHOR, "000000"), 401, "MFA_CODE_INVALID");

        assertThat(roleOf(reader)).isEqualTo("USER");
        // The refusal committed with its own bookkeeping: the failed attempt is on the account, so the brakes of the
        // second step
        // apply to this endpoint like to the sign-in.
        assertThat(failedAttempts(operator.user())).isEqualTo(1);
    }

    @Test
    void the_right_code_changes_the_role_and_the_same_code_cannot_be_used_twice() throws Exception {
        Operator operator = operator();
        User first = account(UserRole.USER);
        User second = account(UserRole.USER);
        String code = operator.code();

        assertAnswer(setRole(operator.bearer(), first, UserRole.AUTHOR, code), 200, null);
        assertThat(roleOf(first)).isEqualTo("AUTHOR");

        // The replay guard of the second step: a code is accepted once.
        assertAnswer(setRole(operator.bearer(), second, UserRole.AUTHOR, code), 401, "MFA_CODE_INVALID");
        assertThat(roleOf(second)).isEqualTo("USER");
    }

    @Test
    void a_recovery_code_is_accepted_as_the_proof_and_works_once() throws Exception {
        Operator operator = operator();
        User first = account(UserRole.USER);
        User second = account(UserRole.USER);
        String recovery = operator.mfa().recoveryCodes().get(0);

        assertAnswer(setRole(operator.bearer(), first, UserRole.AUTHOR, recovery), 200, null);
        assertAnswer(setRole(operator.bearer(), second, UserRole.AUTHOR, recovery), 401, "MFA_CODE_INVALID");

        assertThat(roleOf(first)).isEqualTo("AUTHOR");
        assertThat(roleOf(second)).isEqualTo("USER");
    }

    @Test
    void an_old_sign_in_is_refused_before_any_code_is_looked_at_or_counted() throws Exception {
        Operator operator = operator();
        String stale =
                auth.bearerForSessionStartedAt(operator.user(), Instant.now().minusSeconds(STALE_SECONDS));
        User reader = account(UserRole.USER);
        long before = lastUsedStep(operator.user());

        // Even a right code: the session is too old, which is checked first.
        assertAnswer(setRole(stale, reader, UserRole.AUTHOR, operator.code()), 401, "REAUTHENTICATION_REQUIRED");
        assertAnswer(setRole(stale, reader, UserRole.AUTHOR, "000000"), 401, "REAUTHENTICATION_REQUIRED");

        assertThat(roleOf(reader)).isEqualTo("USER");
        assertThat(failedAttempts(operator.user())).isZero();
        assertThat(lastUsedStep(operator.user())).isEqualTo(before);
    }

    @Test
    void an_old_sign_in_may_still_take_an_author_back_to_a_reader() throws Exception {
        Operator operator = operator();
        String stale =
                auth.bearerForSessionStartedAt(operator.user(), Instant.now().minusSeconds(STALE_SECONDS));
        User author = account(UserRole.AUTHOR);

        assertAnswer(setRole(stale, author, UserRole.USER, null), 200, null);
    }

    @Test
    void five_wrong_codes_slow_the_endpoint_down_like_the_sign_in_and_a_right_code_waits() throws Exception {
        Operator operator = operator();
        User reader = account(UserRole.USER);
        for (int i = 0; i < 5; i++) {
            assertAnswer(setRole(operator.bearer(), reader, UserRole.AUTHOR, "00000" + i), 401, "MFA_CODE_INVALID");
        }

        // The brake of the account (a delay from the fifth failure), not a new one: a correct code is refused while it
        // runs.
        assertAnswer(setRole(operator.bearer(), reader, UserRole.AUTHOR, operator.code()), 429, "MFA_RATE_LIMITED");
        assertThat(roleOf(reader)).isEqualTo("USER");
    }

    // --- Approving an application ----------------------------------------------------------------------------

    @Test
    void approving_a_readers_application_needs_the_code_and_a_recent_sign_in() throws Exception {
        Operator operator = operator();
        User reader = auth.createReader(
                auth.nextGithubId(), "don-" + UUID.randomUUID().toString().substring(0, 8));
        UUID application = applicationOf(reader);
        String stale =
                auth.bearerForSessionStartedAt(operator.user(), Instant.now().minusSeconds(STALE_SECONDS));

        assertAnswer(approve(stale, application, operator.code()), 401, "REAUTHENTICATION_REQUIRED");
        assertAnswer(approve(operator.bearer(), application, null), 401, "MFA_CODE_INVALID");
        assertAnswer(approve(operator.bearer(), application, "000000"), 401, "MFA_CODE_INVALID");
        assertThat(roleOf(reader)).isEqualTo("USER");
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT status FROM author_applications WHERE id = ?", String.class, application))
                .isEqualTo("PENDING");
        assertThat(failedAttempts(operator.user())).isEqualTo(1);

        assertAnswer(approve(operator.bearer(), application, operator.code()), 200, null);
        assertThat(roleOf(reader)).isEqualTo("AUTHOR");
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT status FROM author_applications WHERE id = ?", String.class, application))
                .isEqualTo("APPROVED");
    }

    @Test
    void approving_the_application_of_someone_who_already_has_the_role_changes_nothing_and_needs_no_code()
            throws Exception {
        Operator operator = operator();
        User author = auth.createReader(
                auth.nextGithubId(), "don-" + UUID.randomUUID().toString().substring(0, 8));
        UUID application = applicationOf(author);
        auth.setRole(author.getId(), UserRole.AUTHOR);

        assertAnswer(approve(operator.bearer(), application, null), 200, null);

        assertThat(roleOf(author)).isEqualTo("AUTHOR");
        assertThat(failedAttempts(operator.user())).isZero();
    }
}
