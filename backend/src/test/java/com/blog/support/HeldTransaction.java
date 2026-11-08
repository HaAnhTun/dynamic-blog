package com.blog.support;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * A transaction on its own thread: runs {@code work} then waits, holding every lock it just took, until
 * {@link #commit()}. {@link #close()} releases it if the test fails midway.
 *
 * For write-race ITs that do not rely on thread-scheduling luck: this transaction holds a lock, the request that must
 * race is released, and the test waits until Postgres reports that request is waiting on exactly that lock
 * ({@link #awaitWaitingOnLock}), meaning it has passed every step before that SQL statement; only then does it
 * commit.
 */
public final class HeldTransaction implements AutoCloseable {

    private final ExecutorService thread = Executors.newSingleThreadExecutor();
    private final CountDownLatch release = new CountDownLatch(1);
    private final Future<?> outcome;
    /** The last step, run inside this very transaction right before commit; see {@link #commitAfter}. */
    private volatile Consumer<JdbcTemplate> last = jdbc -> {};

    public HeldTransaction(
            PlatformTransactionManager transactionManager, JdbcTemplate jdbcTemplate, Consumer<JdbcTemplate> work)
            throws Exception {
        CountDownLatch held = new CountDownLatch(1);
        outcome = thread.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
            work.accept(jdbcTemplate);
            held.countDown();
            awaitQuietly(release);
            last.accept(jdbcTemplate);
        }));
        if (!held.await(10, TimeUnit.SECONDS)) {
            close();
            throw new AssertionError("The lock-holding transaction did not run within 10 seconds");
        }
    }

    public void commit() throws Exception {
        release.countDown();
        outcome.get(30, TimeUnit.SECONDS);
    }

    /**
     * Runs an extra {@code step} inside this very transaction, still holding every lock taken, then commits: a
     * transaction that takes a lock in two steps (lock a row, then write), with the racing request squeezing in
     * between the two steps. An error from {@code step}, including when Postgres cancels it because of a deadlock, is
     * thrown here.
     */
    public void commitAfter(Consumer<JdbcTemplate> step) throws Exception {
        last = step;
        commit();
    }

    @Override
    public void close() {
        release.countDown();
        thread.shutdownNow();
    }

    /**
     * Waits until {@code sessions} Postgres sessions are waiting for a lock while running a statement containing
     * {@code sqlFragment}: proof that the requests reached exactly that statement, not merely that they are "not
     * finished".
     */
    public static void awaitWaitingOnLock(JdbcTemplate jdbcTemplate, String sqlFragment, int sessions)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        long waiting;
        while ((waiting = waitingOnLock(jdbcTemplate, sqlFragment)) < sessions) {
            if (System.nanoTime() > deadline) {
                throw new AssertionError(
                        "Only " + waiting + "/" + sessions + " sessions are waiting for the lock at: " + sqlFragment);
            }
            Thread.sleep(20);
        }
    }

    private static long waitingOnLock(JdbcTemplate jdbcTemplate, String sqlFragment) {
        return jdbcTemplate.queryForObject("""
                SELECT count(*) FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock' AND position(? IN query) > 0""", Long.class, sqlFragment);
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(60, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
