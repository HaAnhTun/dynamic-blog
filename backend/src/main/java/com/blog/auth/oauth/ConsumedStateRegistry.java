package com.blog.auth.oauth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.LinkedHashMap;
import org.springframework.stereotype.Component;

/**
 * Registry of OAuth {@code state} values already used, so each login blob can lead to the callback only once.
 *
 * An HMAC-signed blob carries no server-side state, so by itself it cannot stop the callback from being replayed with
 * the same blob and state. This registry is the minimal state needed: the SHA-256 of the state (the real state is not
 * kept), in write order, each entry living 10 minutes, exactly the blob's lifetime, so a blob that is still valid can
 * never be used again.
 *
 * Every write drops expired entries from the head of the registry (write order is also expiry order). If the registry
 * grows past 10 000 entries the oldest is evicted: it NEVER rejects a new state, so nobody can fill the registry to
 * block other people from logging in. The last safety net is the GitHub code, which can only be exchanged once.
 *
 * In memory, one instance: running several backends gives each its own registry (README, backend section on the public
 * URL).
 */
@Component
public class ConsumedStateRegistry {

    static final Duration TTL = Duration.ofMinutes(10);
    static final int MAX_ENTRIES = 10_000;

    /** SHA-256 hex of the state → expiry time (epoch ms), in write order. Every access goes through this object's lock. */
    private final LinkedHashMap<String, Long> consumed = new LinkedHashMap<>();

    private final Clock clock;
    private final int maxEntries;

    public ConsumedStateRegistry() {
        this(Clock.systemUTC(), MAX_ENTRIES);
    }

    ConsumedStateRegistry(Clock clock, int maxEntries) {
        this.clock = clock;
        this.maxEntries = maxEntries;
    }

    /**
     * Marks the state as used.
     *
     * @return true the first time; false when this state was already used within the last 10 minutes
     */
    public synchronized boolean consume(String state) {
        long now = clock.millis();
        dropExpired(now);
        String key = sha256(state);
        Long expiresAt = consumed.get(key);
        if (expiresAt != null && expiresAt > now) {
            return false;
        }
        // An expired entry that was not yet dropped (system clock moved backwards) is re-written at the end, in order.
        consumed.remove(key);
        consumed.put(key, now + TTL.toMillis());
        Iterator<String> oldest = consumed.keySet().iterator();
        while (consumed.size() > maxEntries) {
            oldest.next();
            oldest.remove();
        }
        return true;
    }

    synchronized int size() {
        return consumed.size();
    }

    private void dropExpired(long now) {
        Iterator<Long> head = consumed.values().iterator();
        while (head.hasNext() && head.next() <= now) {
            head.remove();
        }
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required by every JVM", e);
        }
    }
}
