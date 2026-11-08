package com.blog.sitecontent.schema;

/** The plain-text rules shared by the text constraints. Messages never contain the value. */
final class TextRules {

    private TextRules() {}

    /** The reason a text is not acceptable, or null when it is. Null input is the caller's business. */
    static String problem(String value, int min, int max) {
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) {
                return "must not contain control characters";
            }
        }
        if (!value.isEmpty()
                && (Character.isWhitespace(value.charAt(0))
                        || Character.isSpaceChar(value.charAt(0))
                        || Character.isWhitespace(value.charAt(value.length() - 1))
                        || Character.isSpaceChar(value.charAt(value.length() - 1)))) {
            return "must not start or end with whitespace";
        }
        int length = value.codePointCount(0, value.length());
        if (length > max) {
            return "must be at most " + max + " characters long";
        }
        if (length < min) {
            return min == 1 ? "must not be empty" : "must be at least " + min + " characters long";
        }
        return null;
    }

    /** The reason a Markdown document is not acceptable, or null: only line breaks and tabs are allowed as control characters. */
    static String documentProblem(String value, int max) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isISOControl(c) && c != '\n' && c != '\r' && c != '\t') {
                return "must not contain control characters";
            }
        }
        if (value.codePointCount(0, value.length()) > max) {
            return "must be at most " + max + " characters long";
        }
        return null;
    }
}
