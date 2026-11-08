package com.blog.postimport.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The opaque preview state: it round-trips, carries no text, and anything it did not write does not decode. */
class PreviewStateTest {

    private static final String HASH = "a".repeat(64);

    private static String encoded(String plain) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(plain.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void a_new_file_state_has_no_target_and_round_trips() {
        PreviewState state = PreviewState.forNew();

        assertThat(state.postId()).isNull();
        assertThat(state.status()).isNull();
        assertThat(state.stateHash()).isNull();
        assertThat(PreviewState.decode(state.encode())).contains(state);
    }

    @Test
    void a_new_file_state_may_carry_the_hash_of_what_it_does_with_a_series_and_round_trips() {
        PreviewState state = PreviewState.forNew(HASH);

        assertThat(state.postId()).isNull();
        assertThat(state.stateHash()).isEqualTo(HASH);
        assertThat(PreviewState.decode(state.encode())).contains(state);
        assertThat(state.encode()).isNotEqualTo(PreviewState.forNew().encode());
    }

    @Test
    void an_update_state_round_trips_with_its_post_status_and_hash() {
        PreviewState state = new PreviewState(PreviewState.ACTION_UPDATE, UUID.randomUUID(), "PUBLISHED", HASH);

        assertThat(PreviewState.decode(state.encode())).contains(state);
    }

    @Test
    void the_encoded_form_is_url_safe_text_without_padding() {
        PreviewState state = new PreviewState(PreviewState.ACTION_UPDATE, UUID.randomUUID(), "DRAFT", HASH);

        assertThat(state.encode()).matches("[A-Za-z0-9_-]+");
    }

    @Test
    void anything_the_encoder_did_not_write_does_not_decode() {
        String id = UUID.randomUUID().toString();

        assertThat(PreviewState.decode(null)).isEmpty();
        assertThat(PreviewState.decode("")).isEmpty();
        assertThat(PreviewState.decode("not base64 !!")).isEmpty();
        assertThat(PreviewState.decode(encoded("new"))).isEmpty();
        assertThat(PreviewState.decode(encoded("new|" + id + "||"))).isEmpty();
        assertThat(PreviewState.decode(encoded("new||DRAFT|" + HASH))).isEmpty();
        assertThat(PreviewState.decode(encoded("new|||" + "z".repeat(64)))).isEmpty();
        assertThat(PreviewState.decode(encoded("delete||||"))).isEmpty();
        assertThat(PreviewState.decode(encoded("update|" + id + "|DRAFT|" + HASH + "|extra")))
                .isEmpty();
        assertThat(PreviewState.decode(encoded("update|not-a-uuid|DRAFT|" + HASH)))
                .isEmpty();
        assertThat(PreviewState.decode(encoded("update|" + id + "|draft text|" + HASH)))
                .isEmpty();
        assertThat(PreviewState.decode(encoded("update|" + id + "|DRAFT|" + "z".repeat(64))))
                .isEmpty();
        assertThat(PreviewState.decode(encoded("update|" + id + "|DRAFT|"))).isEmpty();
    }
}
