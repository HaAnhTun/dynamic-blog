package com.blog.post.mapper;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.category.entity.Category;
import com.blog.common.i18n.LocalizedText;
import com.blog.common.security.SeedAdmin;
import com.blog.common.text.BlockMarkers;
import com.blog.media.dto.MediaResponse;
import com.blog.media.entity.Media;
import com.blog.post.dto.PostAuthorResponse;
import com.blog.post.dto.PostResponse;
import com.blog.post.dto.PostSummaryResponse;
import com.blog.post.dto.PostTranslationResponse;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostStatus;
import com.blog.series.dto.SeriesRefResponse;
import com.blog.series.entity.Series;
import com.blog.support.BlockArticle;
import com.blog.tag.entity.Tag;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import java.lang.reflect.RecordComponent;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class PostMapperTest {

    // --- Reading time --------------------------------------------------------------------------

    @Test
    void reading_time_counts_words_separated_only_by_newlines() {
        // Markdown written one idea per line: 400 words separated only by newlines are 400 words, 2 minutes at 200
        // words/minute.
        // The old regex "\s+" in a Java literal is a single space, so a post like that was counted as one word.
        assertThat(readingMinutes("word\n".repeat(400))).isEqualTo(2);
    }

    @Test
    void reading_time_treats_any_whitespace_as_word_boundary() {
        // Tabs, CRLF and several consecutive spaces are each a single boundary; leading/trailing whitespace does not
        // become an empty word.
        String mixed = "  \n" + "one\ttwo\r\nthree  four\n\n".repeat(101) + "  ";

        assertThat(readingMinutes(mixed)).isEqualTo(3); // 404 words → ceil(404 / 200)
    }

    @Test
    void reading_time_ignores_block_markers_and_diagram_sources() {
        // 200 words of prose are one minute; markers, attributes and a long diagram source must not push it to two.
        String prose = "word ".repeat(200);
        String blocks = ":::callout{type=\"warning\" title=\"A long title with many words\"}\n"
                + prose
                + "\n:::\n:::diagram{type=mermaid}\n"
                + "node ".repeat(500)
                + "\n:::\n";
        assertThat(readingMinutes(blocks)).isEqualTo(1);
        assertThat(readingMinutes(":::diagram{type=mermaid}\nsource\n:::\n")).isEqualTo(1);
        // Without any marker every word still counts.
        assertThat(readingMinutes("word ".repeat(201))).isEqualTo(2);
    }

    @Test
    void reading_time_keeps_old_behavior_for_space_separated_words() {
        // Control for the two tests above: input with only spaces (the way the old test in PostSearchAndFeaturedIT
        // wrote it)
        // still yields the same old number, and a very short or empty post is never 0 minutes.
        assertThat(readingMinutes("word ".repeat(1200))).isEqualTo(6);
        assertThat(readingMinutes("one two three")).isEqualTo(1);
        assertThat(readingMinutes("   \n\t ")).isEqualTo(1);
    }

    @Test
    void reading_time_of_a_crlf_document_counts_what_the_lf_document_counts() {
        // The prose of the article is topped up to exactly 200 words: one minute. A marker line, an attribute, the
        // source of the
        // diagram or a carriage return counted as a word would push either version to two.
        String article = BlockArticle.LF;
        int prose = BlockMarkers.withoutMarkers(article).strip().split("\\s+").length;
        String filler = "word ".repeat(200 - prose);

        assertThat(prose).isLessThan(200);
        assertThat(readingMinutes(article + "\n\n" + filler)).isEqualTo(1);
        assertThat(readingMinutes(BlockArticle.CRLF + "\r\n\r\n" + filler.replace(" ", "\r\n")))
                .isEqualTo(1);
        // One more word in either version is the second minute, so the check above is not satisfied by a count that is
        // too small.
        assertThat(readingMinutes(BlockArticle.CRLF + "\r\n\r\n" + filler.replace(" ", "\r\n") + "word"))
                .isEqualTo(2);
    }

    // --- Cover image, series, rank, views ------------------------------------------------------

    @Test
    void post_without_cover_series_rank_has_null_fields_and_views_from_parameter() {
        Post post = post(PostStatus.PUBLISHED);

        PostSummaryResponse summary = PostMapper.toSummary(post, 0, PartInfo.NONE, List.of());
        PostResponse response = PostMapper.toResponse(post, 0, PartInfo.NONE, List.of());

        assertThat(summary.cover()).isNull();
        assertThat(summary.series()).isNull();
        assertThat(summary.featuredRank()).isNull();
        assertThat(summary.viewCount()).isZero();
        assertThat(response.cover()).isNull();
        assertThat(response.series()).isNull();
        assertThat(response.featuredRank()).isNull();
        assertThat(response.viewCount()).isZero();
    }

    @Test
    void post_with_cover_series_rank_carries_them_in_both_dtos() {
        Post post = post(PostStatus.PUBLISHED);
        Media cover = media();
        Series series = series();
        setReadOnly(post, "cover", cover);
        setReadOnly(post, "series", series);
        setReadOnly(post, "seriesPosition", 3);
        setReadOnly(post, "featuredRank", 2);
        // Stored position 3 but part 2/2: the part at position 2 is not published. The part number comes from the
        // parameter, and so does the position a reader sees: the stored 3 would tell how many parts are not published.
        PartInfo part = new PartInfo(2, 2);

        PostSummaryResponse summary = PostMapper.toSummary(post, 41, part, List.of());
        PostResponse response = PostMapper.toResponse(post, 41, part, List.of());

        MediaResponse expectedCover =
                new MediaResponse(cover.getId(), cover.getId() + ".png", 40, 30, "Image description", "#336699");
        SeriesRefResponse expectedSeries = new SeriesRefResponse(series.getId(), "series-a", "Series A", 2, 2, 2);
        assertThat(summary.cover()).isEqualTo(expectedCover);
        assertThat(summary.series()).isEqualTo(expectedSeries);
        assertThat(summary.featuredRank()).isEqualTo(2);
        assertThat(summary.viewCount()).isEqualTo(41);
        assertThat(response.cover()).isEqualTo(expectedCover);
        assertThat(response.series()).isEqualTo(expectedSeries);
        assertThat(response.featuredRank()).isEqualTo(2);
        assertThat(response.viewCount()).isEqualTo(41);
    }

    @Test
    void post_in_series_when_unpublished_has_series_but_no_part_number() {
        Post draft = post(PostStatus.DRAFT);
        Series series = series();
        setReadOnly(draft, "series", series);
        setReadOnly(draft, "seriesPosition", 2);

        SeriesRefResponse ref =
                PostMapper.toSummary(draft, 0, PartInfo.NONE, List.of()).series();

        assertThat(ref).isEqualTo(new SeriesRefResponse(series.getId(), "series-a", "Series A", 2, null, null));
    }

    @Test
    void summary_carries_post_updatedAt_like_the_full_version() {
        Post post = post(PostStatus.PUBLISHED);
        Instant updatedAt = Instant.parse("2026-10-06T08:15:30.123456Z");
        post.setUpdatedAt(updatedAt);

        assertThat(PostMapper.toSummary(post, 0, PartInfo.NONE, List.of()).updatedAt())
                .isEqualTo(updatedAt);
        assertThat(PostMapper.toResponse(post, 0, PartInfo.NONE, List.of()).updatedAt())
                .isEqualTo(updatedAt);
    }

    @Test
    void new_fields_are_at_end_of_record_with_json_key_names_frontend_reads() {
        // Added at the end, the old order is kept; component names are the JSON keys declared by the frontend's
        // lib/types.ts.
        // The summary's updatedAt was added for the sitemap lastmod and the admin "recently edited" column.
        // author was added with the author feature; PostAuthorResponse has no id, email or role.
        assertThat(components(PostSummaryResponse.class))
                .containsExactly(
                        "id",
                        "title",
                        "slug",
                        "excerpt",
                        "status",
                        "category",
                        "tags",
                        "featured",
                        "readingMinutes",
                        "publishedAt",
                        "cover",
                        "series",
                        "featuredRank",
                        "viewCount",
                        "updatedAt",
                        "author",
                        "language",
                        "translations");
        assertThat(components(PostResponse.class))
                .containsExactly(
                        "id",
                        "title",
                        "slug",
                        "excerpt",
                        "content",
                        "status",
                        "category",
                        "tags",
                        "featured",
                        "readingMinutes",
                        "publishedAt",
                        "createdAt",
                        "updatedAt",
                        "cover",
                        "series",
                        "featuredRank",
                        "viewCount",
                        "author",
                        "language",
                        "translations");
        assertThat(components(SeriesRefResponse.class))
                .containsExactly("id", "slug", "title", "position", "partNumber", "partCount");
        assertThat(components(PostAuthorResponse.class))
                .containsExactly("displayName", "githubLogin", "avatarUrl", "siteOwner", "profileSlug");
    }

    // --- Language -------------------------------------------------------------------------------

    @Test
    void taxonomy_names_follow_the_language_of_the_post_with_fallback_to_the_base_name() {
        Post post = post(PostStatus.PUBLISHED);
        post.setLanguage("en");
        Category category = new Category();
        category.setId(UUID.randomUUID());
        category.setName("Co so du lieu");
        category.setSlug("co-so-du-lieu");
        category.setDescription("Mo ta goc");
        category.setTranslations(Map.of("en", new LocalizedText("Databases", " ")));
        post.setCategory(category);
        Tag translated = tag("Mang", "mang", Map.of("en", new LocalizedText("Networks", null)));
        Tag plain = tag("Bao mat", "bao-mat", Map.of());
        post.setTags(new java.util.HashSet<>(List.of(translated, plain)));

        PostSummaryResponse english = PostMapper.toSummary(post, 0, PartInfo.NONE, List.of());
        assertThat(english.category().name()).isEqualTo("Databases");
        // A blank translated description is "not translated": the base text stays.
        assertThat(english.category().description()).isEqualTo("Mo ta goc");
        assertThat(english.tags()).extracting(t -> t.name()).containsExactly("Bao mat", "Networks");
        assertThat(english.category().translations()).isNull();

        post.setLanguage("vi");
        PostSummaryResponse vietnamese = PostMapper.toSummary(post, 0, PartInfo.NONE, List.of());
        assertThat(vietnamese.category().name()).isEqualTo("Co so du lieu");
        assertThat(vietnamese.tags()).extracting(t -> t.name()).containsExactly("Bao mat", "Mang");
    }

    @Test
    void language_and_translations_are_passed_through_unchanged() {
        Post post = post(PostStatus.PUBLISHED);
        post.setLanguage("en");
        List<PostTranslationResponse> siblings =
                List.of(new PostTranslationResponse("vi", "bai-goc", "Bai goc", "PUBLISHED"));

        assertThat(PostMapper.toSummary(post, 0, PartInfo.NONE, siblings).language())
                .isEqualTo("en");
        assertThat(PostMapper.toSummary(post, 0, PartInfo.NONE, siblings).translations())
                .isEqualTo(siblings);
        assertThat(PostMapper.toResponse(post, 0, PartInfo.NONE, siblings).translations())
                .isEqualTo(siblings);
    }

    private static Tag tag(String name, String slug, Map<String, LocalizedText> translations) {
        Tag tag = new Tag();
        tag.setId(UUID.randomUUID());
        tag.setName(name);
        tag.setSlug(slug);
        tag.setTranslations(translations);
        return tag;
    }

    // --- Author --------------------------------------------------------------------------------

    @Test
    void site_owner_is_seed_admin_row_not_every_ADMIN_and_account_without_GitHub_has_null_fields() {
        Post bySeed = post(PostStatus.PUBLISHED);
        bySeed.setAuthor(user(SeedAdmin.ID, UserRole.ADMIN, "Admin", null, null));
        bySeed.getAuthor().setPublicSlug("admin");
        // A second ADMIN with the same name as the site owner: neither name nor role makes anyone the site owner.
        Post byOtherAdmin = post(PostStatus.PUBLISHED);
        byOtherAdmin.setAuthor(user(
                UUID.randomUUID(),
                UserRole.ADMIN,
                "Admin",
                "admin-thu-hai",
                "https://avatars.githubusercontent.com/u/7?v=4"));
        byOtherAdmin.getAuthor().setPublicSlug("admin-thu-hai");

        PostAuthorResponse seed = new PostAuthorResponse("Admin", null, null, true, "admin");
        PostAuthorResponse other = new PostAuthorResponse(
                "Admin", "admin-thu-hai", "https://avatars.githubusercontent.com/u/7?v=4", false, "admin-thu-hai");
        assertThat(PostMapper.toSummary(bySeed, 0, PartInfo.NONE, List.of()).author())
                .isEqualTo(seed);
        assertThat(PostMapper.toResponse(bySeed, 0, PartInfo.NONE, List.of()).author())
                .isEqualTo(seed);
        assertThat(PostMapper.toSummary(byOtherAdmin, 0, PartInfo.NONE, List.of())
                        .author())
                .isEqualTo(other);
        assertThat(PostMapper.toResponse(byOtherAdmin, 0, PartInfo.NONE, List.of())
                        .author())
                .isEqualTo(other);

        // A suspended user has no public profile, so there is no slug to link to.
        Post bySuspended = post(PostStatus.PUBLISHED);
        bySuspended.getAuthor().setPublicSlug("bi-khoa");
        bySuspended.getAuthor().setStatus(UserStatus.SUSPENDED);
        assertThat(PostMapper.toSummary(bySuspended, 0, PartInfo.NONE, List.of())
                        .author()
                        .profileSlug())
                .isNull();
        assertThat(PostMapper.toResponse(bySuspended, 0, PartInfo.NONE, List.of())
                        .author()
                        .profileSlug())
                .isNull();
    }

    // --- Helpers -------------------------------------------------------------------------------

    private static int readingMinutes(String content) {
        Post post = post(PostStatus.DRAFT);
        post.setContent(content);
        return PostMapper.toSummary(post, 0, PartInfo.NONE, List.of()).readingMinutes();
    }

    private static Post post(PostStatus status) {
        Post post = new Post();
        post.setId(UUID.randomUUID());
        post.setTitle("Title");
        post.setSlug("tieu-de");
        post.setContent("Content");
        post.setStatus(status);
        post.setLanguage("vi");
        post.setAuthor(user(UUID.randomUUID(), UserRole.AUTHOR, "Author", null, null));
        return post;
    }

    private static User user(UUID id, UserRole role, String displayName, String githubLogin, String avatarUrl) {
        User user = new User();
        user.setId(id);
        user.setRole(role);
        user.setDisplayName(displayName);
        user.setGithubLogin(githubLogin);
        user.setAvatarUrl(avatarUrl);
        return user;
    }

    /** These four fields have no setter (only dedicated SQL writes them), so the test assigns the fields directly. */
    private static void setReadOnly(Post post, String field, Object value) {
        ReflectionTestUtils.setField(post, field, value);
    }

    private static Media media() {
        Media media = new Media();
        media.setId(UUID.randomUUID());
        media.setContentType("image/png");
        media.setWidth(40);
        media.setHeight(30);
        media.setAltText("Image description");
        media.setDominantColor("#336699");
        return media;
    }

    private static Series series() {
        Series series = new Series();
        series.setId(UUID.randomUUID());
        series.setTitle("Series A");
        series.setSlug("series-a");
        return series;
    }

    private static String[] components(Class<? extends Record> type) {
        return Arrays.stream(type.getRecordComponents())
                .map(RecordComponent::getName)
                .toArray(String[]::new);
    }
}
