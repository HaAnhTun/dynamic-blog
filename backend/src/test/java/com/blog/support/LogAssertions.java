package com.blog.support;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import java.util.List;

/** Assertions over captured log events for the tests that prove no text of an upload reaches a log. */
public final class LogAssertions {

    private LogAssertions() {}

    /**
     * Fails when one of {@code values} is in any event: its formatted message, or, when it carries an exception, the exception's
     * message, its class name or its whole text (stack trace and causes).
     */
    public static void assertNoValues(List<ILoggingEvent> events, String... values) {
        for (ILoggingEvent event : events) {
            assertThat(event.getFormattedMessage()).doesNotContain(values);
            IThrowableProxy thrown = event.getThrowableProxy();
            if (thrown != null) {
                assertThat(String.valueOf(thrown.getMessage())).doesNotContain(values);
                assertThat(thrown.getClassName()).doesNotContain(values);
                assertThat(ThrowableProxyUtil.asString(thrown)).doesNotContain(values);
            }
        }
    }
}
