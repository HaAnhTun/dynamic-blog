package com.blog.contact.dto;

/** Response of the public contact endpoint: one constant status, never an echo of a submitted field. */
public record ContactReceivedResponse(ContactState status) {

    public enum ContactState {
        RECEIVED
    }

    public static final ContactReceivedResponse RECEIVED = new ContactReceivedResponse(ContactState.RECEIVED);
}
