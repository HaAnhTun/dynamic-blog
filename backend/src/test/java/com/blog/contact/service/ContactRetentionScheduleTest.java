package com.blog.contact.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.EmbeddedValueResolver;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.context.expression.StandardBeanExpressionResolver;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.scheduling.annotation.Scheduled;

/**
 * The run time of the nightly job as Spring resolves it for {@code @Scheduled} (placeholders first, then the expression): the
 * default, a setting, {@code -} for off, and that an empty setting is the default and not a start-up failure.
 */
class ContactRetentionScheduleTest {

    private static final String DEFAULT_CRON = "0 43 3 * * *";

    private static String resolvedCron(Map<String, Object> properties) throws NoSuchMethodException {
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("test", properties));
        DefaultListableBeanFactory beanFactory = new DefaultListableBeanFactory();
        beanFactory.addEmbeddedValueResolver(environment::resolvePlaceholders);
        beanFactory.setBeanExpressionResolver(new StandardBeanExpressionResolver());
        String declared = ContactRetention.class
                .getMethod("run")
                .getAnnotation(Scheduled.class)
                .cron();
        return new EmbeddedValueResolver(beanFactory).resolveStringValue(declared);
    }

    @Test
    void it_runs_at_night_by_default_and_a_setting_changes_the_time_or_turns_it_off() throws Exception {
        assertThat(resolvedCron(Map.of())).isEqualTo(DEFAULT_CRON);
        assertThat(resolvedCron(Map.of("app.contact.retention.cron", "0 0 4 * * *")))
                .isEqualTo("0 0 4 * * *");
        assertThat(resolvedCron(Map.of("app.contact.retention.cron", "-"))).isEqualTo("-");
    }

    @Test
    void an_empty_setting_is_the_default_and_not_a_start_up_failure() throws Exception {
        // CONTACT_RETENTION_CRON= in a .env file outside Docker Compose reaches the application as an empty value.
        assertThat(resolvedCron(Map.of("app.contact.retention.cron", ""))).isEqualTo(DEFAULT_CRON);
        assertThat(resolvedCron(Map.of("app.contact.retention.cron", "  "))).isEqualTo(DEFAULT_CRON);
    }
}
