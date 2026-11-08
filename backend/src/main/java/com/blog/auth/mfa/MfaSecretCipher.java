package com.blog.auth.mfa;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Encrypts the TOTP secrets at rest with AES-256-GCM and the dedicated key {@code MFA_ENCRYPTION_KEY}.
 *
 * <h2>Format</h2>
 * {@code iv (12 bytes, SecureRandom, new on every write) || ciphertext || tag (16 bytes)}. The additional authenticated
 * data is the account id (16 bytes) followed by a purpose label in ASCII, so a ciphertext copied to another account's row
 * fails to decrypt, and a pending ciphertext cannot be pasted into the active column either (the two labels differ).
 *
 * <h2>Why a key of its own</h2>
 * It is not derived from {@code JWT_SECRET}: rotating the JWT secret is a routine answer to a leak and must not lock every
 * enrolled person out, and a JWT secret leak must not decrypt TOTP seeds. It is not stored in the database either: a dump
 * would then carry the key next to the ciphertext.
 *
 * {@link #keyId()} is the first two bytes of the SHA-256 of the key: a non-secret fingerprint stored with every row, so a
 * later key rotation needs no migration. This class never logs, and no exception message carries a key, a secret or a
 * ciphertext.
 */
public final class MfaSecretCipher {

    /** What a ciphertext is for; each purpose has its own additional authenticated data. */
    public enum Purpose {
        ACTIVE("mfa-secret-v1"),
        PENDING("mfa-pending-v1");

        private final String label;

        Purpose(String label) {
            this.label = label;
        }
    }

    /** Raised when a stored ciphertext cannot be decrypted: a different key, another row's data, or damage. */
    public static final class UndecryptableException extends RuntimeException {
        public UndecryptableException() {
            super("The stored two-step verification secret cannot be decrypted");
        }
    }

    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final SecretKeySpec key;
    private final short keyId;
    private final SecureRandom random;

    public MfaSecretCipher(byte[] keyBytes) {
        this(keyBytes, new SecureRandom());
    }

    MfaSecretCipher(byte[] keyBytes, SecureRandom random) {
        if (keyBytes == null || keyBytes.length != MfaProperties.KEY_BYTES) {
            throw new IllegalArgumentException("The key must be " + MfaProperties.KEY_BYTES + " bytes, not "
                    + (keyBytes == null ? 0 : keyBytes.length));
        }
        this.key = new SecretKeySpec(keyBytes, "AES");
        this.keyId = fingerprint(keyBytes);
        this.random = random;
    }

    /** The non-secret fingerprint of the key, stored in {@code user_mfa.key_id}. */
    public short keyId() {
        return keyId;
    }

    public static short fingerprint(byte[] keyBytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(keyBytes);
            return (short) (((digest[0] & 0xff) << 8) | (digest[1] & 0xff));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required by every JVM", e);
        }
    }

    public byte[] encrypt(UUID userId, Purpose purpose, byte[] plain) {
        byte[] iv = new byte[IV_BYTES];
        random.nextBytes(iv);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            cipher.updateAAD(aad(userId, purpose));
            byte[] encrypted = cipher.doFinal(plain);
            return ByteBuffer.allocate(IV_BYTES + encrypted.length)
                    .put(iv)
                    .put(encrypted)
                    .array();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("The two-step verification secret could not be encrypted");
        }
    }

    /** @throws UndecryptableException for any failure: wrong key, another account's or purpose's data, damage */
    public byte[] decrypt(UUID userId, Purpose purpose, byte[] stored) {
        if (stored == null || stored.length < IV_BYTES + TAG_BITS / 8) {
            throw new UndecryptableException();
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                    Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, Arrays.copyOfRange(stored, 0, IV_BYTES)));
            cipher.updateAAD(aad(userId, purpose));
            return cipher.doFinal(stored, IV_BYTES, stored.length - IV_BYTES);
        } catch (GeneralSecurityException e) {
            throw new UndecryptableException();
        }
    }

    private static byte[] aad(UUID userId, Purpose purpose) {
        byte[] label = purpose.label.getBytes(StandardCharsets.US_ASCII);
        return ByteBuffer.allocate(Long.BYTES * 2 + label.length)
                .putLong(userId.getMostSignificantBits())
                .putLong(userId.getLeastSignificantBits())
                .put(label)
                .array();
    }

    /**
     * Fail-closed rule for the key in a production run, static so it can be tested without a context: the committed dev
     * key, or the same secret as {@code JWT_SECRET}, is refused. Both are compared as the bytes the key decodes to, not as
     * text, because the decoder reads several spellings (no padding, other last character) as the same bytes. Never a
     * value in the message.
     *
     * @param production {@code ProductionMode.active()}
     */
    public static void refuseUnsafeKey(String configuredKey, String jwtSecret, boolean production) {
        if (!production || configuredKey == null) {
            return;
        }
        if (MfaProperties.isDevelopmentKey(configuredKey)) {
            throw new IllegalStateException("MFA_ENCRYPTION_KEY is the development key committed to this repository, "
                    + "and this is not an opted-in development run (Spring profile dev or APP_ALLOW_DEV_DEFAULTS=true, "
                    + "with SITE_URL empty or loopback), so anyone who reads the repository could decrypt the "
                    + "two-step verification secrets. Set MFA_ENCRYPTION_KEY to a new random value "
                    + "(openssl rand -base64 32).");
        }
        if (sharesTheJwtSecret(configuredKey.strip(), jwtSecret)) {
            throw new IllegalStateException("MFA_ENCRYPTION_KEY has the same value as JWT_SECRET. They protect "
                    + "different things and the JWT secret is rotated after a leak: give each its own random value "
                    + "(openssl rand -base64 32).");
        }
    }

    private static boolean sharesTheJwtSecret(String key, String jwtSecret) {
        if (jwtSecret == null || jwtSecret.isBlank()) {
            return false;
        }
        String secret = jwtSecret.strip();
        if (secret.equals(key)) {
            return true;
        }
        byte[] keyBytes = MfaProperties.decodedOrNull(key);
        return MfaProperties.sameBytes(keyBytes, MfaProperties.decodedOrNull(secret))
                || MfaProperties.sameBytes(keyBytes, secret.getBytes(StandardCharsets.UTF_8));
    }
}
