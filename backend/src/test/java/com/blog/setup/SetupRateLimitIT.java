package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.ratelimit.RateLimitProperties;
import com.blog.support.AbstractIntegrationTest;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;

/**
 * The process-wide setup bucket counts only WRONG codes, and only after the compare (issue 033): once it is full a wrong
 * code is answered 429 instead of 403, but the right code still claims the instance. Before, it counted every attempt
 * before the code was looked at, so two addresses sending five wrong codes a minute each could keep the real owner out
 * for as long as they liked. The guess rate is bounded per client address (SetupClientRateLimitIT), which is safe for a
 * code of 256 bits.
 */
@TestPropertySource(properties = "app.rate-limit.setup.per-minute=3")
class SetupRateLimitIT extends SetupIntegrationTest {

    private static final Path DATA_DIR = temporaryDirectory("setup-rate-limit-it");

    @DynamicPropertySource
    static void isolated(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "setup_rate_limit_it");
        registry.add("app.setup.data-dir", DATA_DIR::toString);
    }

    @Test
    void a_full_count_of_wrong_codes_answers_429_to_a_wrong_code_but_the_right_code_still_claims() throws Exception {
        String code = readCode(DATA_DIR);
        for (int i = 0; i < 3; i++) {
            assertError(setup("wrong-" + i, "owner@example.test", STRONG_PASSWORD, "Owner"), 403, "SETUP_CODE_INVALID");
        }
        // The fourth wrong code finds the process-wide count of wrong codes full ...
        assertError(setup("wrong-3", "owner@example.test", STRONG_PASSWORD, "Owner"), 429, "RATE_LIMITED");
        assertThat(setupCompletedInDatabase()).isFalse();

        // ... and the right code gets through all the same: the crowd cannot keep the owner out.
        MockHttpServletResponse claimed = setup(code, "owner@example.test", STRONG_PASSWORD, "Owner");
        assertThat(claimed.getStatus()).as(claimed.getContentAsString()).isEqualTo(201);
        assertThat(setupCompletedInDatabase()).isTrue();
        assertThat(setupRequired()).isFalse();
    }

    @Test
    void the_default_ceiling_of_wrong_codes_is_120_per_minute() {
        assertThat(new RateLimitProperties.Setup(120).perMinute()).isEqualTo(120);
        assertThat(new org.springframework.boot.context.properties.bind.Binder(
                                new org.springframework.boot.context.properties.source.MapConfigurationPropertySource())
                        .bindOrCreate("app.rate-limit", RateLimitProperties.class)
                        .setup()
                        .perMinute())
                .isEqualTo(120);
    }
}
