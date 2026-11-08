package com.blog.comment.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.text.UserText;
import org.springframework.http.HttpStatus;

/**
 * Valid comment content: sanitized with {@link UserText#clean}, then requires 2-2000 code points and at least one
 * code point that is not whitespace and not of type {@link Character#FORMAT}. "Whitespace" here means
 * {@link Character#isWhitespace} or {@link Character#isSpaceChar}: the latter adds three non-breaking spaces
 * (U+00A0, U+2007, U+202F) that {@code isWhitespace} ignores, so a comment made only of non-breaking spaces is
 * also empty.
 *
 * The second rule rejects a comment made only of ZWJ or ZWNJ, two characters UserText deliberately keeps
 * (composed emoji need them) but which render nothing on their own. Length is counted in code points like the
 * {@code char_length} CHECK on the comments table (V19): an emoji outside the BMP is one character, not two Java
 * chars. Non-breaking spaces are still stored and still count toward the length like any other character
 * ({@code strip()} in UserText does not trim them); this rule only refuses to treat them as "visible".
 *
 * The client-side copy is {@code frontend/lib/comment-content.ts}, which applies exactly these two rules for the
 * "N/2000" counter and the submit button; change one side and you must change the other.
 */
public final class CommentContent {

    public static final int MIN_LENGTH = 2;
    public static final int MAX_LENGTH = 2000;

    private CommentContent() {}

    /**
     * The content that will be stored: exactly the sanitized string, nothing else (HTML is kept verbatim, because
     * it is only ever displayed as text).
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when, after sanitizing, fewer than 2 or more than 2000
     *                      characters remain, or none is visible; the message is fixed and does not echo the content
     */
    public static String normalize(String raw) {
        String cleaned = UserText.clean(raw);
        int length = cleaned.codePointCount(0, cleaned.length());
        if (length < MIN_LENGTH || length > MAX_LENGTH || !hasVisibleCharacter(cleaned)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "Comment must be " + MIN_LENGTH + "–" + MAX_LENGTH + " characters");
        }
        return cleaned;
    }

    private static boolean hasVisibleCharacter(String text) {
        return text.codePoints()
                .anyMatch(cp -> !Character.isWhitespace(cp)
                        && !Character.isSpaceChar(cp)
                        && Character.getType(cp) != Character.FORMAT);
    }
}
