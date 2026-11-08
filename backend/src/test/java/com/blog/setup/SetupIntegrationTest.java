package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.support.AuthTestSupport;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * First-run setup on a database of its own: every subclass points at a freshly created database (Flyway builds it, so
 * V36 finds it fresh and setup is required) and a temporary data directory, with the dev-seed lock ON as in production.
 * Like LastAdminIT it does not extend AbstractIntegrationTest, whose {@code @ServiceConnection} would win over the
 * dedicated database. Nothing in the environment claims the instance: no ADMIN_PASSWORD, no ADMIN_GITHUB_ID, no
 * SETUP_TOKEN (a subclass may set one).
 *
 * {@link OutputCaptureExtension} is declared before {@code @SpringBootTest} so it captures from before the context
 * starts: the startup log lines of the setup runners are part of what the subclasses check.
 */
@ExtendWith(OutputCaptureExtension.class)
@SpringBootTest
@AutoConfigureMockMvc
@Import(AuthTestSupport.class)
@TestPropertySource(
        properties = {
            "app.oauth.github.client-id=",
            "app.oauth.github.client-secret=",
            "app.oauth.github.redirect-uri=",
            "app.oauth.github.site-url=",
            "app.admin.email=admin@blog.local",
            "app.admin.password=",
            "app.admin.github-id=",
            "app.security.refresh-token-cleanup-cron=-",
            "app.newsletter.worker-enabled=false",
            "app.search.worker-enabled=false",
            "app.search.reconcile-cron=-",
            "app.search.meili.url=",
            "app.setup.token=",
            "app.setup.lock-dev-seed=true"
        })
abstract class SetupIntegrationTest {

    static final String STRONG_PASSWORD = "correct-horse-battery-staple";

    @Autowired
    MockMvc mockMvc;

    @Autowired
    ObjectMapper objectMapper;

    @Autowired
    JdbcTemplate jdbcTemplate;

    static Path temporaryDirectory(String name) {
        try {
            return Files.createTempDirectory(name);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static String readCode(Path dataDir) throws IOException {
        return Files.readString(dataDir.resolve("setup-code"), StandardCharsets.UTF_8)
                .strip();
    }

    MockHttpServletResponse setup(String code, String email, String password, String displayName) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        if (code != null) {
            body.put("setupCode", code);
        }
        body.put("email", email);
        body.put("password", password);
        body.put("displayName", displayName);
        return mockMvc.perform(post("/api/v1/setup")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn()
                .getResponse();
    }

    boolean setupRequired() throws Exception {
        MockHttpServletResponse response =
                mockMvc.perform(get("/api/v1/setup/status")).andReturn().getResponse();
        assertThat(response.getStatus()).isEqualTo(200);
        return json(response).path("data").path("setupRequired").asBoolean();
    }

    MockHttpServletResponse login(String email, String password) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("email", email, "password", password))))
                .andReturn()
                .getResponse();
    }

    JsonNode json(MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(response.getContentAsString(StandardCharsets.UTF_8));
    }

    void assertError(MockHttpServletResponse response, int status, String code) throws Exception {
        String body = response.getContentAsString(StandardCharsets.UTF_8);
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        assertThat(json(response).path("error").path("code").asString())
                .as(body)
                .isEqualTo(code);
    }

    boolean setupCompletedInDatabase() {
        return Boolean.TRUE.equals(
                jdbcTemplate.queryForObject("SELECT setup_completed FROM app_settings WHERE id = 1", Boolean.class));
    }
}
