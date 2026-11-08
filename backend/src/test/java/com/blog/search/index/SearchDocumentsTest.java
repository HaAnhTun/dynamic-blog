package com.blog.search.index;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.security.SeedAdmin;
import com.blog.fixtures.vi.SearchVi;
import com.blog.search.index.SearchDocuments.AuthorRow;
import com.blog.search.index.SearchDocuments.PostRow;
import com.blog.search.index.SearchDocuments.TagRef;
import com.blog.search.index.SearchDocuments.TaxonRow;
import com.blog.search.meili.MeiliSettings;
import com.blog.search.service.StaticSearchContent;
import java.lang.reflect.RecordComponent;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/**
 * Document mapper: ids and Meilisearch's rules for every type, text without private-use characters (a highlight
 * marker cannot be forged), a stable {@code contentHash} that changes with the content, and only public fields.
 */
class SearchDocumentsTest {

    private static final StaticSearchContent.Owner OWNER = new StaticSearchContent.Owner("Site Owner", "/about");
    private static final String PUA = String.valueOf((char) 0xE000) + (char) 0xE001 + (char) 0xF8FF;
    private static final UUID POST = UUID.fromString("0f8fad5b-d9cb-469f-a165-70867728950e");
    private static final UUID AUTHOR = UUID.fromString("7c9e6679-7425-40de-944b-e07fc1f90ae7");

    private static PostRow post(String title, String content, List<TagRef> tags) {
        return new PostRow(
                POST,
                "hoc-spring",
                title,
                "  Excerpt" + PUA + "  ",
                content,
                Instant.parse("2026-10-01T08:00:00Z"),
                "Java" + PUA,
                "java",
                "Series title",
                "loat-bai",
                AUTHOR,
                "Writer " + PUA + "name",
                "nguoi-viet",
                tags,
                "vi");
    }

    @Test
    void every_mapper_gives_valid_id_with_correct_prefix_and_its_own_type_sourceId() {
        UUID id = UUID.randomUUID();
        List<SearchDocument> documents = List.of(
                SearchDocuments.post(post("Title", "Body", List.of()), OWNER),
                SearchDocuments.category(new TaxonRow(id, "Java", "java", "Description", List.of("vi"))),
                SearchDocuments.tag(new TaxonRow(id, "Spring", "spring", null, List.of("en", "vi"))),
                SearchDocuments.series(new TaxonRow(id, "Series", "loat", null, List.of())),
                SearchDocuments.author(new AuthorRow(id, "Writer name", "nguoi-viet", List.of("vi")), OWNER),
                SearchDocuments.caseStudy(new StaticSearchContent.CaseStudy(
                        "blog-mot-vps", "/case-studies/blog-mot-vps", "Blog", "Excerpt", "Body")),
                SearchDocuments.page(
                        new StaticSearchContent.Page("start-here", "/start-here", "Start", "Description")));

        assertThat(documents)
                .extracting(SearchDocument::id)
                .containsExactly(
                        "post-" + POST,
                        "category-" + id,
                        "tag-" + id,
                        "series-" + id,
                        "author-" + id,
                        "casestudy-blog-mot-vps",
                        "page-start-here");
        assertThat(documents)
                .extracting(SearchDocument::type)
                .containsExactly("post", "category", "tag", "series", "author", "case-study", "page");
        assertThat(documents)
                .extracting(SearchDocument::sourceId)
                .containsExactly(
                        POST.toString(),
                        id.toString(),
                        id.toString(),
                        id.toString(),
                        id.toString(),
                        "blog-mot-vps",
                        "start-here");
        assertThat(documents).allSatisfy(document -> {
            assertThat(document.id()).matches("[A-Za-z0-9_-]{1,511}").doesNotContain(":");
            assertThat(document.contentHash()).matches("[0-9a-f]{64}");
        });
        assertThat(documents)
                .extracting(SearchDocument::href)
                .containsExactly(
                        "/posts/hoc-spring",
                        "/categories/java",
                        "/tags/spring",
                        "/series/loat",
                        "/u/nguoi-viet",
                        "/case-studies/blog-mot-vps",
                        "/start-here");
    }

    @Test
    void invalid_id_is_rejected_before_reaching_the_engine() {
        for (String slug : List.of("a/b", "a:b", "a b", SearchVi.STREET, "")) {
            assertThatThrownBy(() -> SearchDocuments.page(new StaticSearchContent.Page(slug, "/x", "T", "D")))
                    .as(slug)
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> SearchDocuments.caseStudy(
                        new StaticSearchContent.CaseStudy("a".repeat(600), "/x", "T", "S", "B")))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void real_static_documents_all_have_valid_ids() {
        StaticSearchContent content =
                new StaticSearchContent(JsonMapper.builder().build());
        content.caseStudies()
                .forEach(study ->
                        assertThat(SearchDocuments.caseStudy(study).id()).matches(SearchDocuments.ID));
        content.pages()
                .forEach(page -> assertThat(SearchDocuments.page(page).id()).matches(SearchDocuments.ID));
        assertThat(content.caseStudies()).isNotEmpty();
    }

    @Test
    void post_carries_public_fields_with_cleaned_text_and_no_private_use_characters() {
        SearchDocument document = SearchDocuments.post(
                post(
                        "Learn " + PUA + "Spring",
                        "# Title\n\nCall `json.loads`" + PUA,
                        List.of(new TagRef("Spring" + PUA, "spring"), new TagRef("Boot", "boot"))),
                OWNER);

        assertThat(document.title()).isEqualTo("Learn Spring");
        assertThat(document.excerpt()).isEqualTo("Excerpt");
        assertThat(document.body()).isEqualTo("Title\n\nCall json.loads");
        assertThat(document.tags()).containsExactly("Boot", "Spring");
        assertThat(document.tagSlugs()).containsExactly("boot", "spring");
        assertThat(document.category()).isEqualTo("Java");
        assertThat(document.categorySlug()).isEqualTo("java");
        assertThat(document.series()).isEqualTo("Series title");
        assertThat(document.author()).isEqualTo("Writer name");
        assertThat(document.authorSlug()).isEqualTo("nguoi-viet");
        assertThat(document.publishedAt())
                .isEqualTo(Instant.parse("2026-10-01T08:00:00Z").toEpochMilli());
        assertThat(document.readingMinutes()).isEqualTo(1);
        String json = JsonMapper.builder().build().writeValueAsString(document);
        for (char c = 0xE000; c <= 0xF8FF; c++) {
            assertThat(json.indexOf(c)).as("U+%04X", (int) c).isEqualTo(-1);
        }
        assertThat(json).doesNotContain("status", "email", "githubLogin", "\"content\"");
    }

    @Test
    void site_owner_carries_site_name_and_maps_to_about() {
        SearchDocument owner =
                SearchDocuments.author(new AuthorRow(SeedAdmin.ID, "admin", "admin", List.of("vi")), OWNER);
        assertThat(owner.title()).isEqualTo("Site Owner");
        assertThat(owner.href()).isEqualTo("/about");
        PostRow row = post("T", "B", List.of());
        PostRow byOwner = new PostRow(
                row.id(),
                row.slug(),
                row.title(),
                row.excerpt(),
                row.content(),
                row.publishedAt(),
                row.categoryName(),
                row.categorySlug(),
                row.seriesTitle(),
                row.seriesSlug(),
                SeedAdmin.ID,
                "admin",
                "admin",
                row.tags(),
                row.language());
        assertThat(SearchDocuments.post(byOwner, OWNER).author()).isEqualTo("Site Owner");
    }

    @Test
    void contentHash_is_stable_and_changes_when_any_field_changes() {
        SearchDocument a = SearchDocuments.post(post("Title", "Body", List.of(new TagRef("A", "a"))), OWNER);
        SearchDocument same = SearchDocuments.post(post("Title", "Body", List.of(new TagRef("A", "a"))), OWNER);
        assertThat(a.contentHash()).isEqualTo(same.contentHash()).isEqualTo(SearchDocuments.contentHash(a));
        assertThat(SearchDocuments.post(post("Title", "Other body", List.of(new TagRef("A", "a"))), OWNER)
                        .contentHash())
                .isNotEqualTo(a.contentHash());
        assertThat(SearchDocuments.post(post("Title", "Body", List.of(new TagRef("A", "b"))), OWNER)
                        .contentHash())
                .isNotEqualTo(a.contentHash());
        // The boundary between two fields cannot slide: "ab"+"c" differs from "a"+"bc".
        TaxonRow left = new TaxonRow(POST, "ab", "x", "c", List.of());
        TaxonRow right = new TaxonRow(POST, "a", "x", "bc", List.of());
        assertThat(SearchDocuments.category(left).contentHash())
                .isNotEqualTo(SearchDocuments.category(right).contentHash());
    }

    @Test
    void language_is_a_string_on_a_post_and_a_sorted_distinct_list_on_taxonomy_and_authors() {
        UUID id = UUID.randomUUID();
        assertThat(SearchDocuments.post(post("T", "B", List.of()), OWNER).language())
                .isEqualTo("vi");
        assertThat(SearchDocuments.category(new TaxonRow(id, "Java", "java", null, List.of("vi", "en", "vi")))
                        .language())
                .isEqualTo(List.of("en", "vi"));
        assertThat(SearchDocuments.tag(new TaxonRow(id, "Spring", "spring", null, List.of("en")))
                        .language())
                .isEqualTo(List.of("en"));
        assertThat(SearchDocuments.series(new TaxonRow(id, "S", "s", null, List.of("vi")))
                        .language())
                .isEqualTo(List.of("vi"));
        assertThat(SearchDocuments.author(new AuthorRow(id, "W", "w", List.of("en", "vi")), OWNER)
                        .language())
                .isEqualTo(List.of("en", "vi"));
    }

    @Test
    void taxonomy_without_published_languages_and_static_content_have_no_language() {
        UUID id = UUID.randomUUID();
        assertThat(SearchDocuments.category(new TaxonRow(id, "Java", "java", null, List.of()))
                        .language())
                .isNull();
        assertThat(SearchDocuments.category(new TaxonRow(id, "Java", "java", null, null))
                        .language())
                .isNull();
        assertThat(SearchDocuments.caseStudy(new StaticSearchContent.CaseStudy("a", "/case-studies/a", "T", "S", "B"))
                        .language())
                .isNull();
        assertThat(SearchDocuments.page(new StaticSearchContent.Page("start-here", "/start-here", "T", "D"))
                        .language())
                .isNull();
    }

    @Test
    void category_document_serializes_exactly_the_languages_it_is_given() {
        UUID id = UUID.randomUUID();
        String json = JsonMapper.builder()
                .build()
                .writeValueAsString(
                        SearchDocuments.category(new TaxonRow(id, "Java", "java", null, List.of("en", "vi"))));
        assertThat(json).contains("\"language\":[\"en\",\"vi\"]");
        String viOnly = JsonMapper.builder()
                .build()
                .writeValueAsString(SearchDocuments.category(new TaxonRow(id, "Java", "java", null, List.of("vi"))));
        assertThat(viOnly).contains("\"language\":[\"vi\"]").doesNotContain("\"en\"");
    }

    @Test
    void language_is_part_of_the_content_hash_and_the_list_order_does_not_matter() {
        UUID id = UUID.randomUUID();
        String vi = SearchDocuments.category(new TaxonRow(id, "Java", "java", null, List.of("vi")))
                .contentHash();
        String both = SearchDocuments.category(new TaxonRow(id, "Java", "java", null, List.of("vi", "en")))
                .contentHash();
        String bothReversed = SearchDocuments.category(new TaxonRow(id, "Java", "java", null, List.of("en", "vi")))
                .contentHash();
        assertThat(vi).isNotEqualTo(both);
        assertThat(both).isEqualTo(bothReversed);
        PostRow row = post("T", "B", List.of());
        PostRow english = new PostRow(
                row.id(),
                row.slug(),
                row.title(),
                row.excerpt(),
                row.content(),
                row.publishedAt(),
                row.categoryName(),
                row.categorySlug(),
                row.seriesTitle(),
                row.seriesSlug(),
                row.authorId(),
                row.authorName(),
                row.authorSlug(),
                row.tags(),
                "en");
        assertThat(SearchDocuments.post(english, OWNER).contentHash())
                .isNotEqualTo(SearchDocuments.post(row, OWNER).contentHash());
    }

    @Test
    void displayedAttributes_are_exactly_the_document_fields() {
        assertThat(MeiliSettings.DISPLAYED)
                .containsExactlyElementsOf(Arrays.stream(SearchDocument.class.getRecordComponents())
                        .map(RecordComponent::getName)
                        .toList());
        assertThat(MeiliSettings.DISPLAYED)
                .containsAll(MeiliSettings.SEARCHABLE)
                .containsAll(MeiliSettings.FILTERABLE)
                .containsAll(MeiliSettings.SORTABLE);
    }
}
