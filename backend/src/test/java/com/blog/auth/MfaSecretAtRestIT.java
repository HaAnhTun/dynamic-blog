package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import ch.qos.logback.classic.Level;
import com.blog.auth.mfa.MfaSecrets;
import com.blog.auth.mfa.Totp;
import com.blog.auth.service.MfaVerifier;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
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
 * The secret at rest, end to end: enrolled through the real endpoints, the database holds only AES-256-GCM ciphertext (never
 * the base32 text or the raw bytes); a row written with another key, or copied from another account, is "no usable secret"
 * (an ERROR line, the one wrong-code answer), never a 500.
 */
@AutoConfigureMockMvc
class MfaSecretAtRestIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mat-khau-bi-mat-luu-tru-thu-nghiem";

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

    private record Enrolled(User admin, byte[] secret, String base32) {}

    private User admin() {
        User admin = auth.createAccount("luu-tru-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(PASSWORD), admin.getId());
        return admin;
    }

    private JsonNode send(String path, Map<String, String> body, int expectedStatus) throws Exception {
        MockHttpServletResponse response = mockMvc.perform(
                        post(path).contentType(APPLICATION_JSON).content(objectMapper.writeValueAsString(body)))
                .andReturn()
                .getResponse();
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(expectedStatus);
        return objectMapper.readTree(response.getContentAsString(StandardCharsets.UTF_8));
    }

    /** Signs in and enrols through the endpoints a browser uses. */
    private Enrolled enrol(User admin) throws Exception {
        String challenge = send("/api/v1/auth/login", Map.of("email", admin.getEmail(), "password", PASSWORD), 202)
                .path("data")
                .path("challenge")
                .asString();
        JsonNode begun = send("/api/v1/auth/mfa/enroll/begin", Map.of("challenge", challenge), 200)
                .path("data");
        String base32 = begun.path("secretBase32").asString();
        byte[] secret = MfaSecrets.decode(base32).orElseThrow();
        send(
                "/api/v1/auth/mfa/enroll/confirm",
                Map.of("challenge", challenge, "code", Totp.code(secret, Totp.stepOf(Instant.now()))),
                200);
        return new Enrolled(admin, secret, base32);
    }

    private byte[] cipherOf(User admin) {
        return jdbcTemplate.queryForObject(
                "SELECT secret_cipher FROM user_mfa WHERE user_id = ?", byte[].class, admin.getId());
    }

    @Test
    void the_database_holds_only_ciphertext_never_the_secret_in_any_form() throws Exception {
        Enrolled enrolled = enrol(admin());

        byte[] stored = cipherOf(enrolled.admin());

        // iv (12) || ciphertext (20) || tag (16).
        assertThat(stored).hasSize(12 + 20 + 16);
        String hex = HexFormat.of().formatHex(stored);
        assertThat(hex).doesNotContain(HexFormat.of().formatHex(enrolled.secret()));
        assertThat(new String(stored, StandardCharsets.ISO_8859_1))
                .doesNotContain(enrolled.base32())
                .doesNotContain(new String(enrolled.secret(), StandardCharsets.ISO_8859_1));
        // The key fingerprint is stored (so a later rotation needs no migration) and is not the key.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT key_id FROM user_mfa WHERE user_id = ?",
                        Short.class,
                        enrolled.admin().getId()))
                .isNotNull();
    }

    @Test
    void a_row_written_with_another_key_is_no_usable_secret_not_a_server_error() throws Exception {
        Enrolled enrolled = enrol(admin());
        // What a restored dump without MFA_ENCRYPTION_KEY, or a changed key, looks like: an unknown key id.
        jdbcTemplate.update(
                "UPDATE user_mfa SET key_id = key_id + 1 WHERE user_id = ?",
                enrolled.admin().getId());
        String challenge = send(
                        "/api/v1/auth/login", Map.of("email", enrolled.admin().getEmail(), "password", PASSWORD), 202)
                .path("data")
                .path("challenge")
                .asString();

        try (LogCapture logs = LogCapture.of(MfaVerifier.class)) {
            JsonNode refusal = send(
                    "/api/v1/auth/mfa/verify",
                    Map.of("challenge", challenge, "code", Totp.code(enrolled.secret(), Totp.stepOf(Instant.now()))),
                    401);

            assertThat(refusal.path("error").path("code").asString()).isEqualTo("MFA_CODE_INVALID");
            assertThat(logs.messages(Level.ERROR))
                    .containsExactly("mfa secret undecryptable userId="
                            + enrolled.admin().getId());
        }
    }

    @Test
    void a_ciphertext_copied_to_another_account_does_not_decrypt_there() throws Exception {
        Enrolled victim = enrol(admin());
        Enrolled attacker = enrol(admin());
        // An attacker with write access to the table (or a mistaken restore) pastes the victim's ciphertext into their
        // own
        // row, hoping to log in with the victim's code: the account id is part of the authenticated data.
        jdbcTemplate.update(
                "UPDATE user_mfa SET secret_cipher = ? WHERE user_id = ?",
                cipherOf(victim.admin()),
                attacker.admin().getId());
        String challenge = send(
                        "/api/v1/auth/login", Map.of("email", attacker.admin().getEmail(), "password", PASSWORD), 202)
                .path("data")
                .path("challenge")
                .asString();

        JsonNode refusal = send(
                "/api/v1/auth/mfa/verify",
                Map.of("challenge", challenge, "code", Totp.code(victim.secret(), Totp.stepOf(Instant.now()))),
                401);

        assertThat(refusal.path("error").path("code").asString()).isEqualTo("MFA_CODE_INVALID");
    }
}
