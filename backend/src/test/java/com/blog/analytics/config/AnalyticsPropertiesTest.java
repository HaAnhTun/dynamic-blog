package com.blog.analytics.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * Analytics time zone ({@code ANALYTICS_TIME_ZONE}): the real application.yml is loaded through ConfigData as at
 * runtime, with no web layer and no DB. Binding happens when the context is built, so a bad value stops the
 * application before it accepts any request.
 */
class AnalyticsPropertiesTest {

    @EnableConfigurationProperties(AnalyticsProperties.class)
    static class PropertiesOnly {}

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(new ConfigDataApplicationContextInitializer())
            .withUserConfiguration(PropertiesOnly.class);

    @Test
    void default_is_asia_ho_chi_minh_and_blank_is_also_default() {
        if (System.getenv("ANALYTICS_TIME_ZONE") == null) {
            runner.run(context -> assertThat(
                            context.getBean(AnalyticsProperties.class).timeZone())
                    .isEqualTo("Asia/Ho_Chi_Minh"));
        }
        runner.withPropertyValues("app.analytics.time-zone=  ")
                .run(context -> assertThat(
                                context.getBean(AnalyticsProperties.class).timeZone())
                        .isEqualTo("Asia/Ho_Chi_Minh"));
        runner.withPropertyValues("app.analytics.time-zone= UTC ")
                .run(context -> assertThat(context.getBean(AnalyticsProperties.class)
                                .zone()
                                .getId())
                        .isEqualTo("UTC"));
    }

    @Test
    void invalid_time_zone_id_fails_startup_and_message_names_variable_without_echoing_value() {
        for (String bad : new String[] {"Mars/Olympus_Mons", "GMT+25", "Asia/Ho Chi Minh"}) {
            runner.withPropertyValues("app.analytics.time-zone=" + bad).run(context -> {
                assertThat(context).hasFailed();
                Throwable root = context.getStartupFailure();
                while (root.getCause() != null) {
                    root = root.getCause();
                }
                assertThat(root)
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessageContaining("ANALYTICS_TIME_ZONE")
                        .hasMessageNotContaining(bad);
            });
        }
    }
}
