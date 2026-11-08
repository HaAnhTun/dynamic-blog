package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import tools.jackson.databind.JsonNode;

/**
 * {@code MFA_ENROLLMENT_TOKEN} is the enrollment code (for an operator who cannot read the data directory: a read-only
 * volume): no file is ever written, a wrong value gets the same 403, the token enrols the administrator, and the token
 * appears neither in the log nor in a response.
 */
@TestPropertySource(
        properties = {
            "app.allow-dev-defaults=false",
            "app.security.jwt-secret=chuoi-bi-mat-jwt-cua-cai-dat-san-xuat-thu-nghiem-0123456789",
            "app.views.token=views-token-cua-cai-dat-san-xuat-thu-nghiem",
            "app.client-ip.token=client-ip-token-of-a-production-test-not-a-real-secret",
            "app.mfa.encryption-key=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            "app.rate-limit.setup.per-minute=100",
            "app.mfa.enrollment-token=" + MfaEnrollmentTokenIT.TOKEN
        })
class MfaEnrollmentTokenIT extends SetupIntegrationTest {

    /** A test value, not a credential of any real instance. */
    static final String TOKEN = "enrollment-token-it-0123456789abcdefghij";

    private static final Path DATA_DIR = temporaryDirectory("mfa-enrollment-token-it");

    @DynamicPropertySource
    static void isolated(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "mfa_enrollment_token_it");
        registry.add("app.setup.data-dir", DATA_DIR::toString);
    }

    private MockHttpServletResponse call(String path, Map<String, String> body) throws Exception {
        return mockMvc.perform(post(path).contentType(APPLICATION_JSON).content(objectMapper.writeValueAsString(body)))
                .andReturn()
                .getResponse();
    }

    private MockHttpServletResponse begin(String challenge, String enrollmentCode) throws Exception {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("challenge", challenge);
        if (enrollmentCode != null) {
            body.put("enrollmentCode", enrollmentCode);
        }
        return call("/api/v1/auth/mfa/enroll/begin", body);
    }

    @Test
    void the_token_is_the_enrollment_code_and_no_file_is_written(CapturedOutput output) throws Exception {
        // Claim the instance, then close the setup-hour window the way an upgrade without a setup would leave it.
        String code = readCode(DATA_DIR);
        assertThat(setup(code, "owner-token@example.test", STRONG_PASSWORD, "Owner")
                        .getStatus())
                .isEqualTo(201);
        jdbcTemplate.update("UPDATE users SET mfa_enrollment_open_until = NULL WHERE id = ?", SeedAdmin.ID);

        MockHttpServletResponse login = login("owner-token@example.test", STRONG_PASSWORD);
        assertThat(login.getStatus()).isEqualTo(202);
        JsonNode challenge = json(login).path("data");
        assertThat(challenge.path("enrollmentCodeRequired").asBoolean()).isTrue();

        assertError(begin(challenge.path("challenge").asString(), null), 403, "ENROLLMENT_CODE_INVALID");
        assertError(begin(challenge.path("challenge").asString(), TOKEN.substring(1)), 403, "ENROLLMENT_CODE_INVALID");
        MockHttpServletResponse right = begin(challenge.path("challenge").asString(), TOKEN);
        assertThat(right.getStatus()).as(right.getContentAsString()).isEqualTo(200);

        // Never a file next to the setup code, and the token is in no response and no log line.
        try (var files = Files.list(DATA_DIR)) {
            assertThat(files.map(path -> path.getFileName().toString())).noneMatch(name -> name.contains("mfa"));
        }
        assertThat(right.getContentAsString()).doesNotContain(TOKEN);
        assertThat(output.getAll()).doesNotContain(TOKEN);
    }
}
