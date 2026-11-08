package com.blog.analytics.config;

import java.time.Clock;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.ZoneId;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Analytics settings, bound from {@code app.analytics.*}. {@code timeZone} decides the day boundary of a view, the same
 * when writing and when reading; the JVM still runs in UTC. Empty means the default; an invalid value refuses to start
 * (the record is bound when the bean is built).
 *
 * @param timeZone Java time-zone id ({@code ANALYTICS_TIME_ZONE}), normalized
 */
@ConfigurationProperties("app.analytics")
public record AnalyticsProperties(String timeZone) {

    public static final String DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

    public AnalyticsProperties {
        String id = timeZone == null || timeZone.isBlank() ? DEFAULT_TIME_ZONE : timeZone.strip();
        try {
            timeZone = ZoneId.of(id).getId();
        } catch (DateTimeException e) {
            // Name the variable, do not echo the value: like every startup config check in the project.
            throw new IllegalStateException("ANALYTICS_TIME_ZONE is not a time-zone id Java knows; use a region "
                    + "such as Asia/Ho_Chi_Minh or UTC, or leave it empty for " + DEFAULT_TIME_ZONE);
        }
    }

    public ZoneId zone() {
        return ZoneId.of(timeZone);
    }

    /** The current date in the analytics time zone, read from {@code clock}. */
    public LocalDate today(Clock clock) {
        return LocalDate.now(clock.withZone(zone()));
    }
}
