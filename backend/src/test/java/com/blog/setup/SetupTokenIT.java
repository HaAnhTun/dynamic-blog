package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;

/**
 * {@code SETUP_TOKEN} is the setup code: no file is ever written, a wrong value gets the same 403, the token claims the
 * instance, and the token appears neither in the log nor in a response.
 */
@TestPropertySource(properties = "app.setup.token=" + SetupTokenIT.TOKEN)
class SetupTokenIT extends SetupIntegrationTest {

    /** A test value, not a credential of any real instance. */
    static final String TOKEN = "setup-token-it-0123456789abcdefghij";

    private static final Path DATA_DIR = temporaryDirectory("setup-token-it");

    @DynamicPropertySource
    static void isolated(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "setup_token_it");
        registry.add("app.setup.data-dir", DATA_DIR::toString);
    }

    @Test
    void the_configured_token_is_the_code_and_no_code_file_is_written(CapturedOutput output) throws Exception {
        assertThat(setupRequired()).isTrue();
        assertThat(filesIn(DATA_DIR)).isEmpty();
        assertThat(output.getAll()).contains("SETUP_TOKEN");

        MockHttpServletResponse wrong = setup(TOKEN.substring(1), "owner@example.test", STRONG_PASSWORD, "Owner");
        assertError(wrong, 403, "SETUP_CODE_INVALID");
        MockHttpServletResponse claimed = setup(TOKEN, "owner@example.test", STRONG_PASSWORD, "Owner");
        assertThat(claimed.getStatus()).as(claimed.getContentAsString()).isEqualTo(201);
        assertThat(setupRequired()).isFalse();
        assertThat(jdbcTemplate.queryForObject("SELECT email FROM users WHERE id = ?", String.class, SeedAdmin.ID))
                .isEqualTo("owner@example.test");
        // 202: the owner is an ADMIN, the password is only the first factor.
        assertThat(login("owner@example.test", STRONG_PASSWORD).getStatus()).isEqualTo(202);
        MockHttpServletResponse replay = setup(TOKEN, "late@example.test", STRONG_PASSWORD, "Late");
        assertError(replay, 404, "SETUP_CLOSED");

        assertThat(filesIn(DATA_DIR)).isEmpty();
        for (MockHttpServletResponse response : List.of(wrong, claimed, replay)) {
            assertThat(response.getContentAsString(StandardCharsets.UTF_8)).doesNotContain(TOKEN);
        }
        assertThat(output.getAll()).doesNotContain(TOKEN).doesNotContain(STRONG_PASSWORD);
    }

    private static List<Path> filesIn(Path directory) throws Exception {
        try (Stream<Path> files = Files.list(directory)) {
            return files.toList();
        }
    }
}
