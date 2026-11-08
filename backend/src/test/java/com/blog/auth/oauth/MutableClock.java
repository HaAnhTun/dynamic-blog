package com.blog.auth.oauth;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

/**
 * A test clock pushed forward by hand: the 10-minute expiry of the blob and of the consumed-state registry is checked right at the boundary, without
 * waiting in real time.
 */
final class MutableClock extends Clock {

    private Instant now = Instant.parse("2026-10-08T03:00:00Z");

    void advance(Duration duration) {
        now = now.plus(duration);
    }

    @Override
    public ZoneId getZone() {
        return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
        return this;
    }

    @Override
    public Instant instant() {
        return now;
    }
}
