package com.blog.notification.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.notification.repository.NotificationRow;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.UUID;
import org.springframework.http.HttpStatus;

/**
 * Keyset cursor of the notification list: the same form and the same validation as the comment cursor
 * (CommentCursor), {@code base64url("<created_at in microseconds since epoch>:<id>")}, without the {@code =}
 * padding. A copy rather than shared code, so the comment path that is already running needs no change.
 *
 * {@code created_at} comes from the DB's {@code now()} so it is exact to the microsecond, and the cursor compares
 * that value exactly. Two notifications of the same transaction share {@code created_at} and are ordered by id.
 * Opaque to clients: every malformed form is a 400.
 */
record NotificationCursor(Instant createdAt, UUID id) {

    /** Longer than any real cursor (about 75 characters): rejects large strings before decoding. */
    private static final int MAX_ENCODED_LENGTH = 120;
    /** 9999-12-31T23:59:59.999999Z: Postgres cannot represent anything beyond this, and no notification is there. */
    private static final long MAX_MICROS = 253_402_300_799_999_999L;

    /** The position of this notification in the list. */
    static NotificationCursor of(NotificationRow row) {
        return new NotificationCursor(row.getCreatedAt(), row.getId());
    }

    String encode() {
        long micros = ChronoUnit.MICROS.between(Instant.EPOCH, createdAt);
        return Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString((micros + ":" + id).getBytes(StandardCharsets.US_ASCII));
    }

    /**
     * @return null when there is no cursor, including an empty string
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the cursor is malformed
     */
    static NotificationCursor decode(String encoded) {
        if (encoded == null || encoded.isEmpty()) {
            return null;
        }
        if (encoded.length() > MAX_ENCODED_LENGTH) {
            throw invalid();
        }
        try {
            String text = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.US_ASCII);
            int colon = text.indexOf(':');
            if (colon <= 0) {
                throw invalid();
            }
            String microsPart = text.substring(0, colon);
            if (!microsPart.chars().allMatch(ch -> ch >= '0' && ch <= '9')) {
                throw invalid();
            }
            long micros = Long.parseLong(microsPart);
            if (micros > MAX_MICROS) {
                throw invalid();
            }
            UUID id = UUID.fromString(text.substring(colon + 1));
            return new NotificationCursor(Instant.EPOCH.plus(micros, ChronoUnit.MICROS), id);
        } catch (IllegalArgumentException e) {
            // Bad Base64, a number too large for a long, a bad UUID: NumberFormatException is also an
            // IllegalArgumentException.
            throw invalid();
        }
    }

    private static ApiException invalid() {
        return new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "Invalid notification cursor");
    }
}
