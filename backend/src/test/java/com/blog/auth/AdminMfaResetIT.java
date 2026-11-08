package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.MfaService;
import com.blog.auth.service.MfaVerifier;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.AuthTestSupport.EnrolledAccount;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

/**
 * An administrator resets the two-step verification of an AUTHOR who lost the device and the codes. It needs the
 * administrator's own code and a recent sign-in, never works on another administrator (that is the server owner's job), and
 * ends the author's sessions without touching the administrator's own.
 */
@AutoConfigureMockMvc
class AdminMfaResetIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private User account(UserRole role) {
        return auth.createAccount("dat-lai-" + UUID.randomUUID() + "@blog.local", role);
    }

    private MockHttpServletResponse reset(TokenResponse session, UUID target, String code) throws Exception {
        return mockMvc.perform(post("/api/v1/admin/users/" + target + "/mfa/reset")
                        .header("Authorization", "Bearer " + session.accessToken())
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("code", code))))
                .andReturn()
                .getResponse();
    }

    private String errorCode(MockHttpServletResponse response) throws Exception {
        return objectMapper
                .readTree(response.getContentAsString(StandardCharsets.UTF_8))
                .path("error")
                .path("code")
                .asString();
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    @Test
    void an_administrator_resets_an_author_with_their_own_code_and_the_authors_sessions_end() throws Exception {
        User admin = account(UserRole.ADMIN);
        EnrolledAccount adminMfa = auth.enroll(admin);
        TokenResponse adminSession = auth.verifiedSession(admin);
        User author = account(UserRole.AUTHOR);
        auth.enroll(author);
        TokenResponse authorSession = auth.verifiedSession(author);

        try (LogCapture logs = LogCapture.of(MfaService.class, MfaVerifier.class)) {
            MockHttpServletResponse response = reset(adminSession, author.getId(), adminMfa.code());

            assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(204);
            // One line for the removal, and it names the administrator who did it besides the author: with more than
            // one
            // administrator the log could not tell them apart before.
            assertThat(logs.messages().stream()
                            .filter(message -> message.startsWith("mfa enrollment removed"))
                            .toList())
                    .containsExactly(
                            "mfa enrollment removed userId=" + author.getId() + " by=admin actorId=" + admin.getId());
            // The administrator's own step-up is on record too, with what it was for and no code.
            assertThat(logs.messages())
                    .contains("mfa step-up ok userId=" + admin.getId() + " purpose=reset_author method=totp");
            logs.assertNeverLogged(adminMfa.code(), author.getEmail(), admin.getEmail());
        }
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", author.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", author.getId()))
                .isZero();
        // The author's sessions are gone...
        assertThat(mockMvc.perform(
                                get("/api/v1/auth/me").header("Authorization", "Bearer " + authorSession.accessToken()))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
        assertThat(count(
                        "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", author.getId()))
                .isZero();
        // ...and the administrator's own is untouched.
        assertThat(mockMvc.perform(
                                get("/api/v1/auth/me").header("Authorization", "Bearer " + adminSession.accessToken()))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(200);
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", admin.getId()))
                .isEqualTo(1);
    }

    @Test
    void the_administrators_own_code_is_required_and_a_wrong_one_counts_against_the_administrator() throws Exception {
        User admin = account(UserRole.ADMIN);
        EnrolledAccount adminMfa = auth.enroll(admin);
        TokenResponse adminSession = auth.verifiedSession(admin);
        User author = account(UserRole.AUTHOR);
        auth.enroll(author);

        MockHttpServletResponse refused =
                reset(adminSession, author.getId(), "000000".equals(adminMfa.code()) ? "111111" : "000000");

        assertThat(refused.getStatus()).isEqualTo(401);
        assertThat(errorCode(refused)).isEqualTo("MFA_CODE_INVALID");
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", author.getId()))
                .isEqualTo(1);
        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(1);
    }

    @Test
    void an_administrators_second_step_cannot_be_reset_here() throws Exception {
        User admin = account(UserRole.ADMIN);
        EnrolledAccount adminMfa = auth.enroll(admin);
        TokenResponse adminSession = auth.verifiedSession(admin);
        User otherAdmin = account(UserRole.ADMIN);
        auth.enroll(otherAdmin);

        MockHttpServletResponse response = reset(adminSession, otherAdmin.getId(), adminMfa.code());

        assertThat(response.getStatus()).isEqualTo(403);
        assertThat(errorCode(response)).isEqualTo("FORBIDDEN");
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", otherAdmin.getId()))
                .isEqualTo(1);
    }

    @Test
    void a_reader_or_an_unknown_account_is_not_found() throws Exception {
        User admin = account(UserRole.ADMIN);
        EnrolledAccount adminMfa = auth.enroll(admin);
        TokenResponse adminSession = auth.verifiedSession(admin);
        User reader = auth.createReader(auth.nextGithubId(), "doc-gia-" + UUID.randomUUID());

        assertThat(errorCode(reset(adminSession, reader.getId(), adminMfa.code())))
                .isEqualTo("USER_NOT_FOUND");
        auth.resetSecondStep(admin.getId());
        assertThat(errorCode(reset(adminSession, UUID.randomUUID(), adminMfa.code())))
                .isEqualTo("USER_NOT_FOUND");
    }

    @Test
    void an_author_cannot_call_it_and_the_administrator_needs_a_recent_sign_in() throws Exception {
        User author = account(UserRole.AUTHOR);
        EnrolledAccount authorMfa = auth.enroll(author);
        User target = account(UserRole.AUTHOR);
        auth.enroll(target);

        MockHttpServletResponse byAuthor = reset(auth.verifiedSession(author), target.getId(), authorMfa.code());
        assertThat(byAuthor.getStatus()).isEqualTo(403);
        assertThat(errorCode(byAuthor)).isEqualTo("FORBIDDEN");

        User admin = account(UserRole.ADMIN);
        EnrolledAccount adminMfa = auth.enroll(admin);
        TokenResponse stale = auth.verifiedSessionStartedAt(admin, Instant.now().minusSeconds(11 * 60));
        MockHttpServletResponse tooOld = reset(stale, target.getId(), adminMfa.code());
        assertThat(tooOld.getStatus()).isEqualTo(401);
        assertThat(errorCode(tooOld)).isEqualTo("REAUTHENTICATION_REQUIRED");
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", target.getId()))
                .isEqualTo(1);
    }
}
