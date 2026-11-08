package com.blog.newsletter.service;

import com.blog.newsletter.mail.MailFailure;
import com.blog.newsletter.mail.MailTransport;
import com.blog.newsletter.mail.MailTransportException;
import com.blog.newsletter.repository.NewsletterRepository;
import com.blog.newsletter.repository.NewsletterRepository.DueDelivery;
import com.blog.newsletter.repository.NewsletterRepository.Subscriber;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The newsletter worker, never run inside any request: NewsletterSchedule calls {@link #runOnce()} on a schedule, IT
 * calls it directly. Each run has four steps, each row in its own short transaction locked with
 * {@code FOR UPDATE SKIP LOCKED}, at most {@value #BATCH} rows per step:
 * <ol>
 *   <li>delete subscriptions left unconfirmed for more than 7 days since the most recent request;</li>
 *   <li>confirmation mail: a new 32-byte token, the DB keeps only its SHA-256 and a 48-hour expiry; if sending fails it rolls back and the row waits for the next run;</li>
 *   <li>expand each issue of a published post into one delivery per confirmed subscriber;</li>
 *   <li>send due deliveries: on failure retry after 1 minute, 5 minutes, 30 minutes, 2 hours, 12 hours, and a sixth failure makes it DEAD.</li>
 * </ol>
 * A failure of the whole mail server ({@link MailFailure#providerWide()}) stops that step until the next run. The log has only ids and error codes.
 */
@Component
public class NewsletterWorker {

    private static final Logger log = LoggerFactory.getLogger(NewsletterWorker.class);

    static final Duration CONFIRMATION_TTL = Duration.ofHours(48);
    static final Duration PENDING_RETENTION = Duration.ofDays(7);
    /** Wait before retry 1..5; a delivery that fails once more after the 5th retry becomes DEAD. */
    static final List<Duration> BACKOFF = List.of(
            Duration.ofMinutes(1),
            Duration.ofMinutes(5),
            Duration.ofMinutes(30),
            Duration.ofHours(2),
            Duration.ofHours(12));

    static final int BATCH = 50;
    /** Code of a delivery to an address that has a suppression row: not sent, not retried. */
    static final String SUPPRESSED = "SUPPRESSED";

    private final NewsletterRepository repository;
    private final NewsletterComposer composer;
    private final NewsletterTokens tokens;
    private final MailTransport transport;
    private final TransactionTemplate transaction;
    private final Clock clock;

    public NewsletterWorker(
            NewsletterRepository repository,
            NewsletterComposer composer,
            NewsletterTokens tokens,
            MailTransport transport,
            PlatformTransactionManager transactionManager,
            Clock clock) {
        this.repository = repository;
        this.composer = composer;
        this.tokens = tokens;
        this.transport = transport;
        this.transaction = new TransactionTemplate(transactionManager);
        this.clock = clock;
    }

    /** Number of rows each step handled in one run. */
    public record RunSummary(
            int purged,
            int confirmationsSent,
            int confirmationsFailed,
            int issuesExpanded,
            int deliveriesSent,
            int deliveriesFailed) {

        boolean idle() {
            return purged + confirmationsSent + confirmationsFailed + issuesExpanded + deliveriesSent + deliveriesFailed
                    == 0;
        }
    }

    public RunSummary runOnce() {
        int purged = transaction.execute(
                status -> repository.deleteStalePending(clock.instant().minus(PENDING_RETENTION), BATCH));
        int[] confirmations = sendConfirmations();
        int expanded = expandIssues();
        int[] deliveries = sendDeliveries();
        RunSummary summary =
                new RunSummary(purged, confirmations[0], confirmations[1], expanded, deliveries[0], deliveries[1]);
        if (!summary.idle()) {
            log.info("newsletter worker: {}", summary);
        }
        return summary;
    }

    private int[] sendConfirmations() {
        int sent = 0;
        int failed = 0;
        for (UUID id : repository.dueConfirmations(BATCH)) {
            MailFailure failure;
            try {
                if (Boolean.TRUE.equals(transaction.execute(status -> sendConfirmation(id)))) {
                    sent++;
                }
                continue;
            } catch (MailTransportException e) {
                failure = e.failure();
            } catch (RuntimeException e) {
                // Do not log the message: a JavaMail or SQL error can echo the address.
                failure = MailFailure.UNKNOWN;
            }
            failed++;
            log.warn("newsletter confirmation for subscriber {} not sent: {}", id, failure);
            if (failure.providerWide()) {
                break;
            }
        }
        return new int[] {sent, failed};
    }

    /** Throws when sending fails, so the new hash rolls back with it: the row stays due, and the next run sends again with a different token. */
    private boolean sendConfirmation(UUID id) {
        Optional<Subscriber> subscriber = repository.lockDueConfirmation(id);
        if (subscriber.isEmpty()) {
            return false;
        }
        String token = NewsletterTokens.newConfirmationToken();
        Instant now = clock.instant();
        repository.markConfirmationSent(id, NewsletterTokens.sha256Hex(token), now.plus(CONFIRMATION_TTL), now);
        transport.send(composer.confirmation(
                id, subscriber.get().email(), subscriber.get().locale(), token));
        return true;
    }

    private int expandIssues() {
        int expanded = 0;
        for (UUID postId : repository.pendingIssues(BATCH)) {
            Boolean done = inTransaction("issue", postId, () -> {
                if (!repository.lockPendingIssue(postId)) {
                    return false;
                }
                Instant now = clock.instant();
                repository.expand(postId, now);
                repository.markExpanded(postId, now);
                return true;
            });
            if (Boolean.TRUE.equals(done)) {
                expanded++;
            }
        }
        return expanded;
    }

    private enum Outcome {
        SKIPPED,
        SENT,
        FAILED,
        PROVIDER_DOWN
    }

    private int[] sendDeliveries() {
        int sent = 0;
        int failed = 0;
        for (UUID id : repository.dueDeliveries(clock.instant(), BATCH)) {
            Outcome outcome = inTransaction("delivery", id, () -> sendDelivery(id));
            if (outcome == Outcome.SENT) {
                sent++;
            } else if (outcome != Outcome.SKIPPED) {
                failed++;
            }
            if (outcome == Outcome.PROVIDER_DOWN) {
                break;
            }
        }
        return new int[] {sent, failed};
    }

    private Outcome sendDelivery(UUID id) {
        Instant now = clock.instant();
        Optional<DueDelivery> due = repository.lockDueDelivery(id, now);
        if (due.isEmpty()) {
            return Outcome.SKIPPED;
        }
        DueDelivery delivery = due.get();
        if (repository.isSuppressed(tokens.suppressionHash(delivery.email()))) {
            repository.markFailed(id, "DEAD", delivery.attempts(), now, SUPPRESSED);
            log.warn("newsletter delivery {} skipped: the address is suppressed", id);
            return Outcome.FAILED;
        }
        MailFailure failure = null;
        try {
            // At least once: if the process dies after the mail went out but before the commit, the row stays due and
            // the mail is
            // sent exactly one more time. The unique key (post_id, subscriber_id) still blocks any second mail caused
            // by repeated issue expansion.
            transport.send(composer.issue(delivery));
        } catch (MailTransportException e) {
            failure = e.failure();
        } catch (RuntimeException e) {
            failure = MailFailure.UNKNOWN;
        }
        if (failure == null) {
            repository.markSent(id, now);
            return Outcome.SENT;
        }
        int attempts = delivery.attempts() + 1;
        boolean dead = attempts > BACKOFF.size();
        repository.markFailed(
                id,
                dead ? "DEAD" : "RETRYING",
                attempts,
                dead ? now : now.plus(BACKOFF.get(attempts - 1)),
                failure.name());
        log.warn("newsletter delivery {} failed: {} (attempt {}{})", id, failure, attempts, dead ? ", giving up" : "");
        return failure.providerWide() ? Outcome.PROVIDER_DOWN : Outcome.FAILED;
    }

    /**
     * One row, one transaction. A DB error on one row (such as a foreign key when an unsubscribe commits in between) does not
     * stop the whole run: that row rolls back and waits for the next run. Logs only the error type: an SQL error echoes the whole faulty row, address included.
     */
    private <T> T inTransaction(String kind, UUID id, Supplier<T> work) {
        try {
            return transaction.execute(status -> work.get());
        } catch (RuntimeException e) {
            log.warn("newsletter {} {} rolled back: {}", kind, id, e.getClass().getName());
            return null;
        }
    }
}
