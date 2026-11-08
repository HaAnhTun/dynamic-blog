package com.blog.auth.mfa;

import java.security.MessageDigest;
import java.time.Duration;
import java.util.Base64;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * Two-step verification, bound from {@code app.mfa.*}.
 *
 * The four strings that can be secrets ({@code encryptionKey}, {@code enrollmentToken}, {@code resetEmail},
 * {@code resetToken}) are kept as strings and only checked by the methods below, like {@code SetupProperties}: if a bad
 * value broke the binding of the whole record, Boot's startup failure message would print the values of the properties
 * being bound. {@link #toString()} hides all four.
 *
 * @param encryptionKey   {@code MFA_ENCRYPTION_KEY}: base64 of exactly 32 bytes, the AES-256-GCM key that protects the
 *                        TOTP secrets at rest ({@link MfaSecretCipher}). Required in every mode
 * @param issuer          the name an authenticator app shows next to the account ({@code app.mfa.issuer})
 * @param challengeTtl    how long the challenge of the second sign-in step lives (at most {@value #MAX_CHALLENGE_MINUTES}
 *                        minutes)
 * @param reauthWindow    how recently a person must have signed in to change MFA or the password (at most
 *                        {@value #MAX_REAUTH_MINUTES} minutes)
 * @param enrollmentToken {@code MFA_ENROLLMENT_TOKEN}: the operator's proof for the forced enrollment of an existing
 *                        install; empty means "generate a code file" ({@code MfaEnrollmentCodeStore})
 * @param resetEmail      {@code MFA_RESET_EMAIL}: the admin whose second step the operator resets at startup
 * @param resetToken      {@code MFA_RESET_TOKEN}: makes one reset apply once per distinct value
 */
@ConfigurationProperties("app.mfa")
public record MfaProperties(
        String encryptionKey,
        @DefaultValue(DEFAULT_ISSUER) String issuer,
        @DefaultValue("5m") Duration challengeTtl,
        @DefaultValue("10m") Duration reauthWindow,
        String enrollmentToken,
        String resetEmail,
        String resetToken) {

    /** The throw-away key of {@code application-dev.yml} and the test configuration: recognised, never derived from. */
    public static final String DEV_ENCRYPTION_KEY = "kKTD05O9CzY77GBpadFxIY3buL3OixPWeQpATErrgxM=";

    public static final String DEFAULT_ISSUER = "Blog";
    public static final int KEY_BYTES = 32;
    public static final int MIN_TOKEN_LENGTH = 24;
    static final int MAX_CHALLENGE_MINUTES = 15;
    static final int MAX_REAUTH_MINUTES = 60;
    private static final int MAX_ISSUER_LENGTH = 60;

    private static final String MISSING_KEY_MESSAGE = "MFA_ENCRYPTION_KEY is not set. Every install needs it: it "
            + "encrypts the two-step verification secrets. Generate one with: openssl rand -base64 32 and keep a copy "
            + "outside the server (a database backup does not contain it).";

    public MfaProperties {
        requireBetween("challenge-ttl", challengeTtl, Duration.ofMinutes(MAX_CHALLENGE_MINUTES));
        requireBetween("reauth-window", reauthWindow, Duration.ofMinutes(MAX_REAUTH_MINUTES));
        if (issuer == null || issuer.isBlank()) {
            issuer = DEFAULT_ISSUER;
        }
        issuer = issuer.strip();
        if (issuer.length() > MAX_ISSUER_LENGTH || issuer.codePoints().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException(
                    "app.mfa.issuer is invalid: at most " + MAX_ISSUER_LENGTH + " characters, no control characters");
        }
    }

    /** Hides every value that is, or may identify, a secret. */
    @Override
    public String toString() {
        return "MfaProperties[encryptionKey=<hidden>, issuer=" + issuer + ", challengeTtl=" + challengeTtl
                + ", reauthWindow=" + reauthWindow + ", enrollmentToken=<hidden>, resetEmail=<hidden>,"
                + " resetToken=<hidden>]";
    }

    /**
     * @return the 32 key bytes
     * @throws IllegalStateException when the key is missing (in every mode), is not base64 or does not decode to exactly
     *                               32 bytes. The message names the variable and, for a wrong size, the decoded length,
     *                               never a value.
     */
    public byte[] requireKeyBytes() {
        return requireKeyBytes(encryptionKey);
    }

    /** The same rule for a value that is not (yet) in a record: static so a test needs no context. */
    public static byte[] requireKeyBytes(String configured) {
        if (configured == null || configured.isBlank()) {
            throw new IllegalStateException(MISSING_KEY_MESSAGE);
        }
        byte[] key;
        try {
            key = Base64.getDecoder().decode(configured.strip());
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException(
                    "MFA_ENCRYPTION_KEY is not valid base64. Generate one with: openssl rand -base64 32");
        }
        if (key.length != KEY_BYTES) {
            throw new IllegalStateException("MFA_ENCRYPTION_KEY decodes to " + key.length + " bytes; AES-256 needs "
                    + KEY_BYTES + ". Generate one with: openssl rand -base64 32");
        }
        return key;
    }

    /**
     * Whether a configured key is the development key committed to this repository, in any spelling the decoder reads as
     * the same 32 bytes. The key is used as decoded bytes and the JDK decoder accepts a missing padding and ignores the
     * unused low bits of the last character, so comparing the text would let another spelling of the public key pass.
     */
    public static boolean isDevelopmentKey(String configured) {
        return sameBytes(decodedOrNull(configured), decodedOrNull(DEV_ENCRYPTION_KEY));
    }

    /** The bytes {@code text} decodes to as base64, or null when it is missing or not base64. */
    static byte[] decodedOrNull(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return Base64.getDecoder().decode(text.strip());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Constant-time equality of two byte arrays; false when either is missing. */
    static boolean sameBytes(byte[] a, byte[] b) {
        return a != null && b != null && MessageDigest.isEqual(a, b);
    }

    /** @return the stripped {@code MFA_ENROLLMENT_TOKEN}; null when blank */
    public String configuredEnrollmentToken() {
        return requireTokenShape("MFA_ENROLLMENT_TOKEN (app.mfa.enrollment-token)", enrollmentToken);
    }

    /** @return the stripped {@code MFA_RESET_TOKEN}; null when blank */
    public String configuredResetToken() {
        return requireTokenShape("MFA_RESET_TOKEN (app.mfa.reset-token)", resetToken);
    }

    /** @return the stripped {@code MFA_RESET_EMAIL}; null when blank */
    public String configuredResetEmail() {
        return resetEmail == null || resetEmail.isBlank() ? null : resetEmail.strip();
    }

    private static String requireTokenShape(String name, String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String stripped = value.strip();
        if (stripped.length() < MIN_TOKEN_LENGTH) {
            throw new IllegalStateException(name + " must be at least " + MIN_TOKEN_LENGTH
                    + " characters long. Leave it empty to turn the feature it controls off.");
        }
        return stripped;
    }

    private static void requireBetween(String name, Duration value, Duration max) {
        if (value == null || value.isNegative() || value.isZero() || value.compareTo(max) > 0) {
            throw new IllegalArgumentException("app.mfa." + name + " is invalid: " + value + " (must be longer than"
                    + " zero and at most " + max + ")");
        }
    }
}
