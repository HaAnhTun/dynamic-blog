package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.search.service.StaticSearchContent;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/**
 * The static-content file the frontend generates is readable and well-shaped: the frontend drift test keeps it in
 * sync with the TS source, this test keeps it in sync with what the backend reads.
 */
class StaticSearchContentTest {

    @Test
    void committed_file_is_readable_with_pages_case_studies_and_site_owner_and_unique_ids() {
        StaticSearchContent content =
                new StaticSearchContent(JsonMapper.builder().build());

        assertThat(content.owner().name()).isNotBlank();
        assertThat(content.owner().href()).isEqualTo("/about");
        assertThat(content.pages()).isNotEmpty().allSatisfy(page -> {
            assertThat(page.href()).startsWith("/").doesNotStartWith("//");
            assertThat(page.title()).isNotBlank();
        });
        assertThat(content.caseStudies()).isNotEmpty().allSatisfy(study -> {
            assertThat(study.href()).isEqualTo("/case-studies/" + study.slug());
            assertThat(study.title()).isNotBlank();
        });
        List<String> ids = Stream.concat(
                        content.pages().stream().map(page -> "page:" + page.href()),
                        content.caseStudies().stream().map(study -> "case-study:" + study.slug()))
                .toList();
        assertThat(ids).doesNotHaveDuplicates();
    }
}
