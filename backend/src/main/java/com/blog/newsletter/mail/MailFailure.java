package com.blog.newsletter.mail;

import jakarta.mail.AuthenticationFailedException;
import jakarta.mail.SendFailedException;
import jakarta.mail.internet.AddressException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import javax.net.ssl.SSLException;
import org.springframework.mail.MailAuthenticationException;
import org.springframework.mail.MailSendException;

/**
 * Failure reasons that may be stored and logged: {@code newsletter_deliveries.last_error} accepts only these codes,
 * never the provider's message, which could echo the recipient's address.
 */
public enum MailFailure {
    CONNECTION_FAILED,
    TIMEOUT,
    AUTH_FAILED,
    REJECTED,
    INVALID_ADDRESS,
    UNKNOWN;

    /** A failure of the whole mail server, not of one mail: the worker stops that step until the next round instead of trying every remaining mail. */
    public boolean providerWide() {
        return this == CONNECTION_FAILED || this == TIMEOUT || this == AUTH_FAILED;
    }

    /** The code of a JavaMail or Spring Mail error, judged only by its type and the types of its causes; reads no message. */
    public static MailFailure classify(Throwable error) {
        Deque<Throwable> pending = new ArrayDeque<>(List.of(error));
        Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        while (!pending.isEmpty()) {
            Throwable current = pending.pop();
            if (!seen.add(current)) {
                continue;
            }
            MailFailure failure = of(current);
            if (failure != null) {
                return failure;
            }
            // JavaMailSenderImpl collects the per-mail errors here, often without setting a cause.
            if (current instanceof MailSendException send) {
                Collections.addAll(pending, send.getMessageExceptions());
            }
            if (current.getCause() != null) {
                pending.push(current.getCause());
            }
        }
        return UNKNOWN;
    }

    private static MailFailure of(Throwable error) {
        if (error instanceof SocketTimeoutException) {
            return TIMEOUT;
        }
        if (error instanceof MailAuthenticationException || error instanceof AuthenticationFailedException) {
            return AUTH_FAILED;
        }
        if (error instanceof SocketException
                || error instanceof UnknownHostException
                || error instanceof SSLException) {
            return CONNECTION_FAILED;
        }
        if (error instanceof AddressException) {
            return INVALID_ADDRESS;
        }
        if (error instanceof SendFailedException failed) {
            return failed.getInvalidAddresses() != null && failed.getInvalidAddresses().length > 0
                    ? INVALID_ADDRESS
                    : REJECTED;
        }
        return null;
    }
}
