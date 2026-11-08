package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.common.config.SchedulingConfig;
import com.blog.common.config.SecurityProperties;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.config.CronTask;
import org.springframework.scheduling.config.ScheduledTask;
import org.springframework.scheduling.config.ScheduledTaskHolder;

/**
 * Refresh token cleanup is really scheduled, and the properties of the refresh token lifecycle have the right defaults.
 * No DB needed: the repository is a mock, the schedule is only registered and not awaited until it fires. The DELETE statement is in
 * RefreshTokenCleanupIT.
 */
class RefreshTokenCleanupConfigTest {

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withUserConfiguration(SchedulingConfig.class, CleanupBeans.class);

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(SecurityProperties.class)
    @Import(RefreshTokenCleanup.class)
    static class CleanupBeans {
        @Bean
        RefreshTokenRepository refreshTokenRepository() {
            return mock(RefreshTokenRepository.class);
        }
    }

    @Test
    void default_cleanup_runs_daily_at_03_17_in_JVM_time_i_e_UTC() {
        runner.run(context -> assertThat(cronExpressions(context)).containsExactly("0 17 3 * * *"));
    }

    @Test
    void cleanup_time_can_be_changed_by_property_and_a_dash_turns_the_schedule_off_entirely() {
        runner.withPropertyValues("app.security.refresh-token-cleanup-cron=0 0 4 * * SUN")
                .run(context -> assertThat(cronExpressions(context)).containsExactly("0 0 4 * * SUN"));
        runner.withPropertyValues("app.security.refresh-token-cleanup-cron=-")
                .run(context -> assertThat(cronExpressions(context)).isEmpty());
    }

    @Test
    void keeps_revoked_tokens_7_days_and_grace_2_minutes_by_default_and_both_can_be_changed() {
        runner.run(context -> {
            SecurityProperties properties = context.getBean(SecurityProperties.class);
            assertThat(properties.refreshTokenRevokedRetention()).isEqualTo(Duration.ofDays(7));
            assertThat(properties.refreshTokenReuseGrace()).isEqualTo(Duration.ofMinutes(2));
        });
        runner.withPropertyValues(
                        "app.security.refresh-token-revoked-retention=14d",
                        "app.security.refresh-token-reuse-grace=30s")
                .run(context -> {
                    SecurityProperties properties = context.getBean(SecurityProperties.class);
                    assertThat(properties.refreshTokenRevokedRetention()).isEqualTo(Duration.ofDays(14));
                    assertThat(properties.refreshTokenReuseGrace()).isEqualTo(Duration.ofSeconds(30));
                });
    }

    @Test
    void privileged_sessions_end_after_7_days_idle_and_30_days_in_all_by_default_and_both_can_be_changed() {
        runner.run(context -> {
            SecurityProperties properties = context.getBean(SecurityProperties.class);
            assertThat(properties.privilegedSessionIdleTtl()).isEqualTo(Duration.ofDays(7));
            assertThat(properties.privilegedSessionAbsoluteTtl()).isEqualTo(Duration.ofDays(30));
        });
        runner.withPropertyValues(
                        "app.security.privileged-session-idle-ttl=12h",
                        "app.security.privileged-session-absolute-ttl=14d")
                .run(context -> {
                    SecurityProperties properties = context.getBean(SecurityProperties.class);
                    assertThat(properties.privilegedSessionIdleTtl()).isEqualTo(Duration.ofHours(12));
                    assertThat(properties.privilegedSessionAbsoluteTtl()).isEqualTo(Duration.ofDays(14));
                });
        // An empty variable (a blank line in .env) means the default, not "no limit" and not a refusal to start.
        runner.withPropertyValues(
                        "app.security.privileged-session-idle-ttl=", "app.security.privileged-session-absolute-ttl=")
                .run(context -> {
                    SecurityProperties properties = context.getBean(SecurityProperties.class);
                    assertThat(properties.privilegedSessionIdleTtl()).isEqualTo(Duration.ofDays(7));
                    assertThat(properties.privilegedSessionAbsoluteTtl()).isEqualTo(Duration.ofDays(30));
                });
        // The reader's refresh token keeps its own life, whatever the privileged limits are.
        runner.withPropertyValues("app.security.privileged-session-idle-ttl=1h")
                .run(context -> assertThat(
                                context.getBean(SecurityProperties.class).refreshTokenTtl())
                        .isEqualTo(Duration.ofDays(30)));
    }

    @Test
    void a_privileged_session_limit_of_zero_or_less_makes_the_application_fail_to_start() {
        for (String property : new String[] {
            "app.security.privileged-session-idle-ttl=0s",
            "app.security.privileged-session-idle-ttl=-1d",
            "app.security.privileged-session-absolute-ttl=0s",
            "app.security.privileged-session-absolute-ttl=-1d"
        }) {
            // 0 would end every session at once, a negative value is a typo: neither is a limit anybody meant.
            runner.withPropertyValues(property)
                    .run(context -> assertThat(context).as(property).hasFailed());
        }
    }

    @Test
    void negative_duration_makes_the_application_fail_to_start() {
        for (String property : new String[] {
            "app.security.refresh-token-revoked-retention=-1d", "app.security.refresh-token-reuse-grace=-1s"
        }) {
            runner.withPropertyValues(property)
                    .run(context -> assertThat(context).as(property).hasFailed());
        }
        // Control: 0 is an allowed choice (do not keep revoked tokens; no grace period).
        runner.withPropertyValues(
                        "app.security.refresh-token-revoked-retention=0s", "app.security.refresh-token-reuse-grace=0s")
                .run(context -> assertThat(context).hasNotFailed());
    }

    /** Every cron job this context has scheduled. */
    private static List<String> cronExpressions(ApplicationContext context) {
        return context.getBeansOfType(ScheduledTaskHolder.class).values().stream()
                .flatMap(holder -> holder.getScheduledTasks().stream())
                .map(ScheduledTask::getTask)
                .filter(CronTask.class::isInstance)
                .map(task -> ((CronTask) task).getExpression())
                .toList();
    }
}
