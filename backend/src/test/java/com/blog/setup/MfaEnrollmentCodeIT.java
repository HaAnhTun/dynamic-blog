package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.auth.mfa.MfaSecrets;
import com.blog.auth.mfa.Totp;
import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import tools.jackson.databind.JsonNode;

/**
 * The operator's enrollment code in a PRODUCTION run (no opt-in to development defaults), where the enrollment window is
 * closed unless the first-run setup just opened it: the classic enrollment hijack is a stranger who holds only the password
 * enrolling an authenticator of their own first, and the code is the proof of server access that stops it.
 *
 * One journey, because each step depends on the state the previous one left: a fresh install in setup writes no second
 * code; the claim opens an hour of window; a confirmed enrollment closes it; after an operator reset the next enrollment
 * needs the code, which is created on the spot; the code is replaced when another administrator is still pending and deleted
 * when none is; a promotion to ADMIN at runtime gets a code on its first sign-in; and the code never reaches a log.
 */
@TestPropertySource(
        properties = {
            "app.allow-dev-defaults=false",
            "app.security.jwt-secret=chuoi-bi-mat-jwt-cua-cai-dat-san-xuat-thu-nghiem-0123456789",
            "app.views.token=views-token-cua-cai-dat-san-xuat-thu-nghiem",
            "app.client-ip.token=client-ip-token-of-a-production-test-not-a-real-secret",
            "app.mfa.encryption-key=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            "app.rate-limit.setup.per-minute=100"
        })
class MfaEnrollmentCodeIT extends SetupIntegrationTest {

    private static final Path DATA_DIR = temporaryDirectory("mfa-enrollment-code-it");
    private static final Path CODE_FILE = DATA_DIR.resolve("mfa-enrollment-code");
    private static final String OWNER = "owner-code@example.test";

    @DynamicPropertySource
    static void isolated(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "mfa_enrollment_code_it");
        registry.add("app.setup.data-dir", DATA_DIR::toString);
    }

    @Autowired
    private PasswordEncoder passwordEncoder;

    private MockHttpServletResponse call(String path, Map<String, String> body) throws Exception {
        return mockMvc.perform(post(path).contentType(APPLICATION_JSON).content(objectMapper.writeValueAsString(body)))
                .andReturn()
                .getResponse();
    }

    private JsonNode loginChallenge(String email, String password) throws Exception {
        MockHttpServletResponse login = login(email, password);
        assertThat(login.getStatus()).as(login.getContentAsString()).isEqualTo(202);
        return json(login).path("data");
    }

    private static String readFileCode() throws Exception {
        return Files.readString(CODE_FILE, StandardCharsets.UTF_8).strip();
    }

    private static String codeOf(JsonNode secret) {
        byte[] bytes = MfaSecrets.decode(secret.path("secretBase32").asString()).orElseThrow();
        return Totp.code(bytes, Totp.stepOf(Instant.now()));
    }

    private MockHttpServletResponse begin(String challenge, String enrollmentCode) throws Exception {
        Map<String, String> body = new java.util.LinkedHashMap<>();
        body.put("challenge", challenge);
        if (enrollmentCode != null) {
            body.put("enrollmentCode", enrollmentCode);
        }
        return call("/api/v1/auth/mfa/enroll/begin", body);
    }

    private void confirmed(String challenge, JsonNode secret) throws Exception {
        MockHttpServletResponse response =
                call("/api/v1/auth/mfa/enroll/confirm", Map.of("challenge", challenge, "code", codeOf(secret)));
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
    }

    @Test
    void the_enrollment_code_follows_the_accounts_and_never_reaches_a_log(CapturedOutput output) throws Exception {
        // A fresh install in setup: one code (the setup code), not two.
        assertThat(setupRequired()).isTrue();
        assertThat(DATA_DIR.resolve("setup-code")).isRegularFile();
        assertThat(CODE_FILE).doesNotExist();

        // The claim proves the setup code and opens an hour of window for the owner's first sign-in.
        String code = readCode(DATA_DIR);
        MockHttpServletResponse claimed = setup(code, OWNER, STRONG_PASSWORD, "Owner");
        assertThat(claimed.getStatus()).as(claimed.getContentAsString()).isEqualTo(201);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT mfa_enrollment_open_until > now() + interval '50 minutes' "
                                + "AND mfa_enrollment_open_until < now() + interval '70 minutes' FROM users WHERE id = ?",
                        Boolean.class,
                        SeedAdmin.ID))
                .isTrue();

        // First sign-in: an enrollment that asks for no code, and no code file is ever written for it.
        JsonNode first = loginChallenge(OWNER, STRONG_PASSWORD);
        assertThat(first.path("purpose").asString()).isEqualTo("ENROLL");
        assertThat(first.path("enrollmentCodeRequired").asBoolean()).isFalse();
        MockHttpServletResponse opened = begin(first.path("challenge").asString(), null);
        assertThat(opened.getStatus()).as(opened.getContentAsString()).isEqualTo(200);
        confirmed(first.path("challenge").asString(), json(opened).path("data"));
        assertThat(CODE_FILE).doesNotExist();
        // A confirmed enrollment closes the window: an operator reset afterwards needs the code.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT mfa_enrollment_open_until IS NULL FROM users WHERE id = ?",
                        Boolean.class,
                        SeedAdmin.ID))
                .isTrue();

        // The operator resets the owner's second step (the SQL fallback of docs/SECURITY.md).
        jdbcTemplate.update("DELETE FROM user_mfa WHERE user_id = ?", SeedAdmin.ID);
        jdbcTemplate.update("DELETE FROM user_mfa_recovery_code WHERE user_id = ?", SeedAdmin.ID);
        jdbcTemplate.update(
                "UPDATE refresh_tokens SET revoked_at = now(), expires_at = now() WHERE user_id = ?", SeedAdmin.ID);
        jdbcTemplate.update("UPDATE users SET tokens_valid_after = now() WHERE id = ?", SeedAdmin.ID);

        // The next sign-in is an enrollment that needs the code; the code file is created on the spot, owner-only.
        JsonNode second = loginChallenge(OWNER, STRONG_PASSWORD);
        assertThat(second.path("purpose").asString()).isEqualTo("ENROLL");
        assertThat(second.path("enrollmentCodeRequired").asBoolean()).isTrue();
        assertThat(CODE_FILE).isRegularFile();
        if (Files.getFileStore(CODE_FILE).supportsFileAttributeView("posix")) {
            assertThat(Files.getPosixFilePermissions(CODE_FILE))
                    .isEqualTo(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
        }
        String firstCode = readFileCode();
        assertThat(firstCode).matches("[A-Za-z0-9_-]{43}");
        String challenge = second.path("challenge").asString();

        // Missing and wrong give the very same refusal; each counts toward the challenge's five attempts.
        MockHttpServletResponse missing = begin(challenge, null);
        MockHttpServletResponse wrong = begin(challenge, firstCode.substring(1));
        assertError(missing, 403, "ENROLLMENT_CODE_INVALID");
        assertError(wrong, 403, "ENROLLMENT_CODE_INVALID");
        assertThat(json(missing).path("error").path("message").asString())
                .isEqualTo(json(wrong).path("error").path("message").asString());
        assertError(begin(challenge, "x".repeat(43)), 403, "ENROLLMENT_CODE_INVALID");
        assertError(begin(challenge, "y".repeat(43)), 403, "ENROLLMENT_CODE_INVALID");
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT attempts FROM mfa_challenge WHERE token_hash = ?",
                        Integer.class,
                        com.blog.auth.service.RefreshTokenService.hash(challenge)))
                .isEqualTo(4);
        // The right code still works after four wrong ones, and its attempt is given back.
        MockHttpServletResponse right = begin(challenge, "  " + firstCode + "\n");
        assertThat(right.getStatus()).as(right.getContentAsString()).isEqualTo(200);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT attempts FROM mfa_challenge WHERE token_hash = ?",
                        Integer.class,
                        com.blog.auth.service.RefreshTokenService.hash(challenge)))
                .isEqualTo(4);

        // Another administrator is pending too: the code is replaced after the first confirm, not kept.
        UUID other = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO users (id, email, password_hash, display_name, role, public_slug) "
                        + "VALUES (?, 'second-admin@example.test', ?, 'Second Admin', 'ADMIN', 'second-admin')",
                other,
                passwordEncoder.encode(STRONG_PASSWORD));
        confirmed(challenge, json(right).path("data"));
        assertThat(CODE_FILE).isRegularFile();
        String replacedCode = readFileCode();
        assertThat(replacedCode).isNotEqualTo(firstCode);

        // The first administrator's knowledge of the old code does not carry to the second; the new one does.
        JsonNode third = loginChallenge("second-admin@example.test", STRONG_PASSWORD);
        assertThat(third.path("enrollmentCodeRequired").asBoolean()).isTrue();
        assertError(begin(third.path("challenge").asString(), firstCode), 403, "ENROLLMENT_CODE_INVALID");
        MockHttpServletResponse secondBegin = begin(third.path("challenge").asString(), replacedCode);
        assertThat(secondBegin.getStatus()).as(secondBegin.getContentAsString()).isEqualTo(200);
        confirmed(third.path("challenge").asString(), json(secondBegin).path("data"));
        // No administrator is pending any more: the file is gone.
        assertThat(CODE_FILE).doesNotExist();

        // A promotion to ADMIN at runtime has no file until the next restart: the first sign-in creates it.
        UUID promoted = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO users (id, email, password_hash, display_name, role, public_slug) "
                        + "VALUES (?, 'promoted@example.test', ?, 'Promoted', 'AUTHOR', 'promoted')",
                promoted,
                passwordEncoder.encode(STRONG_PASSWORD));
        MockHttpServletResponse author = login("promoted@example.test", STRONG_PASSWORD);
        assertThat(author.getStatus())
                .as("an author without an authenticator has a plain session")
                .isEqualTo(200);
        jdbcTemplate.update("UPDATE users SET role = 'ADMIN' WHERE id = ?", promoted);
        JsonNode promotedChallenge = loginChallenge("promoted@example.test", STRONG_PASSWORD);
        assertThat(promotedChallenge.path("enrollmentCodeRequired").asBoolean()).isTrue();
        assertThat(CODE_FILE).isRegularFile();

        // The code, in none of its forms, is in the log; the path is.
        String log = output.getAll();
        assertThat(log).contains(CODE_FILE.toString());
        assertThat(log).doesNotContain(firstCode).doesNotContain(replacedCode).doesNotContain(readFileCode());
        for (String value : new String[] {STRONG_PASSWORD, OWNER, "second-admin@example.test"}) {
            assertThat(log).doesNotContain(value);
        }
    }
}
