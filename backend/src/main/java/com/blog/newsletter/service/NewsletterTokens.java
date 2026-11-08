package com.blog.newsletter.service;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Newsletter cryptography:
 * <ul>
 *   <li>confirmation token: 32 random bytes, base64url; the DB keeps only {@link #sha256Hex};</li>
 *   <li>unsubscribe token: base64url(16 bytes of subscriber id || first 16 bytes of HMAC-SHA256(key, "unsubscribe:" + id)),
 *       stored nowhere, valid until {@code NEWSLETTER_SECRET} changes;</li>
 *   <li>suppression hash: HMAC-SHA256(key, normalized address), as hex.</li>
 * </ul>
 * Both token kinds have the same shape, which the BFF checks before calling the backend: {@code ^[A-Za-z0-9_-]{20,200}$}.
 */
public final class NewsletterTokens {

    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{20,200}");
    private static final int TOKEN_BYTES = 32;
    private static final int ID_BYTES = 16;
    private static final int MAC_BYTES = 16;
    private static final String HMAC_SHA256 = "HmacSHA256";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();

    private final byte[] key;

    public NewsletterTokens(byte[] key) {
        this.key = key.clone();
    }

    /** The shape shared by confirmation and unsubscribe tokens. */
    public static boolean wellFormed(String token) {
        return token != null && TOKEN.matcher(token).matches();
    }

    public static String newConfirmationToken() {
        byte[] bytes = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(bytes);
        return ENCODER.encodeToString(bytes);
    }

    public static String sha256Hex(String value) {
        try {
            return HexFormat.of()
                    .formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("SHA-256 is required by every JVM", e);
        }
    }

    public String unsubscribeToken(UUID subscriberId) {
        byte[] id = idBytes(subscriberId);
        byte[] token = Arrays.copyOf(id, ID_BYTES + MAC_BYTES);
        System.arraycopy(unsubscribeMac(subscriberId), 0, token, ID_BYTES, MAC_BYTES);
        return ENCODER.encodeToString(token);
    }

    /** @return the subscriber id when the token is well-formed and the MAC is right; the MAC is compared in constant time */
    public Optional<UUID> unsubscribeId(String token) {
        if (!wellFormed(token)) {
            return Optional.empty();
        }
        byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(token);
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        if (decoded.length != ID_BYTES + MAC_BYTES) {
            return Optional.empty();
        }
        ByteBuffer buffer = ByteBuffer.wrap(decoded);
        UUID id = new UUID(buffer.getLong(), buffer.getLong());
        byte[] mac = Arrays.copyOfRange(decoded, ID_BYTES, ID_BYTES + MAC_BYTES);
        return MessageDigest.isEqual(unsubscribeMac(id), mac) ? Optional.of(id) : Optional.empty();
    }

    /** @param normalizedEmail an address that has been through {@link EmailAddresses#normalize} */
    public String suppressionHash(String normalizedEmail) {
        return HexFormat.of().formatHex(hmac(normalizedEmail));
    }

    private byte[] unsubscribeMac(UUID subscriberId) {
        return Arrays.copyOf(hmac("unsubscribe:" + subscriberId), MAC_BYTES);
    }

    private byte[] hmac(String value) {
        try {
            Mac mac = Mac.getInstance(HMAC_SHA256);
            mac.init(new SecretKeySpec(key, HMAC_SHA256));
            return mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is required by every JVM", e);
        }
    }

    private static byte[] idBytes(UUID id) {
        return ByteBuffer.allocate(ID_BYTES)
                .putLong(id.getMostSignificantBits())
                .putLong(id.getLeastSignificantBits())
                .array();
    }
}
