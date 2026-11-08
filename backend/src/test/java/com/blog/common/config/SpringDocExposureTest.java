package com.blog.common.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.Test;
import org.springdoc.core.utils.Constants;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.env.Environment;

/**
 * Swagger UI and /v3/api-docs are on or off according to application.yml, application-dev.yml and the SPRINGDOC_ENABLED variable. These two pages
 * describe the entire admin API and SecurityConfig lets them be viewed without logging in, so they are OFF by default:
 * the jar, the Docker image and the E2E stack do not enable them. {@code mvn spring-boot:run} runs with the {@code dev} profile
 * (spring-boot-maven-plugin in pom.xml), and application-dev.yml turns both back on for dev machines.
 *
 * <p>springdoc 3.1 does not decide on/off with its properties class (the {@code enabled} field there defaults to false),
 * but with {@code @ConditionalOnProperty(..., matchIfMissing = true)} on SpringDocConfiguration and SwaggerConfig,
 * reading exactly the two keys in {@link Constants}. The test reads those two keys through springdoc's own constants, on the
 * real application.yml loaded through ConfigData like MediaConfigTest: a mistyped key is treated by springdoc as "missing" and still
 * enabled, while the test goes red. No web, no DB, no extra Testcontainers context; the two real branches (on serves the
 * docs, off gives 404) are in OpenApiConfigIT and SpringDocDisabledIT.
 */
class SpringDocExposureTest {

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withInitializer(new ConfigDataApplicationContextInitializer());

    @Test
    void default_turns_off_both_swagger_ui_and_api_docs() {
        // A machine that already sets this variable cannot measure the default branch.
        assumeTrue(System.getenv("SPRINGDOC_ENABLED") == null, "SPRINGDOC_ENABLED is set in the environment");
        runner.run(context -> assertSpringDoc(context.getEnvironment(), false));
    }

    @Test
    void dev_profile_of_mvn_spring_boot_run_turns_both_back_on() {
        assumeTrue(System.getenv("SPRINGDOC_ENABLED") == null, "SPRINGDOC_ENABLED is set in the environment");
        // Exactly the argument spring-boot-maven-plugin passes when there is
        // <profiles><profile>dev</profile></profiles>.
        runner.withPropertyValues("spring.profiles.active=dev")
                .run(context -> assertSpringDoc(context.getEnvironment(), true));
    }

    @Test
    void explicit_SPRINGDOC_ENABLED_wins_over_both_default_and_dev_profile() {
        runner.withPropertyValues("SPRINGDOC_ENABLED=true")
                .run(context -> assertSpringDoc(context.getEnvironment(), true));
        runner.withPropertyValues("spring.profiles.active=dev", "SPRINGDOC_ENABLED=false")
                .run(context -> assertSpringDoc(context.getEnvironment(), false));
        runner.withPropertyValues("SPRINGDOC_ENABLED=false")
                .run(context -> assertSpringDoc(context.getEnvironment(), false));
    }

    private static void assertSpringDoc(Environment env, boolean enabled) {
        assertThat(env.getProperty(Constants.SPRINGDOC_ENABLED, Boolean.class)).isEqualTo(enabled);
        assertThat(env.getProperty(Constants.SPRINGDOC_SWAGGER_UI_ENABLED, Boolean.class))
                .isEqualTo(enabled);
    }
}
