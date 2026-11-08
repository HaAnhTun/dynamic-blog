package com.blog.siteimport.format;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assumptions.assumeThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * The section reference in {@code docs/site-profile-format.md} is generated from the registry, so the document cannot
 * drift from the parser. Refresh it with {@code mvn test -Dtest=SiteProfileFormatDocTest -Dsite.format.doc.update=true}.
 */
class SiteProfileFormatDocTest {

    private static final Path DOC = Path.of("..", "docs", "site-profile-format.md");
    private static final String BEGIN = "<!-- BEGIN GENERATED: sections -->\n";
    private static final String END = "<!-- END GENERATED: sections -->";

    @Test
    void the_generated_block_of_the_format_document_matches_the_registry() throws IOException {
        assumeThat(Files.isRegularFile(DOC)).as("docs/site-profile-format.md").isTrue();
        String text = Files.readString(DOC, StandardCharsets.UTF_8).replace("\r\n", "\n");
        int start = text.indexOf(BEGIN);
        int end = text.indexOf(END);
        assertThat(start).as("the BEGIN marker").isNotNegative();
        assertThat(end).as("the END marker").isGreaterThan(start);
        String expected = FormatReference.markdown();

        if (Boolean.getBoolean("site.format.doc.update")) {
            String updated = text.substring(0, start + BEGIN.length()) + expected + text.substring(end);
            Files.writeString(DOC, updated, StandardCharsets.UTF_8);
            return;
        }

        assertThat(text.substring(start + BEGIN.length(), end))
                .as("docs/site-profile-format.md is out of date: run with -Dsite.format.doc.update=true to refresh it")
                .isEqualTo(expected);
    }

    @Test
    void the_reference_has_one_subsection_per_section_with_every_field() {
        String markdown = FormatReference.markdown();

        for (SectionDescriptor section : SectionRegistry.sections()) {
            assertThat(markdown)
                    .contains(
                            "### " + section.heading() + "\n",
                            "`" + section.key().key() + "`");
        }
        assertThat(markdown).contains("`gallery_lead`", "`last_updated`", "`experience_summary`", "`level`");
        assertThat(markdown).endsWith("|\n").doesNotEndWith("\n\n");
    }
}
