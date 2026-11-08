package com.blog.common.ratelimit;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * Per-user rate limits on writes: comments and replies, edits and deletes, post likes; role changes and author
 * applications; saving posts; newsletter signups per address (string key, {@link #allow}).
 *
 * The same ledger also counts anonymous callers by client address ({@link ClientAddress}: the trusted address that
 * the frontend forwards, else the socket address) and the few shared ceilings (one fixed key, {@link #GLOBAL_KEY}). Those
 * keys are chosen by whoever sends the request, so their buckets are also bounded in memory, see below.
 *
 * An exact sliding window: each person keeps
 * the timestamps of the last N ACCEPTED attempts (N is the largest limit of that kind of operation), in a
 * {@code long[]} ring, and a new attempt is rejected when the {@code max}-th from the end is still inside the window.
 * A rejected attempt is not recorded: pressing repeatedly while blocked does not lengthen the block. The clock is
 * {@code System.nanoTime}, not the system time, so adjusting the machine clock backwards or forwards neither unlocks
 * nor locks anyone.
 *
 * One {@link ConcurrentHashMap} per kind of operation, updated with {@code compute}: every read and write of one
 * person's record is atomic, so many parallel requests from the same person cannot slip past the limit. When the map
 * grows past {@value #MAX_KEYS} people, those whose latest attempt has left the longest window of that kind of
 * operation are dropped: none of their attempts still counts, so dropping them opens no extra quota for anyone. A
 * person still inside the window is never dropped.
 *
 * A bucket keyed by something the caller chooses (a client address, a submitted email address) has a hard ceiling of
 * twice {@value #MAX_KEYS} keys on top of that. At the ceiling the expired keys are swept first (at most once a second).
 * What happens when every key is still inside its window depends on the bucket:
 * <ul>
 *   <li>most buckets (contact, newsletter, search) REFUSE a NEW key (the caller gets the same answer as for a limit that
 *       is exceeded) while the keys already counted keep their exact quota, so a flood of invented addresses can neither
 *       grow the map without bound nor push a running counter out of it;</li>
 *   <li>the sign-in path (password login, the second step, refresh, first-run setup) must stay open for the owner, whoever
 *       floods it, so those buckets EVICT instead: a new key is always admitted and the stalest keys (the ones whose last
 *       accepted attempt is oldest) are dropped to make room, a sixteenth of the ceiling at a time so the scan is not
 *       repeated for every request (issue 115). It costs the owner nothing. A flooder needs as many distinct addresses as
 *       the ceiling just to make the stalest counter (usually its own) start again, which a fresh address gives it for free
 *       anyway.</li>
 * </ul>
 *
 * In memory, one instance: running several backends gives each its own record, and a restart empties it. There is no
 * {@code Retry-After} header.
 */
@Component
public class RateLimiter {

    /** Creating top-level comments and replies. */
    public static final String COMMENT = "comment";
    /** Editing and deleting your own comments. */
    public static final String COMMENT_EDIT = "comment-edit";
    /** Liking and unliking. */
    public static final String LIKE = "like";

    public static final String ROLE_CHANGE = "role-change";
    public static final String AUTHOR_APPLICATION = "author-application";
    /** Saving and unsaving posts. */
    public static final String BOOKMARK = "bookmark";
    /** Newsletter signups, per normalized address. */
    public static final String NEWSLETTER_SIGNUP = "newsletter-signup";
    /** Newsletter confirmations and unsubscribes, per the token's address. */
    public static final String NEWSLETTER_TOKEN = "newsletter-token";
    /** Public search, one shared key for the whole process: {@link #SEARCH_GLOBAL_KEY}. */
    public static final String SEARCH = "search";
    /** Rebuilding the search index, per admin. */
    public static final String SEARCH_REINDEX = "search-reindex";
    /** Wrong first-run setup codes, one shared key for the whole process: {@link #SETUP_GLOBAL_KEY}. */
    public static final String SETUP = "setup";

    public static final String SETUP_GLOBAL_KEY = "all";
    /** Saving, restoring and importing site content, per admin. */
    public static final String SITE_CONTENT_WRITE = "site-content-write";
    /** Previewing, applying and undoing a post import, per person (admin or author). */
    public static final String POST_IMPORT_WRITE = "post-import-write";
    /** The article previews of the post import page, per person (admin or author); apart from {@link #POST_IMPORT_WRITE}. */
    public static final String ARTICLE_PREVIEW = "article-preview";
    /**
     * The step-ups of signed-in two-step verification management (enroll, regenerate, replace, remove, and the admin reset
     * of an author), per user. The guarantee against guessing a code is the per-account counter; this keeps one session
     * from hammering the endpoints.
     */
    public static final String MFA_STEP_UP = "mfa-step-up";
    /** Changing the password, per user. */
    public static final String PASSWORD_CHANGE = "password-change";
    /** The only key of {@link #SEARCH}: the per-IP quota is already in Next, this is the shared ceiling. */
    public static final String SEARCH_GLOBAL_KEY = "all";

    /** The only key of the {@code *_GLOBAL} buckets: one ceiling shared by everyone. */
    public static final String GLOBAL_KEY = "all";
    /** Contact messages, per client address. */
    public static final String CONTACT_CLIENT = "contact-client";
    /** Contact messages from everyone together, key {@link #GLOBAL_KEY}. */
    public static final String CONTACT_GLOBAL = "contact-global";
    /** Newsletter signups, per client address. */
    public static final String NEWSLETTER_SIGNUP_CLIENT = "newsletter-signup-client";
    /** Newsletter signups from everyone together, key {@link #GLOBAL_KEY}. */
    public static final String NEWSLETTER_SIGNUP_GLOBAL = "newsletter-signup-global";
    /** Newsletter confirmations and unsubscribes, per client address. */
    public static final String NEWSLETTER_TOKEN_CLIENT = "newsletter-token-client";
    /**
     * Newsletter confirmations from everyone together, key {@link #GLOBAL_KEY}. Unsubscribes are deliberately NOT counted
     * here (nor in any other whole-site bucket): stray tokens must never be able to use up the budget that real
     * unsubscribes would need, and unsubscribing has to stay possible.
     */
    public static final String NEWSLETTER_CONFIRM_GLOBAL = "newsletter-confirm-global";
    /** Password login attempts, per client address. */
    public static final String LOGIN_CLIENT = "login-client";
    /** The second step of a sign-in (verify, begin and confirm an enrollment), per client address. */
    public static final String MFA_CLIENT = "mfa-client";
    /** Token refreshes, per client address. */
    public static final String REFRESH_CLIENT = "refresh-client";
    /** First-run setup attempts, per client address; the process-wide count is {@link #SETUP}. */
    public static final String SETUP_CLIENT = "setup-client";
    /** Public search, per client address; the process-wide ceiling is {@link #SEARCH}. */
    public static final String SEARCH_CLIENT = "search-client";
    /** Creating and saving posts, per AUTHOR (an ADMIN is not counted). */
    public static final String POST_WRITE = "post-write";
    /** Creating tags and categories, per AUTHOR (an ADMIN is not counted). */
    public static final String TAXONOMY_CREATE = "taxonomy-create";
    /** Uploading cover and body images, per AUTHOR (an ADMIN is not counted). */
    public static final String MEDIA_UPLOAD = "media-upload";

    static final int MAX_KEYS = 10_000;
    /** Buckets keyed by caller-chosen values may hold at most this many times {@link #MAX_KEYS} keys. */
    private static final int HARD_CEILING_FACTOR = 2;
    /** An evicting bucket at its ceiling drops this fraction (1/16) of the ceiling, the stalest keys, in one pass. */
    private static final int EVICTION_DIVISOR = 16;
    /** At the hard ceiling the expired keys are swept at most this often. */
    private static final long FORCED_SWEEP_INTERVAL_NANOS =
            Duration.ofSeconds(1).toNanos();

    private final Map<String, Bucket> buckets;
    private final LongSupplier nanoClock;

    @Autowired
    public RateLimiter(RateLimitProperties properties) {
        this(properties, System::nanoTime, MAX_KEYS);
    }

    RateLimiter(RateLimitProperties properties, LongSupplier nanoClock, int maxKeys) {
        this.nanoClock = nanoClock;
        Map<String, Bucket> all = new HashMap<>(Map.of(
                COMMENT,
                        new Bucket(
                                List.of(
                                        new Limit(properties.comment().perMinute(), Duration.ofMinutes(1)),
                                        new Limit(properties.comment().perHour(), Duration.ofHours(1))),
                                maxKeys),
                COMMENT_EDIT,
                        new Bucket(
                                List.of(new Limit(properties.commentEdit().perTenMinutes(), Duration.ofMinutes(10))),
                                maxKeys),
                LIKE, new Bucket(List.of(new Limit(properties.like().perMinute(), Duration.ofMinutes(1))), maxKeys),
                ROLE_CHANGE,
                        new Bucket(
                                List.of(new Limit(properties.roleChange().perTenMinutes(), Duration.ofMinutes(10))),
                                maxKeys),
                AUTHOR_APPLICATION,
                        new Bucket(
                                List.of(new Limit(properties.authorApplication().perHour(), Duration.ofHours(1))),
                                maxKeys),
                BOOKMARK,
                        new Bucket(
                                List.of(new Limit(properties.bookmark().perMinute(), Duration.ofMinutes(1))), maxKeys),
                NEWSLETTER_SIGNUP,
                        capped(
                                List.of(new Limit(properties.newsletterSignup().perHour(), Duration.ofHours(1))),
                                maxKeys),
                NEWSLETTER_TOKEN,
                        new Bucket(
                                List.of(new Limit(properties.newsletterToken().perHour(), Duration.ofHours(1))),
                                maxKeys),
                SEARCH, new Bucket(List.of(new Limit(properties.search().perMinute(), Duration.ofMinutes(1))), maxKeys),
                SEARCH_REINDEX,
                        new Bucket(
                                List.of(new Limit(properties.searchReindex().perTenMinutes(), Duration.ofMinutes(10))),
                                maxKeys)));
        all.put(SETUP, new Bucket(List.of(new Limit(properties.setup().perMinute(), Duration.ofMinutes(1))), maxKeys));
        all.put(
                SITE_CONTENT_WRITE,
                new Bucket(
                        List.of(new Limit(properties.siteContentWrite().perTenMinutes(), Duration.ofMinutes(10))),
                        maxKeys));
        all.put(
                POST_IMPORT_WRITE,
                new Bucket(
                        List.of(new Limit(properties.postImportWrite().perTenMinutes(), Duration.ofMinutes(10))),
                        maxKeys));
        all.put(
                ARTICLE_PREVIEW,
                new Bucket(
                        List.of(new Limit(properties.articlePreview().perTenMinutes(), Duration.ofMinutes(10))),
                        maxKeys));
        all.put(
                MFA_STEP_UP,
                new Bucket(
                        List.of(new Limit(properties.mfaStepUp().perTenMinutes(), Duration.ofMinutes(10))), maxKeys));
        all.put(
                PASSWORD_CHANGE,
                new Bucket(
                        List.of(new Limit(properties.passwordChange().perTenMinutes(), Duration.ofMinutes(10))),
                        maxKeys));
        // Keyed by a client address (chosen by the caller, so capped) or by the single global key.
        all.put(
                CONTACT_CLIENT,
                capped(List.of(new Limit(properties.contactClient().perHour(), Duration.ofHours(1))), maxKeys));
        all.put(
                CONTACT_GLOBAL,
                new Bucket(List.of(new Limit(properties.contactGlobal().perHour(), Duration.ofHours(1))), maxKeys));
        all.put(
                NEWSLETTER_SIGNUP_CLIENT,
                capped(
                        List.of(new Limit(properties.newsletterSignupClient().perHour(), Duration.ofHours(1))),
                        maxKeys));
        all.put(
                NEWSLETTER_SIGNUP_GLOBAL,
                new Bucket(
                        List.of(new Limit(properties.newsletterSignupGlobal().perHour(), Duration.ofHours(1))),
                        maxKeys));
        all.put(
                NEWSLETTER_TOKEN_CLIENT,
                capped(List.of(new Limit(properties.newsletterTokenClient().perHour(), Duration.ofHours(1))), maxKeys));
        all.put(
                NEWSLETTER_CONFIRM_GLOBAL,
                new Bucket(
                        List.of(new Limit(properties.newsletterConfirmGlobal().perHour(), Duration.ofHours(1))),
                        maxKeys));
        // The sign-in path: evicting, never refusing a new key (issue 115).
        all.put(
                LOGIN_CLIENT,
                cappedEvicting(
                        List.of(new Limit(properties.loginClient().perTenMinutes(), Duration.ofMinutes(10))), maxKeys));
        all.put(
                MFA_CLIENT,
                cappedEvicting(
                        List.of(new Limit(properties.mfaClient().perTenMinutes(), Duration.ofMinutes(10))), maxKeys));
        all.put(
                REFRESH_CLIENT,
                cappedEvicting(
                        List.of(new Limit(properties.refreshClient().perTenMinutes(), Duration.ofMinutes(10))),
                        maxKeys));
        all.put(
                SETUP_CLIENT,
                cappedEvicting(
                        List.of(new Limit(properties.setupClient().perMinute(), Duration.ofMinutes(1))), maxKeys));
        all.put(
                SEARCH_CLIENT,
                capped(List.of(new Limit(properties.searchClient().perMinute(), Duration.ofMinutes(1))), maxKeys));
        all.put(
                POST_WRITE,
                new Bucket(
                        List.of(new Limit(properties.postWrite().perTenMinutes(), Duration.ofMinutes(10))), maxKeys));
        all.put(
                TAXONOMY_CREATE,
                new Bucket(List.of(new Limit(properties.taxonomyCreate().perHour(), Duration.ofHours(1))), maxKeys));
        all.put(
                MEDIA_UPLOAD,
                new Bucket(
                        List.of(new Limit(properties.mediaUpload().perTenMinutes(), Duration.ofMinutes(10))), maxKeys));
        this.buckets = Map.copyOf(all);
    }

    /**
     * A bucket keyed by something the caller chooses: bounded at {@value #HARD_CEILING_FACTOR} times {@code maxKeys} keys, and a
     * new key is refused while every key is inside its window.
     */
    private static Bucket capped(List<Limit> limits, int maxKeys) {
        return new Bucket(limits, maxKeys, hardCeiling(maxKeys), false);
    }

    /**
     * Like {@link #capped}, for the sign-in path: a new key is never refused. At the ceiling the stalest keys are evicted to
     * make room, so a crowd of invented addresses cannot deny the owner's sign-in, second step or refresh (issue 115).
     */
    private static Bucket cappedEvicting(List<Limit> limits, int maxKeys) {
        return new Bucket(limits, maxKeys, hardCeiling(maxKeys), true);
    }

    private static int hardCeiling(int maxKeys) {
        return (int) Math.min(Integer.MAX_VALUE, (long) maxKeys * HARD_CEILING_FACTOR);
    }

    /**
     * Records one operation by the user, or rejects it.
     *
     * @param bucket one of {@link #COMMENT}, {@link #COMMENT_EDIT}, {@link #LIKE}, {@link #ROLE_CHANGE},
     *               {@link #AUTHOR_APPLICATION}, {@link #BOOKMARK}, {@link #NEWSLETTER_SIGNUP}, {@link #NEWSLETTER_TOKEN},
     *               {@link #SEARCH}, {@link #SEARCH_REINDEX}, {@link #SETUP}, {@link #SITE_CONTENT_WRITE},
     *               {@link #POST_IMPORT_WRITE}, {@link #ARTICLE_PREVIEW}, {@link #MFA_STEP_UP},
     *               {@link #PASSWORD_CHANGE}, {@link #POST_WRITE}, {@link #TAXONOMY_CREATE},
     *               {@link #MEDIA_UPLOAD}, or one of the client-address and global buckets
     *               ({@link #CONTACT_CLIENT} ... {@link #SEARCH_CLIENT}), which take a string key
     * @throws ApiException 429 {@code RATE_LIMITED} when a limit of that kind of operation is exceeded, or a new key
     *                      does not fit in a full bucket that refuses new keys (the sign-in path evicts instead); the
     *                      message mentions no user or operation
     * @throws IllegalArgumentException when {@code bucket} is none of the above (a programming error)
     */
    public void check(String bucket, UUID userId) {
        if (!bucket(bucket).tryAcquire(userId, nanoClock.getAsLong())) {
            throw new ApiException(
                    ErrorCode.RATE_LIMITED,
                    HttpStatus.TOO_MANY_REQUESTS,
                    "Too many requests; wait a moment and try again");
        }
    }

    /** Like {@link #check(String, UUID)}, with a string key (a normalized address); 429 when exceeded. */
    public void check(String bucket, String key) {
        check(bucket, keyId(bucket, key));
    }

    /**
     * Records one operation by string key, returning {@code false} instead of throwing when exceeded: for places that
     * must answer identically whether limited or not (newsletter signup). The key is hashed into a UUID, so the map does
     * not keep the original string.
     */
    public boolean allow(String bucket, String key) {
        return bucket(bucket).tryAcquire(keyId(bucket, key), nanoClock.getAsLong());
    }

    private static UUID keyId(String bucket, String key) {
        return UUID.nameUUIDFromBytes((bucket + ':' + key).getBytes(StandardCharsets.UTF_8));
    }

    /** The number of people with a record in one kind of operation; for the pruning test. */
    int trackedKeys(String bucket) {
        return bucket(bucket).history.size();
    }

    private Bucket bucket(String name) {
        Bucket bucket = buckets.get(name);
        if (bucket == null) {
            throw new IllegalArgumentException("Unknown rate-limit bucket: " + name);
        }
        return bucket;
    }

    /** {@code max} attempts in every span of {@code windowNanos}. */
    private record Limit(int max, long windowNanos) {
        Limit(int max, Duration window) {
            this(max, window.toNanos());
        }
    }

    private static final class Bucket {

        private final List<Limit> limits;
        /** How many latest attempts to remember: the largest limit. */
        private final int capacity;

        private final long longestWindowNanos;
        private final int maxKeys;
        /** No new key is accepted while this many keys are all still inside their window; {@link Integer#MAX_VALUE} means no ceiling. */
        private final int hardMaxKeys;
        /** At the ceiling, make room by dropping the stalest keys instead of refusing the new one. */
        private final boolean evictStalest;
        /**
         * User → {@code [number accepted so far, t₀, t₁, … t_(capacity-1)]}: the rest is a ring of timestamps, the
         * k-th attempt (counting from 0) sits in slot {@code 1 + k % capacity}. Only read and written inside
         * {@code compute}.
         */
        private final ConcurrentHashMap<UUID, long[]> history = new ConcurrentHashMap<>();
        /** Prune when the number of people exceeds this; after each prune raise it to twice the number left, so it does not prune on every request. */
        private volatile int pruneAbove;
        /** When the keys were last swept because the map was at the hard ceiling; guarded by {@code this}. */
        private long lastForcedSweepNanos;

        private boolean forcedSweepDone;

        Bucket(List<Limit> limits, int maxKeys) {
            this(limits, maxKeys, Integer.MAX_VALUE, false);
        }

        Bucket(List<Limit> limits, int maxKeys, int hardMaxKeys, boolean evictStalest) {
            this.limits = limits;
            this.capacity = limits.stream().mapToInt(Limit::max).max().orElseThrow();
            this.longestWindowNanos =
                    limits.stream().mapToLong(Limit::windowNanos).max().orElseThrow();
            this.maxKeys = maxKeys;
            this.hardMaxKeys = hardMaxKeys;
            this.evictStalest = evictStalest;
            this.pruneAbove = maxKeys;
        }

        boolean tryAcquire(UUID userId, long now) {
            // At the ceiling a key that is already counted keeps its exact quota; only a NEW key needs room.
            if (history.size() >= hardMaxKeys && !history.containsKey(userId) && !makeRoom(now)) {
                return false;
            }
            boolean[] accepted = new boolean[1];
            history.compute(userId, (key, state) -> {
                long[] ring = state != null ? state : new long[1 + capacity];
                long recorded = ring[0];
                for (Limit limit : limits) {
                    // The max-th from the end is still inside the window: there are already max attempts in the window,
                    // so this one is extra.
                    if (recorded >= limit.max() && now - ring[slot(recorded - limit.max())] < limit.windowNanos()) {
                        return state;
                    }
                }
                ring[slot(recorded)] = now;
                ring[0] = recorded + 1;
                accepted[0] = true;
                return ring;
            });
            if (history.size() > pruneAbove) {
                prune(now);
            }
            return accepted[0];
        }

        private int slot(long index) {
            return 1 + (int) (index % capacity);
        }

        private synchronized void prune(long now) {
            if (history.size() <= pruneAbove) {
                return;
            }
            dropExpired(now);
            pruneAbove = Math.max(maxKeys, history.size() * 2);
        }

        /**
         * The map is at its hard ceiling: sweeps the keys whose window has passed, at most once per
         * {@link #FORCED_SWEEP_INTERVAL_NANOS}, so a flood of new keys cannot make every request scan the whole map.
         *
         * @return whether a new key fits now
         */
        private synchronized boolean makeRoom(long now) {
            if (history.size() < hardMaxKeys) {
                return true;
            }
            if (!forcedSweepDone || now - lastForcedSweepNanos >= FORCED_SWEEP_INTERVAL_NANOS) {
                dropExpired(now);
                forcedSweepDone = true;
                lastForcedSweepNanos = now;
            }
            if (history.size() >= hardMaxKeys && evictStalest) {
                evictStalestKeys();
            }
            return history.size() < hardMaxKeys;
        }

        /**
         * Every key is still inside its window and the map is full: drops the {@code hardMaxKeys / EVICTION_DIVISOR} keys
         * whose latest accepted attempt is the oldest (at least one), so the next that many new keys fit without another
         * pass. Guarded by {@code this}, so one pass runs at a time. The latest-attempt times are read without the key's lock
         * (a victim chosen on a slightly old value costs nothing); each key is removed atomically and only if it is still
         * that stale, so a key that was just used again stays.
         */
        private void evictStalestKeys() {
            int batch = Math.max(1, hardMaxKeys / EVICTION_DIVISOR);
            UUID[] keys = history.keySet().toArray(new UUID[0]);
            if (keys.length == 0) {
                return;
            }
            long[] latest = new long[keys.length];
            for (int i = 0; i < keys.length; i++) {
                long[] ring = history.get(keys[i]);
                // A key that vanished meanwhile sorts first: nothing to remove for it.
                latest[i] = ring == null ? Long.MIN_VALUE : latestAccepted(ring);
            }
            long[] ordered = latest.clone();
            Arrays.sort(ordered);
            long threshold = ordered[Math.min(batch, ordered.length) - 1];
            int removed = 0;
            for (int i = 0; i < keys.length && removed < batch; i++) {
                if (latest[i] > threshold) {
                    continue;
                }
                boolean[] dropped = new boolean[1];
                history.computeIfPresent(keys[i], (key, ring) -> {
                    if (latestAccepted(ring) <= threshold) {
                        dropped[0] = true;
                        return null;
                    }
                    return ring;
                });
                if (dropped[0]) {
                    removed++;
                }
            }
        }

        /** The time of the most recent accepted attempt of a key; a key exists only after one was accepted. */
        private long latestAccepted(long[] ring) {
            return ring[slot(ring[0] - 1)];
        }

        /** Removes every key whose latest accepted attempt has left the longest window: none of its attempts still counts. */
        private void dropExpired(long now) {
            for (UUID userId : history.keySet()) {
                history.computeIfPresent(
                        userId, (key, ring) -> now - latestAccepted(ring) >= longestWindowNanos ? null : ring);
            }
        }
    }
}
