package com.blog.common.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * A development machine listens on loopback only. The {@code dev} profile ({@code mvn spring-boot:run}) accepts the seeded admin
 * password, the committed JWT secret and serves Swagger UI, so it must not be reachable from the network; the jar and the Docker
 * image have no profile, listen on every interface (the container has to) and are production. {@code SERVER_ADDRESS} opens the dev
 * machine on purpose, for a phone on the LAN. Read from the real application.yml and application-dev.yml through ConfigData, like
 * SpringDocExposureTest: no web server, no database.
 */
class DevProfileBindingTest {

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withInitializer(new ConfigDataApplicationContextInitializer());

    @Test
    void the_dev_profile_listens_on_loopback_only() {
        assumeTrue(System.getenv("SERVER_ADDRESS") == null, "SERVER_ADDRESS is set in the environment");
        runner.withPropertyValues("spring.profiles.active=dev")
                .run(context -> assertThat(context.getEnvironment().getProperty("server.address"))
                        .isEqualTo("127.0.0.1"));
    }

    @Test
    void the_address_can_be_opened_on_purpose() {
        runner.withPropertyValues("spring.profiles.active=dev", "SERVER_ADDRESS=0.0.0.0")
                .run(context -> assertThat(context.getEnvironment().getProperty("server.address"))
                        .isEqualTo("0.0.0.0"));
    }

    @Test
    void the_jar_without_a_profile_keeps_the_default_so_that_a_container_is_reachable() {
        assumeTrue(System.getenv("SERVER_ADDRESS") == null, "SERVER_ADDRESS is set in the environment");
        runner.run(context -> assertThat(context.getEnvironment().getProperty("server.address"))
                .isNull());
    }
}
