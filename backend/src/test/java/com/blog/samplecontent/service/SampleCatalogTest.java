package com.blog.samplecontent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.i18n.LocalizedText;
import com.blog.samplecontent.service.SampleCatalog.SampleItem;
import com.blog.samplecontent.service.SampleCatalog.SamplePost;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

/** The packaged sample files and their parser: what the catalog promises, and the errors a broken file gives. */
class SampleCatalogTest {

    private static final String WELCOME = "welcome";
    private static final String MARKDOWN = "markdown";

    private final SampleCatalog catalog = SampleCatalog.load();

    @Test
    void four_posts_two_articles_each_in_both_languages_with_unique_slugs() {
        List<SamplePost> posts = catalog.posts();

        assertThat(posts).hasSize(4);
        assertThat(posts.stream().map(SamplePost::slug).collect(java.util.stream.Collectors.toSet()))
                .hasSize(4);
        for (String group : List.of(WELCOME, MARKDOWN)) {
            assertThat(posts.stream().filter(p -> p.group().equals(group)).map(SamplePost::language))
                    .containsExactlyInAnyOrder("en", "vi");
        }
        for (SamplePost post : posts) {
            assertThat(post.title()).isNotBlank().hasSizeLessThanOrEqualTo(255);
            assertThat(post.excerpt()).isNotBlank();
            assertThat(post.slug()).matches("[a-z0-9]+(-[a-z0-9]+)*");
        }
    }

    @Test
    void one_category_one_series_and_two_tags_each_named_in_both_languages() {
        assertThat(catalog.categories()).extracting(SampleItem::key).containsExactly("Guides");
        assertThat(catalog.series()).extracting(SampleItem::key).containsExactly("Getting started");
        assertThat(catalog.tags()).extracting(SampleItem::key).containsExactlyInAnyOrder("welcome", "markdown");
        for (SampleItem item : allItems()) {
            assertThat(item.translations()).containsOnlyKeys("en", "vi");
            item.translations().values().forEach(text -> assertThat(text.name()).isNotBlank());
        }
        // The series description is translated too, the others have none.
        Map<String, LocalizedText> series = catalog.series().get(0).translations();
        assertThat(series.get("en").description()).isNotBlank();
        assertThat(series.get("vi").description()).isNotBlank();
        // The English name is the key, and the other language really differs from it.
        for (SampleItem item : allItems()) {
            assertThat(item.translations().get("en").name()).isEqualTo(item.key());
        }
        assertThat(catalog.categories().get(0).translations().get("vi").name()).isNotEqualTo("Guides");
        assertThat(catalog.series().get(0).translations().get("vi").name()).isNotEqualTo("Getting started");
    }

    @Test
    void every_post_of_a_group_shares_the_item_keys_of_the_english_file() {
        for (SamplePost post : catalog.posts()) {
            assertThat(post.categoryKey()).isEqualTo("Guides");
            assertThat(post.seriesKey()).isEqualTo("Getting started");
            assertThat(post.tagKeys()).hasSize(1);
            assertThat(post.tagKeys().get(0)).isEqualTo(post.group());
        }
    }

    @Test
    void the_bodies_use_the_markdown_the_site_renders() {
        for (SamplePost post : catalog.posts()) {
            assertThat(post.content()).contains("\n## ");
            assertThat(post.content()).contains("\n- ");
            assertThat(post.content()).contains("\n> ");
            assertThat(post.content()).doesNotContain("![");
        }
        SamplePost markdown = catalog.posts().stream()
                .filter(p -> p.group().equals(MARKDOWN) && p.language().equals("en"))
                .findFirst()
                .orElseThrow();
        assertThat(markdown.content()).contains("|---|").contains("```java").contains("](https://");
        SamplePost welcome = catalog.posts().stream()
                .filter(p -> p.group().equals(WELCOME) && p.language().equals("en"))
                .findFirst()
                .orElseThrow();
        assertThat(welcome.content()).contains("|---|");
    }

    @Test
    void the_english_files_contain_no_accented_letters() {
        for (SamplePost post : catalog.posts()) {
            if (!post.language().equals("en")) {
                continue;
            }
            String all = post.title() + post.excerpt() + post.content();
            String decomposed = Normalizer.normalize(all, Normalizer.Form.NFD);
            assertThat(decomposed.chars().noneMatch(c -> Character.getType(c) == Character.NON_SPACING_MARK))
                    .as(post.slug())
                    .isTrue();
            assertThat(all.chars().noneMatch(c -> c == 0x0111 || c == 0x0110)).isTrue();
        }
    }

    @Test
    void no_sample_text_names_a_person_an_email_or_an_image() {
        for (SamplePost post : catalog.posts()) {
            String all = post.title() + post.excerpt() + post.content();
            assertThat(all).doesNotContain("@").doesNotContain("![").doesNotContain("<img");
        }
    }

    // --- Parser errors ---------------------------------------------------------------------------------

    @Test
    void an_unknown_header_key_is_rejected() {
        Map<String, String> files = files();
        files.put("en/welcome", files.get("en/welcome").replace("slug: welcome", "color: red\nslug: welcome"));

        assertThatThrownBy(() -> SampleCatalog.parse(files))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("unknown header key color");
    }

    @Test
    void a_missing_required_header_is_rejected() {
        Map<String, String> files = files();
        files.put("vi/markdown", files.get("vi/markdown").replaceFirst("(?m)^excerpt:.*\\R", ""));

        assertThatThrownBy(() -> SampleCatalog.parse(files))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("missing header excerpt");
    }

    @Test
    void a_group_header_that_does_not_match_the_file_is_rejected() {
        Map<String, String> files = files();
        files.put("en/markdown", files.get("en/markdown").replace("group: markdown", "group: welcome"));

        assertThatThrownBy(() -> SampleCatalog.parse(files))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("the group header does not match");
    }

    @Test
    void languages_that_list_a_different_number_of_tags_are_rejected() {
        Map<String, String> files = files();
        files.put("en/welcome", files.get("en/welcome").replace("tags: welcome", "tags: welcome, extra"));

        assertThatThrownBy(() -> SampleCatalog.parse(files))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("the same tags");
    }

    @Test
    void a_file_without_a_body_or_a_missing_file_is_rejected() {
        Map<String, String> files = files();
        String header = files.get("en/welcome").split("\n\n", 2)[0];
        files.put("en/welcome", header + "\n\n   \n");
        assertThatThrownBy(() -> SampleCatalog.parse(files))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("the body is empty");

        Map<String, String> missing = files();
        missing.remove("vi/welcome");
        assertThatThrownBy(() -> SampleCatalog.parse(missing))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Missing sample file vi/welcome");
    }

    @Test
    void windows_line_endings_parse_like_unix_ones() {
        Map<String, String> files = files();
        files.replaceAll((name, text) -> text.replace("\n", "\r\n"));

        SampleCatalog crlf = SampleCatalog.parse(files);

        assertThat(crlf.posts()).isEqualTo(catalog.posts());
        assertThat(crlf.posts().get(0).content()).doesNotContain("\r");
    }

    private List<SampleItem> allItems() {
        Set<SampleItem> all = new HashSet<>(catalog.categories());
        all.addAll(catalog.tags());
        all.addAll(catalog.series());
        return List.copyOf(all);
    }

    private static Map<String, String> files() {
        Map<String, String> files = new LinkedHashMap<>();
        for (String language : SampleCatalog.LANGUAGES) {
            SampleCatalog.FILES.forEach((group, file) -> files.put(language + "/" + group, read(language, file)));
        }
        return files;
    }

    private static String read(String language, String file) {
        try (InputStream in = new ClassPathResource(SampleCatalog.ROOT + language + "/" + file).getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
