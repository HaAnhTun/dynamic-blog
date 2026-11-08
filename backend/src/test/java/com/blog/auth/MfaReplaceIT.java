package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.auth.dto.TokenResponse;
import com.blog.auth.mfa.MfaSecrets;
import com.blog.auth.mfa.RecoveryCodes;
import com.blog.auth.mfa.Totp;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.AuthTestSupport.EnrolledAccount;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The signed-in management of two-step verification: turning it on as an author, regenerating the recovery codes, turning it
 * off, and above all replacing the authenticator, which is the way back for a person who lost the phone but kept the recovery
 * codes: "lost phone, recovery codes saved" is a path the person can actually follow, and an administrator never passes
 * through a disabled state.
 */
@AutoConfigureMockMvc
class MfaReplaceIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mat-khau-thay-the-thiet-bi";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private AuthTestSupport auth;

    private User admin() {
        User admin = auth.createAccount("thay-thiet-bi-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(PASSWORD), admin.getId());
        return admin;
    }

    private MockHttpServletResponse call(String method, String path, TokenResponse session, Map<String, String> body)
            throws Exception {
        var request = method.equals("DELETE") ? delete(path) : post(path);
        return mockMvc.perform(request.header("Authorization", "Bearer " + session.accessToken())
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn()
                .getResponse();
    }

    private JsonNode data(MockHttpServletResponse response) throws Exception {
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        return objectMapper
                .readTree(response.getContentAsString(StandardCharsets.UTF_8))
                .path("data");
    }

    private String errorCode(MockHttpServletResponse response) throws Exception {
        return objectMapper
                .readTree(response.getContentAsString(StandardCharsets.UTF_8))
                .path("error")
                .path("code")
                .asString();
    }

    private static String codeOf(JsonNode secret, int offset) {
        byte[] bytes = MfaSecrets.decode(secret.path("secretBase32").asString()).orElseThrow();
        return Totp.code(bytes, Totp.stepOf(Instant.now()) + offset);
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    private TokenResponse tokens(JsonNode data) {
        return new TokenResponse(
                data.path("accessToken").asString(),
                data.path("refreshToken").asString(),
                data.path("expiresIn").asLong(),
                data.path("refreshExpiresIn").asLong());
    }

    // --- Lost phone, recovery codes saved ---------------------------------------------------------------------

    @Test
    void a_person_who_lost_the_phone_replaces_the_authenticator_with_two_recovery_codes_and_the_password()
            throws Exception {
        User admin = admin();
        EnrolledAccount old = auth.enroll(admin);
        List<String> oldCodes = old.recoveryCodes();

        // Sign in with a recovery code (burns one): the sign-in just set a fresh auth_time.
        MockHttpServletResponse login = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("email", admin.getEmail(), "password", PASSWORD))))
                .andReturn()
                .getResponse();
        String challenge = data202(login).path("challenge").asString();
        TokenResponse session = tokens(data(mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("challenge", challenge, "code", RecoveryCodes.format(oldCodes.get(0))))))
                .andReturn()
                .getResponse()));

        // replace/begin takes a SECOND recovery code (a TOTP code is exactly what the person no longer has) and the
        // password.
        JsonNode pending = data(call(
                "POST",
                "/api/v1/me/mfa/replace/begin",
                session,
                Map.of("code", RecoveryCodes.format(oldCodes.get(1)), "currentPassword", PASSWORD)));
        assertThat(pending.path("secretBase32").asString()).matches("[A-Z2-7]{32}");
        assertThat(pending.path("secretBase32").asString()).isNotEqualTo(old.base32());
        // The old authenticator still signs in while the replacement waits: nobody passes through a disabled state.
        assertThat(auth.loginWithSecondStep(mockMvc, admin.getEmail(), PASSWORD, old)
                        .accessToken())
                .isNotBlank();
        assertThat(count(
                        "SELECT count(*) FROM user_mfa WHERE user_id = ? AND pending_secret_cipher IS NOT NULL",
                        admin.getId()))
                .isEqualTo(1);

        // The first code of the new app confirms: one conditional swap.
        auth.resetSecondStep(admin.getId());
        MockHttpServletResponse confirmed =
                call("POST", "/api/v1/me/mfa/replace/confirm", session, Map.of("code", codeOf(pending, 0)));
        JsonNode result = data(confirmed);
        List<String> newCodes = new ArrayList<>();
        result.path("recoveryCodes").forEach(code -> newCodes.add(code.asString()));
        assertThat(newCodes).hasSize(10).doesNotContainAnyElementsOf(oldCodes);
        assertThat(count(
                        "SELECT count(*) FROM user_mfa WHERE user_id = ? AND pending_secret_cipher IS NULL",
                        admin.getId()))
                .isEqualTo(1);
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", admin.getId()))
                .isEqualTo(10);
        // Every other session is gone; the caller got a new one that works.
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", admin.getId()))
                .isEqualTo(1);
        assertThat(mockMvc.perform(get("/api/v1/me/mfa").header("Authorization", "Bearer " + session.accessToken()))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .as("the caller's old access token died with the old session")
                .isEqualTo(401);
        assertThat(mockMvc.perform(get("/api/v1/me/mfa")
                                .header(
                                        "Authorization",
                                        "Bearer " + result.path("accessToken").asString()))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(200);

        // The old secret is refused from now on, the new one signs in, and the old recovery codes are void.
        auth.resetSecondStep(admin.getId());
        String refusedChallenge = challengeOf(admin);
        assertThat(errorCode(verify(refusedChallenge, old.code()))).isEqualTo("MFA_CODE_INVALID");
        auth.resetSecondStep(admin.getId());
        assertThat(errorCode(verify(challengeOf(admin), RecoveryCodes.format(oldCodes.get(2)))))
                .isEqualTo("MFA_CODE_INVALID");
        auth.resetSecondStep(admin.getId());
        assertThat(verify(challengeOf(admin), codeOf(pending, 0)).getStatus()).isEqualTo(200);
    }

    private JsonNode data202(MockHttpServletResponse response) throws Exception {
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(202);
        return objectMapper
                .readTree(response.getContentAsString(StandardCharsets.UTF_8))
                .path("data");
    }

    private String challengeOf(User admin) throws Exception {
        return data202(mockMvc.perform(post("/api/v1/auth/login")
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(
                                        Map.of("email", admin.getEmail(), "password", PASSWORD))))
                        .andReturn()
                        .getResponse())
                .path("challenge")
                .asString();
    }

    private MockHttpServletResponse verify(String challenge, String code) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("challenge", challenge, "code", code))))
                .andReturn()
                .getResponse();
    }

    // --- The replacement itself -------------------------------------------------------------------------------

    @Test
    void the_first_code_of_the_new_app_in_the_same_step_as_the_step_up_is_not_a_replay() throws Exception {
        User admin = admin();
        EnrolledAccount old = auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);

        JsonNode pending = data(call(
                "POST",
                "/api/v1/me/mfa/replace/begin",
                session,
                Map.of("code", old.code(), "currentPassword", PASSWORD)));
        // Same 30-second step as the old app's code that opened the replacement.
        String newCode = codeOf(pending, 0);
        MockHttpServletResponse confirmed =
                call("POST", "/api/v1/me/mfa/replace/confirm", session, Map.of("code", newCode));

        assertThat(confirmed.getStatus()).as(confirmed.getContentAsString()).isEqualTo(200);
        // The new secret's counter starts at the step it consumed: the very same code again is a replay.
        assertThat(errorCode(verify(challengeOf(admin), newCode))).isEqualTo("MFA_CODE_INVALID");
    }

    @Test
    void an_abandoned_replacement_changes_nothing_and_a_second_begin_overwrites_the_pending_secret() throws Exception {
        User admin = admin();
        EnrolledAccount old = auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);

        JsonNode first = data(call(
                "POST",
                "/api/v1/me/mfa/replace/begin",
                session,
                Map.of("code", old.code(), "currentPassword", PASSWORD)));
        auth.resetSecondStep(admin.getId());
        JsonNode second = data(call(
                "POST",
                "/api/v1/me/mfa/replace/begin",
                session,
                Map.of("code", old.code(), "currentPassword", PASSWORD)));

        assertThat(second.path("secretBase32").asString())
                .isNotEqualTo(first.path("secretBase32").asString());
        // Only the newest pending secret confirms.
        MockHttpServletResponse stale =
                call("POST", "/api/v1/me/mfa/replace/confirm", session, Map.of("code", codeOf(first, 0)));
        assertThat(stale.getStatus()).isEqualTo(401);
        // And the abandoned replacement left the authenticator as it was.
        auth.resetSecondStep(admin.getId());
        assertThat(auth.loginWithSecondStep(mockMvc, admin.getEmail(), PASSWORD, old)
                        .accessToken())
                .isNotBlank();
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", admin.getId()))
                .isEqualTo(10);
    }

    @Test
    void two_parallel_confirmations_of_one_code_swap_exactly_once() throws Exception {
        User admin = admin();
        EnrolledAccount old = auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);
        JsonNode pending = data(call(
                "POST",
                "/api/v1/me/mfa/replace/begin",
                session,
                Map.of("code", old.code(), "currentPassword", PASSWORD)));
        String code = codeOf(pending, 0);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<Future<MockHttpServletResponse>> results = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                results.add(pool.submit(() -> {
                    assertThat(start.await(10, TimeUnit.SECONDS)).isTrue();
                    return call("POST", "/api/v1/me/mfa/replace/confirm", session, Map.of("code", code));
                }));
            }
            start.countDown();
            List<Integer> statuses = new ArrayList<>();
            for (Future<MockHttpServletResponse> result : results) {
                statuses.add(result.get(30, TimeUnit.SECONDS).getStatus());
            }
            assertThat(statuses).filteredOn(status -> status == 200).hasSize(1);
            assertThat(statuses).filteredOn(status -> status != 200).allMatch(status -> status == 401 || status == 409);
        } finally {
            pool.shutdownNow();
        }
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", admin.getId()))
                .isEqualTo(10);
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", admin.getId()))
                .isEqualTo(1);
    }

    @Test
    void a_github_only_administrator_proves_it_with_the_fresh_sign_in_instead_of_a_password() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "quan-tri-github-" + UUID.randomUUID());
        auth.setRole(reader.getId(), UserRole.ADMIN);
        EnrolledAccount old = auth.enroll(reader);
        TokenResponse fresh = auth.verifiedSession(reader);

        // No currentPassword: the account has none.
        MockHttpServletResponse begun = call("POST", "/api/v1/me/mfa/replace/begin", fresh, Map.of("code", old.code()));

        assertThat(begun.getStatus()).as(begun.getContentAsString()).isEqualTo(200);
        assertThat(data(begun).path("account").asString())
                .isEqualTo(jdbcTemplate.queryForObject(
                        "SELECT public_slug FROM users WHERE id = ?", String.class, reader.getId()));
    }

    @Test
    void an_account_with_a_password_must_type_it_to_replace() throws Exception {
        User admin = admin();
        EnrolledAccount old = auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);

        MockHttpServletResponse missing =
                call("POST", "/api/v1/me/mfa/replace/begin", session, Map.of("code", old.code()));
        MockHttpServletResponse wrong = call(
                "POST",
                "/api/v1/me/mfa/replace/begin",
                session,
                Map.of("code", old.code(), "currentPassword", "sai-mat-khau"));

        assertThat(errorCode(missing)).isEqualTo("INVALID_CREDENTIALS");
        assertThat(errorCode(wrong)).isEqualTo("INVALID_CREDENTIALS");
        // The password is checked before the code: no failure is counted for a code nobody looked at.
        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isZero();
    }

    @Test
    void replacing_needs_an_enrollment() throws Exception {
        User admin = admin(); // no authenticator
        TokenResponse session = auth.verifiedSession(admin);

        MockHttpServletResponse response = call(
                "POST", "/api/v1/me/mfa/replace/begin", session, Map.of("code", "123456", "currentPassword", PASSWORD));

        assertThat(response.getStatus()).isEqualTo(409);
        assertThat(errorCode(response)).isEqualTo("RESOURCE_CONFLICT");
    }

    // --- The other management calls ---------------------------------------------------------------------------

    @Test
    void recovery_codes_are_regenerated_with_a_recovery_code_and_the_old_ones_stop_working() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);

        JsonNode fresh = data(call(
                "POST",
                "/api/v1/me/mfa/recovery-codes/regenerate",
                session,
                Map.of("code", RecoveryCodes.format(mfa.recoveryCodes().getFirst()), "currentPassword", PASSWORD)));

        List<String> codes = new ArrayList<>();
        fresh.path("recoveryCodes").forEach(code -> codes.add(code.asString()));
        assertThat(codes).hasSize(10);
        assertThat(count(
                        "SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ? AND used_at IS NULL",
                        admin.getId()))
                .isEqualTo(10);
        assertThat(errorCode(verify(
                        challengeOf(admin),
                        RecoveryCodes.format(mfa.recoveryCodes().get(1)))))
                .isEqualTo("MFA_CODE_INVALID");
        auth.resetSecondStep(admin.getId());
        assertThat(verify(challengeOf(admin), codes.getFirst()).getStatus()).isEqualTo(200);
    }

    @Test
    void the_status_shows_a_count_and_never_the_codes() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);

        MockHttpServletResponse response = mockMvc.perform(
                        get("/api/v1/me/mfa").header("Authorization", "Bearer " + session.accessToken()))
                .andReturn()
                .getResponse();

        JsonNode status = data(response);
        assertThat(status.path("enrolled").asBoolean()).isTrue();
        assertThat(status.path("required").asBoolean()).isTrue();
        assertThat(status.path("recoveryCodesRemaining").asInt()).isEqualTo(10);
        assertThat(status.path("hasPassword").asBoolean()).isTrue();
        assertThat(status.path("passwordManagedByEnvironment").asBoolean()).isFalse();
        assertThat(response.getContentAsString())
                .doesNotContain(mfa.recoveryCodes().getFirst())
                .doesNotContain(mfa.base32());
    }

    @Test
    void an_administrator_cannot_turn_it_off_and_an_author_can_with_a_code() throws Exception {
        User admin = admin();
        EnrolledAccount adminMfa = auth.enroll(admin);
        MockHttpServletResponse refused =
                call("DELETE", "/api/v1/me/mfa", auth.verifiedSession(admin), Map.of("code", adminMfa.code()));
        assertThat(refused.getStatus()).isEqualTo(403);
        assertThat(errorCode(refused)).isEqualTo("MFA_REQUIRED");
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(1);

        User author = auth.createAccount("tat-hai-buoc-" + UUID.randomUUID() + "@blog.local", UserRole.AUTHOR);
        EnrolledAccount authorMfa = auth.enroll(author);
        TokenResponse session = auth.verifiedSession(author);
        Map<String, String> wrong = new LinkedHashMap<>();
        wrong.put("code", "000000".equals(authorMfa.code()) ? "111111" : "000000");
        assertThat(errorCode(call("DELETE", "/api/v1/me/mfa", session, wrong))).isEqualTo("MFA_CODE_INVALID");

        MockHttpServletResponse off = call("DELETE", "/api/v1/me/mfa", session, Map.of("code", authorMfa.code()));

        assertThat(off.getStatus()).as(off.getContentAsString()).isEqualTo(200);
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", author.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", author.getId()))
                .isZero();
        // The caller's new session works, the old one does not, and the next sign-in has no second step.
        TokenResponse next = tokens(data(off));
        assertThat(mockMvc.perform(get("/api/v1/me/mfa").header("Authorization", "Bearer " + next.accessToken()))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(200);
        assertThat(mockMvc.perform(get("/api/v1/me/mfa").header("Authorization", "Bearer " + session.accessToken()))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
        assertThat(RefreshTokenService.hash(next.refreshToken())).isNotBlank();
    }

    @Test
    void an_author_turns_it_on_and_gets_the_new_session_and_ten_recovery_codes() throws Exception {
        User author = auth.createReader(auth.nextGithubId(), "tac-gia-bat-hai-buoc-" + UUID.randomUUID());
        auth.setRole(author.getId(), UserRole.AUTHOR);
        TokenResponse older = auth.verifiedSession(author);
        TokenResponse session = auth.verifiedSession(author);

        JsonNode secret = data(call("POST", "/api/v1/me/mfa/enroll/begin", session, Map.of()));
        // Nothing changed yet.
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'ACTIVE'", author.getId()))
                .isZero();
        MockHttpServletResponse confirmed =
                call("POST", "/api/v1/me/mfa/enroll/confirm", session, Map.of("code", codeOf(secret, 0)));

        JsonNode result = data(confirmed);
        assertThat(result.path("recoveryCodes")).hasSize(10);
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'ACTIVE'", author.getId()))
                .isEqualTo(1);
        // Every older session ended, the caller's new one carries the second factor.
        assertThat(count(
                        "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", author.getId()))
                .isEqualTo(1);
        assertThat(count(
                        "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL AND mfa_verified_at IS NOT NULL",
                        author.getId()))
                .isEqualTo(1);
        assertThat(mockMvc.perform(get("/api/v1/me/mfa").header("Authorization", "Bearer " + older.accessToken()))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
        // An administrator is not enrolled this way.
        User adminUser = admin();
        assertThat(errorCode(call(
                        "POST",
                        "/api/v1/me/mfa/enroll/begin",
                        auth.verifiedSession(adminUser),
                        Map.of("currentPassword", PASSWORD))))
                .isEqualTo("FORBIDDEN");
    }
}
