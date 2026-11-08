package com.blog.comment.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/**
 * Keyset cursor of the comment page: exact to the microsecond, only made of
 * characters the Next route accepts, and every malformed form is a 400 and never reaches the SQL statement.
 */
class CommentCursorTest {

    private static String b64(String text) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(text.getBytes(StandardCharsets.US_ASCII));
    }

    @Test
    void encode_then_decode_preserves_instant_to_the_microsecond_and_id() {
        CommentCursor cursor = new CommentCursor(Instant.parse("2026-10-08T03:04:05.123456Z"), UUID.randomUUID());

        String encoded = cursor.encode();

        assertThat(encoded).matches("[A-Za-z0-9_-]{1,200}");
        assertThat(CommentCursor.decode(encoded)).isEqualTo(cursor);
        assertThat(new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.US_ASCII))
                .isEqualTo("1791428645123456:" + cursor.id());
    }

    @Test
    void no_cursor_means_first_page() {
        assertThat(CommentCursor.decode(null)).isNull();
        assertThat(CommentCursor.decode("")).isNull();
    }

    @Test
    void every_malformed_form_is_400_VALIDATION_ERROR() {
        String id = UUID.randomUUID().toString();
        List<String> malformed = List.of(
                "khong phai base64!",
                "a+b/c",
                b64("khong-co-dau-hai-cham"),
                b64(":" + id),
                b64("123:khong-phai-uuid"),
                b64("123:"),
                b64("-5:" + id),
                b64("+5:" + id),
                b64("1e3:" + id),
                b64("99999999999999999999:" + id),
                // One microsecond after 9999-12-31T23:59:59.999999Z: outside the Postgres range and every
                // comment.
                b64("253402300800000000:" + id),
                "A".repeat(121));

        for (String value : malformed) {
            assertThatThrownBy(() -> CommentCursor.decode(value))
                    .as(value)
                    .isInstanceOfSatisfying(ApiException.class, e -> {
                        assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
                        assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                    });
        }
    }
}
