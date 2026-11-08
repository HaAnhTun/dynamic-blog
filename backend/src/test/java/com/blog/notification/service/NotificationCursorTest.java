package com.blog.notification.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.notification.repository.NotificationRow;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/**
 * Keyset cursor of the notification list: same shape as the comment cursor, exact to
 * the microsecond, only made of characters the Next route accepts, and every malformed form is a 400 "Invalid
 * notification cursor", never leaking into the SQL.
 */
class NotificationCursorTest {

    private static String b64(String text) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(text.getBytes(StandardCharsets.US_ASCII));
    }

    @Test
    void encode_then_decode_preserves_instant_to_the_microsecond_and_id() {
        NotificationCursor cursor =
                new NotificationCursor(Instant.parse("2026-10-08T03:04:05.123456Z"), UUID.randomUUID());

        String encoded = cursor.encode();

        assertThat(encoded).matches("[A-Za-z0-9_-]{1,120}");
        assertThat(NotificationCursor.decode(encoded)).isEqualTo(cursor);
        assertThat(new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.US_ASCII))
                .isEqualTo("1791428645123456:" + cursor.id());
    }

    @Test
    void cursor_of_a_row_is_its_instant_and_id() {
        Instant at = Instant.parse("2026-10-08T03:04:05.000001Z");
        UUID id = UUID.randomUUID();
        NotificationRow row = row(at, id);

        assertThat(NotificationCursor.of(row)).isEqualTo(new NotificationCursor(at, id));
    }

    @Test
    void no_cursor_means_no_bound() {
        assertThat(NotificationCursor.decode(null)).isNull();
        assertThat(NotificationCursor.decode("")).isNull();
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
                // notification.
                b64("253402300800000000:" + id),
                "A".repeat(121));

        for (String value : malformed) {
            assertThatThrownBy(() -> NotificationCursor.decode(value))
                    .as(value)
                    .isInstanceOfSatisfying(ApiException.class, e -> {
                        assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
                        assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(e.getMessage()).isEqualTo("Invalid notification cursor");
                    });
        }
    }

    private static NotificationRow row(Instant createdAt, UUID id) {
        return new NotificationRow() {
            @Override
            public UUID getId() {
                return id;
            }

            @Override
            public String getType() {
                return "POST_LIKED";
            }

            @Override
            public Instant getCreatedAt() {
                return createdAt;
            }

            @Override
            public boolean getRead() {
                return false;
            }

            @Override
            public String getActorDisplayName() {
                return "Reader";
            }

            @Override
            public String getActorGithubLogin() {
                return null;
            }

            @Override
            public String getActorAvatarUrl() {
                return null;
            }

            @Override
            public String getPostSlug() {
                return "bai-viet";
            }

            @Override
            public String getPostTitle() {
                return "Post";
            }

            @Override
            public UUID getCommentId() {
                return null;
            }

            @Override
            public String getCommentContent() {
                return null;
            }
        };
    }
}
