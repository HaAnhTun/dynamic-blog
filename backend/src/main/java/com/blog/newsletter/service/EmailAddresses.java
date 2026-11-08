package com.blog.newsletter.service;

import java.text.Normalizer;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Normalizes a newsletter address: trims both ends, NFC, lowercases the whole address; accepts only ASCII, at most 254
 * characters (RFC 5321), at most 64 before the @, and a domain with at least one dot. The {@code +tag} part is kept: two
 * addresses that differ by it are different. A local part with {@code =?} (the start of an RFC 2047 encoded word) is refused.
 * No DNS lookup.
 */
public final class EmailAddresses {

    public static final int MAX_LENGTH = 254;

    private static final String ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
    private static final String LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
    private static final Pattern SHAPE =
            Pattern.compile("(?=[^@]{1,64}@)" + ATOM + "(?:\\." + ATOM + ")*@" + LABEL + "(?:\\." + LABEL + ")+");

    private EmailAddresses() {}

    /** @return the normalized address, or empty when it is not a usable address */
    public static Optional<String> normalize(String raw) {
        if (raw == null) {
            return Optional.empty();
        }
        String stripped = raw.strip();
        // A valid result is ASCII, and NFC never composes any string into an ASCII character: anything longer is
        // certainly wrong.
        if (stripped.isEmpty() || stripped.length() > MAX_LENGTH) {
            return Optional.empty();
        }
        String email = Normalizer.normalize(stripped, Normalizer.Form.NFC).toLowerCase(Locale.ROOT);
        if (email.length() > MAX_LENGTH || !SHAPE.matcher(email).matches()) {
            return Optional.empty();
        }
        // "=?" starts an RFC 2047 encoded word. '=' and '?' are legal in a local part and stay allowed on their own,
        // but
        // that pair would be decoded by a mail client into something other than the address that was checked.
        return email.substring(0, email.indexOf('@')).contains("=?") ? Optional.empty() : Optional.of(email);
    }
}
