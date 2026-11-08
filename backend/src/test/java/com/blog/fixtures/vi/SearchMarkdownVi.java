package com.blog.fixtures.vi;

/** Vietnamese fixtures for the Markdown text extraction test (diacritics must survive stripping). */
public final class SearchMarkdownVi {

    /** A Markdown heading, bold and inline code around Vietnamese words: "# Call `json.loads` in **Python**". */
    public static final String CALL_JSON_LOADS = "# Gọi `json.loads` trong **Python**";

    /** The expected plain text of {@link #CALL_JSON_LOADS}, diacritics intact. */
    public static final String CALL_JSON_LOADS_PLAIN = "Gọi json.loads trong Python";

    private SearchMarkdownVi() {}
}
