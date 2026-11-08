package com.blog.common.util;

import jakarta.servlet.http.HttpServletRequest;

/**
 * What of a request a log line may repeat (issue 089). The path of a request is chosen by the caller and can be as long as the
 * header limit of the container (about 8 KB), so a line that quotes it whole lets one anonymous request write kilobytes. A line
 * carries a bounded prefix of the raw path instead, never the query (a search term, a token passed as a parameter), and no control
 * character, so the text cannot start a line of its own.
 */
public final class LogText {

    public static final int PATH_MAX = 120;
    public static final int METHOD_MAX = 16;

    private static final String CUT = "...";

    private LogText() {}

    /** The request path as the caller wrote it (not decoded), without the query, cut at {@link #PATH_MAX} characters. */
    public static String path(HttpServletRequest request) {
        return cap(request.getRequestURI(), PATH_MAX);
    }

    /** The HTTP method, cut at {@link #METHOD_MAX} characters: the method token is the caller's too. */
    public static String method(HttpServletRequest request) {
        return cap(request.getMethod(), METHOD_MAX);
    }

    private static String cap(String text, int max) {
        if (text == null) {
            return "-";
        }
        boolean cut = text.length() > max;
        String head = cut ? text.substring(0, max) : text;
        StringBuilder safe = new StringBuilder(head.length() + CUT.length());
        for (int i = 0; i < head.length(); i++) {
            char c = head.charAt(i);
            safe.append(c < 0x20 || c == 0x7f ? '?' : c);
        }
        return cut ? safe.append(CUT).toString() : safe.toString();
    }
}
