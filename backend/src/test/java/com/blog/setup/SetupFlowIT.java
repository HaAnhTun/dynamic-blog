package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.common.security.SeedAdmin;
import com.blog.setup.service.SetupAccounts;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.repository.UserRepository;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
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

/**
 * The whole first-run journey on a fresh install with a generated setup code: the instance starts claimable, the README
 * password does not open it, wrong codes all get the same 403, the right code claims the seeded admin row exactly once,
 * and the code never shows up in a response or a log line. One test, because each step depends on the state the
 * previous one left (setup can only complete once per database).
 */
@TestPropertySource(properties = "app.rate-limit.setup.per-minute=100")
class SetupFlowIT extends SetupIntegrationTest {

    private static final Path DATA_DIR = temporaryDirectory("setup-flow-it");
    private static final String OWNER_EMAIL = "owner@example.test";

    @DynamicPropertySource
    static void isolated(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "setup_flow_it");
        registry.add("app.setup.data-dir", DATA_DIR::toString);
    }

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private UserRepository userRepository;

    @Test
    void a_fresh_install_is_claimed_once_with_the_setup_code_which_never_leaks(CapturedOutput output) throws Exception {
        List<MockHttpServletResponse> responses = new ArrayList<>();
        Path codeFile = DATA_DIR.resolve("setup-code");

        // Fresh install: setup required, the code file exists, and the startup log names its path, not its value.
        assertThat(setupRequired()).isTrue();
        assertThat(codeFile).isRegularFile();
        String code = readCode(DATA_DIR);
        assertThat(code).matches("[A-Za-z0-9_-]{43}");
        if (Files.getFileStore(codeFile).supportsFileAttributeView("posix")) {
            assertThat(Files.getPosixFilePermissions(codeFile))
                    .isEqualTo(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
        }
        assertThat(output.getAll()).contains(codeFile.toString());

        // The development password printed in the README no longer opens the seeded admin.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT password_hash FROM users WHERE id = ?", String.class, SeedAdmin.ID))
                .isEqualTo(SetupAccounts.UNUSABLE_PASSWORD_HASH);
        MockHttpServletResponse devLogin = login(SeedAdmin.EMAIL, SeedAdmin.DEV_PASSWORD);
        responses.add(devLogin);
        assertError(devLogin, 401, "INVALID_CREDENTIALS");

        // Every wrong or missing code gets the very same answer.
        List<String> messages = new ArrayList<>();
        String nearMiss = code.substring(0, code.length() - 1) + (code.endsWith("A") ? "B" : "A");
        for (String wrong : new String[] {null, "", "wrong-code", nearMiss, code + "x", SeedAdmin.DEV_PASSWORD}) {
            MockHttpServletResponse response = setup(wrong, OWNER_EMAIL, STRONG_PASSWORD, "Site Owner");
            responses.add(response);
            assertError(response, 403, "SETUP_CODE_INVALID");
            messages.add(json(response).path("error").path("message").asString());
        }
        assertThat(messages).containsOnly(messages.getFirst());
        MockHttpServletResponse noBody = mockMvc.perform(post("/api/v1/setup").contentType(APPLICATION_JSON))
                .andReturn()
                .getResponse();
        responses.add(noBody);
        assertError(noBody, 403, "SETUP_CODE_INVALID");

        // With the right code, the form is checked: nothing is claimed by an invalid request.
        jdbcTemplate.update(
                "INSERT INTO users (id, email, password_hash, display_name, role, public_slug) "
                        + "VALUES (?, 'taken@example.test', 'x', 'Someone Else', 'AUTHOR', 'someone-else')",
                UUID.randomUUID());
        for (MockHttpServletResponse invalid : List.of(
                setup(code, OWNER_EMAIL, "short", "Site Owner"),
                setup(code, OWNER_EMAIL, "x".repeat(129), "Site Owner"),
                setup(code, "not-an-email", STRONG_PASSWORD, "Site Owner"),
                setup(code, OWNER_EMAIL, STRONG_PASSWORD, " "),
                setup(code, OWNER_EMAIL, STRONG_PASSWORD, "x".repeat(61)),
                setup(code, "TAKEN@example.test", STRONG_PASSWORD, "Site Owner"))) {
            responses.add(invalid);
            assertError(invalid, 400, "VALIDATION_ERROR");
        }
        // The password policy (PasswordPolicy): long enough is not enough. A common word with digits, the same in other
        // case, and a password built around the email's local part are refused with one message that names neither
        // the value nor the rule behind it.
        List<String> weakMessages = new ArrayList<>();
        for (String weak : List.of("password1234", "PassWord1234", "welcome12345", "owner-owner-owner")) {
            MockHttpServletResponse refused = setup(code, OWNER_EMAIL, weak, "Site Owner");
            responses.add(refused);
            assertError(refused, 400, "VALIDATION_ERROR");
            String message = json(refused).path("error").path("message").asString();
            assertThat(message).doesNotContain(weak);
            weakMessages.add(message);
        }
        assertThat(weakMessages).containsOnly("password: is too common or too easy to guess");
        assertThat(setupRequired()).isTrue();
        assertThat(codeFile).exists();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT password_hash FROM users WHERE id = ?", String.class, SeedAdmin.ID))
                .isEqualTo(SetupAccounts.UNUSABLE_PASSWORD_HASH);

        // The claim: 201, no token, the seeded row keeps its id and gets the owner's credentials.
        long accounts = jdbcTemplate.queryForObject("SELECT count(*) FROM users", Long.class);
        jdbcTemplate.update(
                "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, 'flow-it-seed-token', "
                        + "now() + interval '1 day')",
                SeedAdmin.ID);
        // An access token of the seeded admin issued before the claim (for instance with the development password
        // while the lock was off) is valid now and must be dead once the instance has a new owner. The cut-off the
        // startup lock may have set is cleared first, so the token below is valid whatever the clock says.
        jdbcTemplate.update("UPDATE users SET tokens_valid_after = NULL WHERE id = ?", SeedAdmin.ID);
        String beforeTheClaim = auth.bearerIssuedAt(
                userRepository.findById(SeedAdmin.ID).orElseThrow(),
                Instant.now().minusSeconds(30));
        assertThat(me(beforeTheClaim).getStatus()).isEqualTo(200);
        MockHttpServletResponse claimed = setup("  " + code + "\n", OWNER_EMAIL, STRONG_PASSWORD, "Site  Owner");
        responses.add(claimed);
        assertThat(claimed.getStatus()).as(claimed.getContentAsString()).isEqualTo(201);
        assertThat(json(claimed).path("data").path("setupCompleted").asBoolean())
                .isTrue();
        assertThat(json(claimed).path("data").size()).isEqualTo(1);

        assertThat(setupRequired()).isFalse();
        assertThat(setupCompletedInDatabase()).isTrue();
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM users", Long.class))
                .isEqualTo(accounts);
        assertThat(jdbcTemplate.queryForObject("SELECT id FROM users WHERE email = ?", UUID.class, OWNER_EMAIL))
                .isEqualTo(SeedAdmin.ID);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT display_name FROM users WHERE id = ?", String.class, SeedAdmin.ID))
                .isEqualTo("Site Owner");
        assertThat(jdbcTemplate.queryForObject("SELECT role FROM users WHERE id = ?", String.class, SeedAdmin.ID))
                .isEqualTo("ADMIN");
        assertThat(passwordEncoder.matches(
                        STRONG_PASSWORD,
                        jdbcTemplate.queryForObject(
                                "SELECT password_hash FROM users WHERE id = ?", String.class, SeedAdmin.ID)))
                .isTrue();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL",
                        Long.class,
                        SeedAdmin.ID))
                .isZero();
        assertThat(codeFile).doesNotExist();
        // The claim proved the setup code, so the owner may enrol their authenticator at the first sign-in without the
        // operator's enrollment code: an hour of window (MfaEnrollmentCodeIT is the production-mode journey).
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT mfa_enrollment_open_until > now() + interval '50 minutes' "
                                + "AND mfa_enrollment_open_until < now() + interval '70 minutes' FROM users WHERE id = ?",
                        Boolean.class,
                        SeedAdmin.ID))
                .isTrue();

        // The token minted before the claim is revoked (tokens_valid_after), in the claim's own transaction.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT tokens_valid_after IS NOT NULL FROM users WHERE id = ?", Boolean.class, SeedAdmin.ID))
                .isTrue();
        assertThat(me(beforeTheClaim).getStatus()).isEqualTo(401);

        // The owner signs in; the old seed credentials do not.
        // The password is the first factor: the owner is an ADMIN, so the second step is due (202). This install has no
        // authenticator yet, so the step is the enrollment, and it asks for no code: the claim just proved the setup
        // code.
        MockHttpServletResponse ownerLogin = login(OWNER_EMAIL, STRONG_PASSWORD);
        assertThat(ownerLogin.getStatus()).isEqualTo(202);
        assertThat(json(ownerLogin).path("data").path("purpose").asString()).isEqualTo("ENROLL");
        assertThat(json(ownerLogin).path("data").path("enrollmentCodeRequired").asBoolean())
                .isFalse();
        assertThat(ownerLogin.getContentAsString(StandardCharsets.UTF_8)).doesNotContain("accessToken");
        responses.add(login(SeedAdmin.EMAIL, SeedAdmin.DEV_PASSWORD));
        assertError(responses.getLast(), 401, "INVALID_CREDENTIALS");

        // Closed for good: another claim, and a replay of the used code, both get 404 and change nothing.
        for (MockHttpServletResponse again : List.of(
                setup(code, "intruder@example.test", "intruder-password-123", "Intruder"),
                setup("wrong-code", "intruder@example.test", "intruder-password-123", "Intruder"),
                setup(null, null, null, null))) {
            responses.add(again);
            assertError(again, 404, "SETUP_CLOSED");
        }
        assertThat(jdbcTemplate.queryForObject("SELECT email FROM users WHERE id = ?", String.class, SeedAdmin.ID))
                .isEqualTo(OWNER_EMAIL);

        // The code and the password appear in no response body and in no log line.
        for (MockHttpServletResponse response : responses) {
            assertThat(response.getContentAsString(StandardCharsets.UTF_8))
                    .doesNotContain(code)
                    .doesNotContain(STRONG_PASSWORD);
        }
        assertThat(output.getAll())
                .doesNotContain(code)
                .doesNotContain(STRONG_PASSWORD)
                .doesNotContain(OWNER_EMAIL);
    }

    private MockHttpServletResponse me(String authorization) throws Exception {
        return mockMvc.perform(get("/api/v1/auth/me").header("Authorization", authorization))
                .andReturn()
                .getResponse();
    }
}
