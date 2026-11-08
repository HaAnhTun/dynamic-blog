package com.blog.auth.mfa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.auth.mfa.MfaSecretCipher.Purpose;
import com.blog.auth.mfa.MfaSecretCipher.UndecryptableException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The at-rest encryption of TOTP secrets: AES-256-GCM, the account and the purpose are authenticated data. */
class MfaSecretCipherTest {

    private static final UUID USER = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final byte[] SECRET = MfaSecrets.generate(new SecureRandom());

    private static byte[] key(int seed) {
        byte[] key = new byte[MfaProperties.KEY_BYTES];
        Arrays.fill(key, (byte) seed);
        return key;
    }

    private final MfaSecretCipher cipher = new MfaSecretCipher(key(1));

    @Test
    void a_secret_round_trips() {
        byte[] stored = cipher.encrypt(USER, Purpose.ACTIVE, SECRET);

        assertThat(cipher.decrypt(USER, Purpose.ACTIVE, stored)).isEqualTo(SECRET);
    }

    @Test
    void the_stored_form_is_iv_then_ciphertext_then_tag_and_hides_the_secret() {
        byte[] stored = cipher.encrypt(USER, Purpose.ACTIVE, SECRET);

        // 12-byte IV + 20 bytes of ciphertext + 16-byte tag.
        assertThat(stored).hasSize(12 + SECRET.length + 16);
        assertThat(new String(stored, java.nio.charset.StandardCharsets.ISO_8859_1))
                .doesNotContain(new String(SECRET, java.nio.charset.StandardCharsets.ISO_8859_1));
        assertThat(java.util.HexFormat.of().formatHex(stored))
                .doesNotContain(java.util.HexFormat.of().formatHex(SECRET));
    }

    @Test
    void two_encryptions_of_one_secret_differ_because_the_iv_is_new_every_time() {
        byte[] first = cipher.encrypt(USER, Purpose.ACTIVE, SECRET);
        byte[] second = cipher.encrypt(USER, Purpose.ACTIVE, SECRET);

        assertThat(first).isNotEqualTo(second);
        assertThat(Arrays.copyOfRange(first, 0, 12)).isNotEqualTo(Arrays.copyOfRange(second, 0, 12));
    }

    @Test
    void a_flipped_byte_anywhere_fails() {
        byte[] stored = cipher.encrypt(USER, Purpose.ACTIVE, SECRET);
        for (int i = 0; i < stored.length; i++) {
            byte[] damaged = stored.clone();
            damaged[i] ^= 0x01;
            assertThatThrownBy(() -> cipher.decrypt(USER, Purpose.ACTIVE, damaged))
                    .isInstanceOf(UndecryptableException.class);
        }
    }

    @Test
    void a_ciphertext_copied_to_another_account_fails() {
        byte[] stored = cipher.encrypt(USER, Purpose.ACTIVE, SECRET);

        assertThatThrownBy(() -> cipher.decrypt(UUID.randomUUID(), Purpose.ACTIVE, stored))
                .isInstanceOf(UndecryptableException.class);
    }

    @Test
    void a_pending_ciphertext_does_not_decrypt_as_an_active_one_and_the_reverse() {
        byte[] pending = cipher.encrypt(USER, Purpose.PENDING, SECRET);
        byte[] active = cipher.encrypt(USER, Purpose.ACTIVE, SECRET);

        assertThatThrownBy(() -> cipher.decrypt(USER, Purpose.ACTIVE, pending))
                .isInstanceOf(UndecryptableException.class);
        assertThatThrownBy(() -> cipher.decrypt(USER, Purpose.PENDING, active))
                .isInstanceOf(UndecryptableException.class);
        assertThat(cipher.decrypt(USER, Purpose.PENDING, pending)).isEqualTo(SECRET);
    }

    @Test
    void another_key_cannot_decrypt() {
        byte[] stored = cipher.encrypt(USER, Purpose.ACTIVE, SECRET);

        assertThatThrownBy(() -> new MfaSecretCipher(key(2)).decrypt(USER, Purpose.ACTIVE, stored))
                .isInstanceOf(UndecryptableException.class);
    }

    @Test
    void too_short_or_missing_data_is_undecryptable_not_an_internal_error() {
        for (byte[] bad : new byte[][] {null, new byte[0], new byte[27]}) {
            assertThatThrownBy(() -> cipher.decrypt(USER, Purpose.ACTIVE, bad))
                    .isInstanceOf(UndecryptableException.class);
        }
    }

    @Test
    void the_undecryptable_message_carries_no_data() {
        byte[] stored = cipher.encrypt(USER, Purpose.ACTIVE, SECRET);
        stored[20] ^= 0x01;

        assertThatThrownBy(() -> cipher.decrypt(USER, Purpose.ACTIVE, stored))
                .hasMessageNotContaining(MfaSecrets.encode(SECRET))
                .hasMessageNotContaining(USER.toString());
    }

    @Test
    void a_key_of_the_wrong_length_is_rejected() {
        assertThatThrownBy(() -> new MfaSecretCipher(new byte[16])).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MfaSecretCipher(new byte[33])).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MfaSecretCipher(null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void the_key_id_is_a_stable_fingerprint_that_differs_between_keys() {
        assertThat(new MfaSecretCipher(key(1)).keyId()).isEqualTo(cipher.keyId());
        assertThat(new MfaSecretCipher(key(2)).keyId()).isNotEqualTo(cipher.keyId());
        assertThat(MfaSecretCipher.fingerprint(key(1))).isEqualTo(cipher.keyId());
    }

    @Test
    void the_toString_of_the_properties_hides_every_secret() {
        String key = Base64.getEncoder().encodeToString(key(7));
        MfaProperties properties = new MfaProperties(
                key,
                "Blog",
                java.time.Duration.ofMinutes(5),
                java.time.Duration.ofMinutes(10),
                "enrollment-token-0123456789abcdef",
                "owner@example.test",
                "reset-token-0123456789abcdefghij");

        assertThat(properties.toString())
                .doesNotContain(key)
                .doesNotContain("enrollment-token")
                .doesNotContain("owner@example.test")
                .doesNotContain("reset-token");
    }

    @Test
    void the_committed_dev_key_is_recognised_and_is_a_valid_key() {
        assertThat(MfaProperties.requireKeyBytes(MfaProperties.DEV_ENCRYPTION_KEY))
                .hasSize(MfaProperties.KEY_BYTES);
        assertThat(MfaProperties.DEV_ENCRYPTION_KEY).isNotBlank();
    }
}
