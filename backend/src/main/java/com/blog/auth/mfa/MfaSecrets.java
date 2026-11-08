package com.blog.auth.mfa;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Optional;
import org.bouncycastle.util.encoders.Base32;
import org.bouncycastle.util.encoders.DecoderException;
import org.springframework.web.util.UriUtils;

/**
 * The TOTP secret as a person sees it: 160 random bits as base32 text, in groups of four, and as an {@code otpauth://}
 * link. Base32 comes from the BouncyCastle jar the project already has for Argon2 (no new dependency); this class only
 * adapts it: upper-case RFC 4648 text, padding tolerated on input and never produced for the 20-byte secrets of this
 * feature.
 *
 * Nothing here logs. A caller must not log the text or the link either (docs/CONVENTIONS.md).
 */
public final class MfaSecrets {

    /** 160 bits: the size RFC 4226 recommends and every authenticator app accepts. */
    public static final int SECRET_BYTES = 20;

    private static final int GROUP = 4;

    private MfaSecrets() {}

    public static byte[] generate(SecureRandom random) {
        byte[] secret = new byte[SECRET_BYTES];
        random.nextBytes(secret);
        return secret;
    }

    /** Upper-case RFC 4648 base32. Twenty bytes give 32 characters and no padding. */
    public static String encode(byte[] secret) {
        return Base32.toBase32String(secret);
    }

    /**
     * Reads what a person pastes: spaces, hyphens and {@code =} are dropped and the letters upper-cased first.
     *
     * @return the bytes, or empty when the text holds a character outside the base32 alphabet or has an impossible
     *         length
     */
    public static Optional<byte[]> decode(String text) {
        if (text == null) {
            return Optional.empty();
        }
        String clean = text.replaceAll("[\\s\\-=]", "").toUpperCase(Locale.ROOT);
        // 1, 3 and 6 leftover characters cannot come from whole bytes.
        int leftover = clean.length() % 8;
        if (clean.isEmpty() || leftover == 1 || leftover == 3 || leftover == 6) {
            return Optional.empty();
        }
        // The BouncyCastle decoder insists on padding to a multiple of eight characters.
        String padded = clean + "=".repeat((8 - clean.length() % 8) % 8);
        try {
            return Optional.of(Base32.decode(padded));
        } catch (DecoderException | IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    /** {@code ABCD EFGH ...}: groups of four separated by a space, for reading aloud and typing. */
    public static String group(String base32) {
        StringBuilder grouped = new StringBuilder(base32.length() + base32.length() / GROUP);
        for (int i = 0; i < base32.length(); i += GROUP) {
            if (i > 0) {
                grouped.append(' ');
            }
            grouped.append(base32, i, Math.min(i + GROUP, base32.length()));
        }
        return grouped.toString();
    }

    /**
     * {@code otpauth://totp/<issuer>:<account>?secret=<base32>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30}, with
     * issuer and account percent-encoded. The algorithm parameters are fixed to what every app supports.
     */
    public static String otpauthUri(String issuer, String account, byte[] secret) {
        String encodedIssuer = UriUtils.encode(issuer, StandardCharsets.UTF_8);
        String encodedAccount = UriUtils.encode(account, StandardCharsets.UTF_8);
        return "otpauth://totp/" + encodedIssuer + ":" + encodedAccount + "?secret=" + encode(secret)
                + "&issuer=" + encodedIssuer + "&algorithm=SHA1&digits=" + Totp.DIGITS + "&period="
                + Totp.PERIOD_SECONDS;
    }
}
