package com.blog.post.mapper;

import com.blog.category.dto.CategoryResponse;
import com.blog.category.entity.Category;
import com.blog.common.i18n.LocalizedText;
import com.blog.common.security.SeedAdmin;
import com.blog.common.text.ReadingTime;
import com.blog.media.mapper.MediaMapper;
import com.blog.post.dto.PostAuthorResponse;
import com.blog.post.dto.PostResponse;
import com.blog.post.dto.PostSummaryResponse;
import com.blog.post.dto.PostTranslationResponse;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostHead;
import com.blog.series.dto.SeriesRefResponse;
import com.blog.series.entity.Series;
import com.blog.tag.dto.TagResponse;
import com.blog.tag.entity.Tag;
import com.blog.user.entity.User;
import com.blog.user.service.PublicSlugs;
import java.util.Comparator;
import java.util.List;

/**
 * Post entity to DTO. The view count and "Part n/m" are parameters, not read from the entity: both depend on other
 * tables or other posts, and the mapper is a pure function of one entity, so the service looks them up in a batch for
 * the whole page and passes them in. There is no overload that omits those two parameters, so the compiler points out
 * every call site that is missing them.
 *
 * Call inside a transaction: the cover, series, category, tags and author are LAZY relations, and open-in-view is off.
 */
public final class PostMapper {

    private PostMapper() {}

    public static PostResponse toResponse(
            Post post, long viewCount, PartInfo part, List<PostTranslationResponse> translations) {
        CategoryResponse categoryResponse =
                post.getCategory() == null ? null : toCategoryResponse(post.getCategory(), post.getLanguage());

        return new PostResponse(
                post.getId(),
                post.getTitle(),
                post.getSlug(),
                post.getExcerpt(),
                post.getContent(),
                post.getStatus().name(),
                categoryResponse,
                toTagResponses(post),
                post.isFeatured(),
                readingMinutes(post.getContent()),
                post.getPublishedAt(),
                post.getCreatedAt(),
                post.getUpdatedAt(),
                MediaMapper.toResponse(post.getCover()),
                toSeriesRef(post, part),
                post.getFeaturedRank(),
                viewCount,
                toAuthor(post.getAuthor()),
                post.getLanguage(),
                translations);
    }

    /**
     * The card of a list. Takes a {@link PostHead}, so it can be given a {@code PostCard} (no body) and cannot read the body; the
     * reading time is the figure stored with the post (0 only for a row that the startup backfill has not reached yet).
     */
    public static PostSummaryResponse toSummary(
            PostHead post, long viewCount, PartInfo part, List<PostTranslationResponse> translations) {
        CategoryResponse categoryResponse =
                post.getCategory() == null ? null : toCategoryResponse(post.getCategory(), post.getLanguage());

        return new PostSummaryResponse(
                post.getId(),
                post.getTitle(),
                post.getSlug(),
                post.getExcerpt(),
                post.getStatus().name(),
                categoryResponse,
                toTagResponses(post),
                post.isFeatured(),
                Math.max(1, post.getReadingMinutes()),
                post.getPublishedAt(),
                MediaMapper.toResponse(post.getCover()),
                toSeriesRef(post, part),
                post.getFeaturedRank(),
                viewCount,
                post.getUpdatedAt(),
                toAuthor(post.getAuthor()),
                post.getLanguage(),
                translations);
    }

    /**
     * An estimated read time in whole minutes, never less than one: {@link ReadingTime#minutes}. The list endpoints read the
     * figure that is stored with the post (it is set whenever the body is set), so that they never have to load the body; this
     * is the same function, kept here for the callers that already hold the text.
     *
     * Public so a series can total its parts with this same function: the total reading time shown for a series must be
     * the sum of the figures shown on its posts, not a second estimate that could disagree with them.
     */
    public static int readingMinutes(String content) {
        return ReadingTime.minutes(content);
    }

    /**
     * The part number and count come from {@code part}, counted over the PUBLISHED parts. {@code position} is the same ordinal
     * for a post that is published: the stored position can have gaps (unpublished or detached parts), and a gap would tell a
     * reader how many unpublished posts the series has. Only a post that is not published (seen by its author or an ADMIN, in
     * the admin API) carries the stored position, for ordering. The position is never null when there is a series: the CHECK
     * {@code chk_posts_series_membership} makes the two columns go together.
     */
    private static SeriesRefResponse toSeriesRef(PostHead post, PartInfo part) {
        Series series = post.getSeries();
        if (series == null) {
            return null;
        }
        int position = part.partNumber() != null ? part.partNumber() : post.getSeriesPosition();
        return new SeriesRefResponse(
                series.getId(), series.getSlug(), series.getTitle(), position, part.partNumber(), part.partCount());
    }

    // The site owner is the seeded row, not the ADMIN role, like the comment flag. getId() read from a proxy loads
    // nothing; the name and GitHub fields load the authors in a batch for the whole page (default_batch_fetch_size),
    // like categories.
    private static PostAuthorResponse toAuthor(User author) {
        return new PostAuthorResponse(
                author.getDisplayName(),
                author.getGithubLogin(),
                author.getAvatarUrl(),
                SeedAdmin.ID.equals(author.getId()),
                PublicSlugs.profileSlugOf(author));
    }

    /** Tag names in the language of the post, with fallback to the base name; the order stays by base name. */
    private static List<TagResponse> toTagResponses(PostHead post) {
        return post.getTags().stream()
                .sorted(Comparator.comparing(Tag::getName))
                .map(tag -> new TagResponse(
                        tag.getId(),
                        LocalizedText.name(tag.getTranslations(), post.getLanguage(), tag.getName()),
                        tag.getSlug()))
                .toList();
    }

    static CategoryResponse toCategoryResponse(Category category, String language) {
        return new CategoryResponse(
                category.getId(),
                LocalizedText.name(category.getTranslations(), language, category.getName()),
                category.getSlug(),
                LocalizedText.description(category.getTranslations(), language, category.getDescription()));
    }
}
