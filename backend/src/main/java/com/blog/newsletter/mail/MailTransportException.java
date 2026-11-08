package com.blog.newsletter.mail;

/**
 * Sending a mail failed. Carries only a safe code, never the original exception: the provider's message could echo an
 * address, and an exception with a cause sooner or later gets its whole stack trace logged by someone.
 */
public class MailTransportException extends RuntimeException {

    private final MailFailure failure;

    public MailTransportException(MailFailure failure) {
        super(failure.name(), null, false, false);
        this.failure = failure;
    }

    public MailFailure failure() {
        return failure;
    }
}
