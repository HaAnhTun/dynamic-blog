package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.blog.auth.repository.MfaChallengeRepository;
import com.blog.common.config.SchedulingConfig;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.config.CronTask;
import org.springframework.scheduling.config.ScheduledTask;
import org.springframework.scheduling.config.ScheduledTaskHolder;

/**
 * The challenge cleanup is really scheduled, with the schedule of the refresh token cleanup: the same property
 * ({@code app.security.refresh-token-cleanup-cron}), the same default (03:17), and {@code -} turns it off. No database: the
 * repository is a mock and the schedule is only registered, not awaited. The DELETE is in {@link MfaChallengeCleanupIT}.
 */
class MfaChallengeCleanupConfigTest {

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withUserConfiguration(SchedulingConfig.class, CleanupBeans.class);

    @Configuration(proxyBeanMethods = false)
    @Import(MfaChallengeCleanup.class)
    static class CleanupBeans {
        @Bean
        MfaChallengeRepository mfaChallengeRepository() {
            return mock(MfaChallengeRepository.class);
        }
    }

    @Test
    void runs_daily_at_03_17_by_default() {
        runner.run(context -> assertThat(cronExpressions(context)).containsExactly("0 17 3 * * *"));
    }

    @Test
    void follows_the_refresh_token_cleanup_property_and_a_dash_turns_it_off() {
        runner.withPropertyValues("app.security.refresh-token-cleanup-cron=0 0 4 * * SUN")
                .run(context -> assertThat(cronExpressions(context)).containsExactly("0 0 4 * * SUN"));
        runner.withPropertyValues("app.security.refresh-token-cleanup-cron=-")
                .run(context -> assertThat(cronExpressions(context)).isEmpty());
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
