package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.blog.auth.service.RefreshTokenService;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * {@code ADMIN_GITHUB_ID} at startup: a value that is not a positive integer is the ONLY path by which
 * AdminGithubLink makes the application fail to start; empty or valid starts normally. The link and merge
 * on a real DB are in {@code user/AdminGithubLinkIT}.
 *
 * ApplicationContextRunner, no DB: the bean is built as at startup (properties bound from configuration), while JdbcTemplate, the
 * refresh token service and the transaction manager are mocks because the failure must happen before they are used.
 */
class AdminGithubLinkStartupTest {

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(AdminAccountProperties.class)
    static class AdminPropertiesConfig {}

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(AdminPropertiesConfig.class)
            .withBean(JdbcTemplate.class, () -> mock(JdbcTemplate.class))
            .withBean(RefreshTokenService.class, () -> mock(RefreshTokenService.class))
            .withBean(PlatformTransactionManager.class, () -> mock(PlatformTransactionManager.class))
            .withBean(AdminGithubLink.class);

    @Test
    void ADMIN_GITHUB_ID_not_a_positive_integer_makes_application_fail_to_start_and_error_does_not_copy_value() {
        for (String invalid : List.of("khong-phai-so", "-42", "12.5", "0x1F", "99999999999999999999")) {
            runner.withPropertyValues("app.admin.github-id=" + invalid).run(context -> {
                assertThat(context).as(invalid).hasFailed();
                assertThat(context.getStartupFailure())
                        .as(invalid)
                        .rootCause()
                        .hasMessageContaining("ADMIN_GITHUB_ID")
                        .hasMessageNotContaining(invalid);
            });
        }
        runner.withPropertyValues("app.admin.github-id=0")
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void ADMIN_GITHUB_ID_empty_or_valid_starts_normally() {
        runner.run(context -> assertThat(context).hasNotFailed());
        runner.withPropertyValues("app.admin.github-id=")
                .run(context -> assertThat(context).hasNotFailed());
        runner.withPropertyValues("app.admin.github-id= 7999999 ").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(AdminAccountProperties.class).linkedGithubId())
                    .isEqualTo(7_999_999L);
        });
    }

    @Test
    void application_yml_wires_the_ADMIN_GITHUB_ID_variable_correctly() {
        // A mistyped key in application.yml makes the environment variable silently go nowhere: set it as a system
        // property (which takes
        // precedence over the real environment variable of the test machine) and read it back through the bound
        // properties.
        runner.withInitializer(new ConfigDataApplicationContextInitializer())
                .withSystemProperties("ADMIN_GITHUB_ID=7999999")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(AdminAccountProperties.class).linkedGithubId())
                            .isEqualTo(7_999_999L);
                });
        runner.withInitializer(new ConfigDataApplicationContextInitializer())
                .withSystemProperties("ADMIN_GITHUB_ID=")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(AdminAccountProperties.class).linkedGithubId())
                            .isNull();
                });
    }
}
