package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.auth.service.MfaService;
import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.service.RoleChangeService;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

/**
 * What a change of role does to the second step. A demotion to USER deletes the enrollment and the recovery codes, so an
 * orphan cannot be enforced again by a later promotion, when the person may have lost the phone. A demotion to AUTHOR keeps
 * them (an enrolled author is enforced like an administrator). A promotion to ADMIN makes two-step verification mandatory at
 * the next sign-in: RoleChangeService already ends the sessions, so nothing else is needed.
 */
@AutoConfigureMockMvc
class MfaRoleChangeIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mat-khau-doi-vai-tro-thu-nghiem";

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

    @Autowired
    private RoleChangeService roleChangeService;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private User account(UserRole role) {
        User user = auth.createAccount("doi-vai-tro-" + UUID.randomUUID() + "@blog.local", role);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(PASSWORD), user.getId());
        return user;
    }

    /**
     * The role change as the admin API runs it, without the per-admin rate limit of that API: the whole suite shares the
     * seeded admin, and 20 changes in 10 minutes are not enough for everyone who needs one.
     */
    private void setRole(User target, UserRole role) {
        new TransactionTemplate(transactionManager)
                .executeWithoutResult(status -> roleChangeService.change(SeedAdmin.ID, target.getId(), role));
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    @Test
    void a_demotion_to_a_reader_deletes_the_enrollment_and_the_recovery_codes() throws Exception {
        User author = account(UserRole.AUTHOR);
        auth.enroll(author);

        try (LogCapture logs = LogCapture.of(MfaService.class)) {
            setRole(author, UserRole.USER);

            assertThat(logs.messages()).contains("mfa enrollment removed userId=" + author.getId() + " by=role_change");
        }
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", author.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", author.getId()))
                .isZero();
    }

    @Test
    void a_demotion_to_an_author_keeps_the_enrollment() throws Exception {
        User admin = account(UserRole.ADMIN);
        auth.enroll(admin);

        setRole(admin, UserRole.AUTHOR);

        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'ACTIVE'", admin.getId()))
                .isEqualTo(1);
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", admin.getId()))
                .isEqualTo(10);
    }

    @Test
    void a_promotion_to_admin_makes_the_next_sign_in_an_enrollment() throws Exception {
        User author = account(UserRole.AUTHOR);
        setRole(author, UserRole.ADMIN);

        MockHttpServletResponse login = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("email", author.getEmail(), "password", PASSWORD))))
                .andReturn()
                .getResponse();

        assertThat(login.getStatus()).as(login.getContentAsString()).isEqualTo(202);
        assertThat(objectMapper
                        .readTree(login.getContentAsString(StandardCharsets.UTF_8))
                        .path("data")
                        .path("purpose")
                        .asString())
                .isEqualTo("ENROLL");
    }

    @Test
    void an_enrolled_author_promoted_to_admin_loses_the_enrollment_and_enrols_again_at_the_next_sign_in()
            throws Exception {
        // Audit 111: an administrator is enrolled by the operator's rules, not with whatever authenticator an author
        // had.
        User author = account(UserRole.AUTHOR);
        auth.enroll(author);
        try (LogCapture logs = LogCapture.of(MfaService.class)) {
            setRole(author, UserRole.ADMIN);

            assertThat(logs.messages()).contains("mfa enrollment removed userId=" + author.getId() + " by=role_change");
        }
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", author.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", author.getId()))
                .isZero();

        MockHttpServletResponse login = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("email", author.getEmail(), "password", PASSWORD))))
                .andReturn()
                .getResponse();

        assertThat(login.getStatus()).as(login.getContentAsString()).isEqualTo(202);
        assertThat(objectMapper
                        .readTree(login.getContentAsString(StandardCharsets.UTF_8))
                        .path("data")
                        .path("purpose")
                        .asString())
                .isEqualTo("ENROLL");
    }
}
