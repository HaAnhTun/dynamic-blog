package com.blog.comment.service;

import com.blog.comment.entity.Comment;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.UUID;
import org.springframework.http.HttpStatus;

/**
 * Keyset cursor of a comment page: {@code base64url("<created_at in microseconds since epoch>:<id>")} of the last
 * root comment of the previous page, without the {@code =} padding (Next routes only accept {@code [A-Za-z0-9_-]}).
 *
 * Microseconds because that is the precision Postgres stores and Comment truncates to on creation: the cursor
 * compares exactly against the value in the DB, and rounding to a millisecond would repeat or skip comments within
 * the same millisecond. Opaque to clients: nobody may rely on the contents, and every malformed form is a 400.
 */
record CommentCursor(Instant createdAt, UUID id) {

    /** Longer than any real cursor (about 75 characters): rejects large strings before decoding. */
    private static final int MAX_ENCODED_LENGTH = 120;
    /** 9999-12-31T23:59:59.999999Z: Postgres cannot represent anything beyond this, and no comment is there. */
    private static final long MAX_MICROS = 253_402_300_799_999_999L;

    /** The position right after this root comment. */
    static CommentCursor after(Comment root) {
        return new CommentCursor(root.getCreatedAt(), root.getId());
    }

    String encode() {
        long micros = ChronoUnit.MICROS.between(Instant.EPOCH, createdAt);
        return Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString((micros + ":" + id).getBytes(StandardCharsets.US_ASCII));
    }

    /**
     * @return null when there is no cursor (first page), including an empty string
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the cursor is malformed
     */
    static CommentCursor decode(String encoded) {
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
            return new CommentCursor(Instant.EPOCH.plus(micros, ChronoUnit.MICROS), id);
        } catch (IllegalArgumentException e) {
            // Bad Base64, a number too large for a long, a bad UUID: NumberFormatException is also an
            // IllegalArgumentException.
            throw invalid();
        }
    }

    private static ApiException invalid() {
        return new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "Invalid comment cursor");
    }
}
