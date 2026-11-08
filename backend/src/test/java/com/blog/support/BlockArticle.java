package com.blog.support;

import java.util.List;

/**
 * An article body that uses the blocks which cut or keep text by lines (a callout, steps with steps, code tabs with fence titles, a
 * diagram with raw source, a gallery, a figure, a details block and a table), written once with LF and once with CRLF. A post saved
 * from the editor has CRLF, so each reader of the body is tested with both.
 */
public final class BlockArticle {

    private static final List<String> LINES = List.of(
            "## Intro",
            "",
            ":::callout{type=warning title=\"Careful\"}",
            "Do **not** run this twice.",
            ":::",
            "",
            "::::steps{variant=grouped}",
            ":::step{title=\"One\"}",
            "First.",
            ":::",
            ":::step{title=\"Two\"}",
            "Second.",
            ":::",
            "::::",
            "",
            ":::code-tabs{title=\"Hello\"}",
            "```python title=\"hello.py\"",
            "print(1)",
            "```",
            "```bash title=\"Shell\"",
            "echo 1",
            "```",
            ":::",
            "",
            ":::diagram{type=mermaid title=\"Request flow\" alt=\"Client calls the server\"}",
            "graph TD",
            "  A[Client] --> B[Server]",
            "",
            "  B --> C[(Store)]",
            ":::",
            "",
            ":::gallery{columns=2}",
            "![First](assets/a.png)",
            "![Second](assets/b.png)",
            ":::",
            "",
            "::figure{src=\"assets/c.png\" alt=\"A chart\"}",
            "",
            ":::details{title=\"More\" open}",
            "Hidden text.",
            ":::",
            "",
            ":::comparison{title=\"Options\"}",
            "| a | b |",
            "| - | - |",
            "| 1 | 2 |",
            ":::",
            "",
            "## Outro",
            "",
            "The end.");

    /** The article with LF line endings. */
    public static final String LF = String.join("\n", LINES);

    /** The same article with CRLF line endings. */
    public static final String CRLF = String.join("\r\n", LINES);

    private BlockArticle() {}
}
