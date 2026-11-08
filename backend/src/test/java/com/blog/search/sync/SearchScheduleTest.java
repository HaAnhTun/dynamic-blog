package com.blog.search.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.common.config.SchedulingConfig;
import com.blog.search.config.SearchProperties;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.config.CronTask;
import org.springframework.scheduling.config.FixedDelayTask;
import org.springframework.scheduling.config.ScheduledTask;
import org.springframework.scheduling.config.ScheduledTaskHolder;

/**
 * Schedules of the outbox worker and of search reconciliation, no DB: like the newsletter schedule in
 * NewsletterConfigTest.
 */
class SearchScheduleTest {

    @Configuration(proxyBeanMethods = false)
    @Import(SearchSchedule.class)
    static class ScheduleBeans {
        @Bean
        SearchOutboxWorker searchOutboxWorker() {
            return mock(SearchOutboxWorker.class);
        }
    }

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withUserConfiguration(SchedulingConfig.class, ScheduleBeans.class);

    @Test
    void worker_runs_10_seconds_after_previous_pass_and_is_configurable_and_can_be_disabled() {
        runner.run(context -> assertThat(fixedDelays(context)).containsExactly(Duration.ofSeconds(10)));
        runner.withPropertyValues("app.search.worker-delay=1m")
                .run(context -> assertThat(fixedDelays(context)).containsExactly(Duration.ofMinutes(1)));
        runner.withPropertyValues("app.search.worker-enabled=false").run(context -> {
            assertThat(context).doesNotHaveBean(SearchSchedule.class);
            assertThat(fixedDelays(context)).isEmpty();
        });
    }

    @Test
    void failed_pass_does_not_kill_the_schedule() {
        SearchOutboxWorker worker = mock(SearchOutboxWorker.class);
        when(worker.runOnce()).thenThrow(new IllegalStateException("broken queue"));
        new SearchSchedule(worker).run();
        verify(worker).runOnce();
    }

    @Configuration(proxyBeanMethods = false)
    @Import(SearchReconcileSchedule.class)
    static class ReconcileBeans {
        @Bean
        SearchReconciler searchReconciler() {
            return mock(SearchReconciler.class);
        }

        @Bean
        SearchMaintenanceLock searchMaintenanceLock() {
            return new SearchMaintenanceLock();
        }

        @Bean
        SearchProperties searchProperties() {
            return properties("http://meilisearch:7700");
        }
    }

    @Test
    void reconcile_runs_by_cron_at_minute_23_hourly_configurable_and_dash_disables_it() {
        ApplicationContextRunner reconcile =
                new ApplicationContextRunner().withUserConfiguration(SchedulingConfig.class, ReconcileBeans.class);
        reconcile.run(context -> assertThat(crons(context)).containsExactly("0 23 * * * *"));
        reconcile
                .withPropertyValues("app.search.reconcile-cron=0 0 4 * * *")
                .run(context -> assertThat(crons(context)).containsExactly("0 0 4 * * *"));
        reconcile
                .withPropertyValues("app.search.reconcile-cron=-")
                .run(context -> assertThat(crons(context)).isEmpty());
    }

    @Test
    void reconcile_schedule_does_nothing_when_unconfigured_and_skips_pass_during_maintenance() {
        SearchReconciler reconciler = mock(SearchReconciler.class);
        SearchMaintenanceLock lock = new SearchMaintenanceLock();
        new SearchReconcileSchedule(reconciler, lock, properties("")).run();
        assertThat(lock.tryAcquire()).isTrue();
        new SearchReconcileSchedule(reconciler, lock, properties("http://meilisearch:7700")).run();
        verify(reconciler, never()).reconcile();
        assertThat(lock.held())
                .as("a skipped run does not release the lock of another holder")
                .isTrue();
        lock.release();

        when(reconciler.reconcile()).thenThrow(new IllegalStateException("broken"));
        new SearchReconcileSchedule(reconciler, lock, properties("http://meilisearch:7700")).run();
        verify(reconciler).reconcile();
        assertThat(lock.held()).isFalse();
    }

    private static SearchProperties properties(String url) {
        return new SearchProperties(
                SearchProperties.Engine.POSTGRES,
                new SearchProperties.Meili(
                        url,
                        "k".repeat(40),
                        "content_v1",
                        Duration.ofMillis(500),
                        Duration.ofMillis(800),
                        Duration.ofSeconds(10)));
    }

    private static List<String> crons(ApplicationContext context) {
        return context.getBeansOfType(ScheduledTaskHolder.class).values().stream()
                .flatMap(holder -> holder.getScheduledTasks().stream())
                .map(ScheduledTask::getTask)
                .filter(CronTask.class::isInstance)
                .map(task -> ((CronTask) task).getExpression())
                .toList();
    }

    private static List<Duration> fixedDelays(ApplicationContext context) {
        return context.getBeansOfType(ScheduledTaskHolder.class).values().stream()
                .flatMap(holder -> holder.getScheduledTasks().stream())
                .map(ScheduledTask::getTask)
                .filter(FixedDelayTask.class::isInstance)
                .map(task -> ((FixedDelayTask) task).getIntervalDuration())
                .toList();
    }
}
