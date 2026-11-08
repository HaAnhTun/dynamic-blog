package com.blog.postimport.service;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The opaque state a preview hands to the page and the apply takes back with each file: what the preview decided for the file
 * (a new post, or an update of one post) and, for an update, what that post looked like (its status and the hash of its stored
 * fields). When the file joins a series, the hash also covers which series and which part, for a new post as well. The apply computes it again under its locks and refuses the whole import when it differs. It holds identifiers, a
 * status and a hash, never text from a file or from a post.
 *
 * <p>It travels as URL-safe Base64 of {@code action|postId|status|stateHash}. The page treats it as opaque; a forged one only
 * makes the apply refuse, because the apply compares it with what it computes itself.
 */
public record PreviewState(String action, UUID postId, String status, String stateHash) {

    public static final String ACTION_NEW = "new";
    public static final String ACTION_UPDATE = "update";

    private static final String SEPARATOR = "|";
    private static final int PARTS = 4;
    private static final Pattern STATUS = Pattern.compile("[A-Z_]{1,20}");
    private static final Pattern HASH = Pattern.compile("[0-9a-f]{64}");

    /** A file that creates a new post: there is no target, so no id or status, and no hash unless it joins a series. */
    public static PreviewState forNew() {
        return forNew(null);
    }

    /**
     * A new post that joins a series: {@code seriesHash} says which series (an existing one, or one to create) and which
     * part, so that an apply that would do something else is refused as out of date.
     */
    public static PreviewState forNew(String seriesHash) {
        return new PreviewState(ACTION_NEW, null, null, seriesHash);
    }

    public String encode() {
        String plain = String.join(
                SEPARATOR,
                action,
                postId == null ? "" : postId.toString(),
                status == null ? "" : status,
                stateHash == null ? "" : stateHash);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(plain.getBytes(StandardCharsets.UTF_8));
    }

    /** The state, or empty for anything {@link #encode} could not have written (a malformed or forged value). */
    public static Optional<PreviewState> decode(String encoded) {
        if (encoded == null || encoded.isEmpty()) {
            return Optional.empty();
        }
        try {
            String plain = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8);
            String[] parts = plain.split(Pattern.quote(SEPARATOR), -1);
            if (parts.length != PARTS) {
                return Optional.empty();
            }
            if (ACTION_NEW.equals(parts[0])) {
                boolean bare = parts[1].isEmpty()
                        && parts[2].isEmpty()
                        && (parts[3].isEmpty() || HASH.matcher(parts[3]).matches());
                return bare ? Optional.of(forNew(parts[3].isEmpty() ? null : parts[3])) : Optional.empty();
            }
            if (!ACTION_UPDATE.equals(parts[0])
                    || !STATUS.matcher(parts[2]).matches()
                    || !HASH.matcher(parts[3]).matches()) {
                return Optional.empty();
            }
            return Optional.of(new PreviewState(parts[0], UUID.fromString(parts[1]), parts[2], parts[3]));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }
}
