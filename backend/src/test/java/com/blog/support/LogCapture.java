package com.blog.support;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.LoggerFactory;

/**
 * The log events of some classes, kept in memory for the length of one test: for the ITs that check which lines a flow
 * writes and that nothing sensitive is in them. Attach with try-with-resources so the appenders never outlive the test.
 */
public final class LogCapture implements AutoCloseable {

    private final List<Logger> loggers = new ArrayList<>();
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();

    private LogCapture(Class<?>... sources) {
        appender.start();
        for (Class<?> source : sources) {
            Logger logger = (Logger) LoggerFactory.getLogger(source);
            logger.addAppender(appender);
            loggers.add(logger);
        }
    }

    public static LogCapture of(Class<?>... sources) {
        return new LogCapture(sources);
    }

    public List<ILoggingEvent> events() {
        return List.copyOf(appender.list);
    }

    /** The formatted messages, in order. */
    public List<String> messages() {
        return appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    /** The formatted messages of one level. */
    public List<String> messages(Level level) {
        return appender.list.stream()
                .filter(event -> event.getLevel() == level)
                .map(ILoggingEvent::getFormattedMessage)
                .toList();
    }

    /** How many formatted messages start with this prefix. */
    public long countStarting(String prefix) {
        return messages().stream().filter(message -> message.startsWith(prefix)).count();
    }

    public void clear() {
        appender.list.clear();
    }

    @Override
    public void close() {
        for (Logger logger : loggers) {
            logger.detachAppender(appender);
        }
        appender.stop();
    }

    /**
     * Fails when {@code secret} appears in any message as a token of its own: not preceded or followed by a hex digit or a
     * hyphen, so a six-digit code is not "found" inside a user id (UUIDs are made of hex digits and hyphens).
     */
    public void assertNeverLogged(String... secrets) {
        for (String message : messages()) {
            for (String secret : secrets) {
                String pattern = "(?<![0-9A-Za-z-])" + java.util.regex.Pattern.quote(secret) + "(?![0-9A-Za-z-])";
                if (java.util.regex.Pattern.compile(pattern).matcher(message).find()) {
                    throw new AssertionError("A secret value appears in a log line: " + message);
                }
            }
        }
    }
}
