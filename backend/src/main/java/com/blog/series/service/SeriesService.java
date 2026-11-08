package com.blog.series.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.LocalizedText;
import com.blog.common.i18n.TaxonomyTranslations;
import com.blog.common.util.SlugGenerator;
import com.blog.post.entity.PostCard;
import com.blog.post.repository.PostCardRepository;
import com.blog.post.repository.PostRepository;
import com.blog.post.repository.SeriesMemberRow;
import com.blog.post.service.PostService;
import com.blog.search.index.DocType;
import com.blog.search.sync.SearchOutbox;
import com.blog.series.dto.SeriesAdminPostResponse;
import com.blog.series.dto.SeriesAdminResponse;
import com.blog.series.dto.SeriesDetailResponse;
import com.blog.series.dto.SeriesPartRef;
import com.blog.series.dto.SeriesRequest;
import com.blog.series.dto.SeriesSummaryResponse;
import com.blog.series.entity.Series;
import com.blog.series.repository.SeriesRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Series: the public page in reading order, and administration (ADMIN only, URL rule).
 *
 * The series table keeps only the title, slug and description; membership, position and the declared part live on posts and
 * are written ONLY in {@link #setPosts} ("detach the whole series, then assign 1..n" in one transaction, declared parts kept
 * for the posts that stay) and in {@link #placeByPart} (the import puts one post at the number its author declared).
 * Updating a post does not touch them (read-only columns on the entity), so the post editor, a seed script or a stale tab
 * can never detach a post from a series by accident. The position is the order key; the declared part is only a number the
 * author promised, unique per series and language.
 *
 * The public side sees only published parts. Every number (part count, reading time, "Part n/m") is counted over those
 * parts, never read from the stored position: positions have gaps (unpublished parts, parts moved elsewhere).
 */
@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class SeriesService {

    /** The series with the most recently published part comes first; ties go by title, so the order is deterministic. */
    private static final Comparator<SeriesSummaryResponse> LATEST_FIRST = Comparator.comparing(
                    SeriesSummaryResponse::latestPublishedAt, Comparator.nullsLast(Comparator.reverseOrder()))
            .thenComparing(SeriesSummaryResponse::title);

    private final SeriesRepository seriesRepository;
    private final PostRepository postRepository;
    private final PostCardRepository postCardRepository;
    private final PostService postService;
    private final SearchOutbox searchOutbox;
    private final TaxonomyTranslations taxonomyTranslations;

    // --- Public --------------------------------------------------------------------------------------------

    /**
     * Every series with at least one published part, with those parts in reading order. One query for the whole list
     * (parts fetched together with their series), not one query per series. Not paged: a personal blog has a few series,
     * and the /series page needs the whole list to count.
     */
    public List<SeriesSummaryResponse> listPublished() {
        return listPublished(null);
    }

    /**
     * With a language: only series with a published part in that language, titled in it (fallback to the base title),
     * and every number counted over the parts in that language. Without one: as {@link #listPublished()}.
     */
    public List<SeriesSummaryResponse> listPublished(String language) {
        Map<UUID, List<PostCard>> partsBySeries = postCardRepository.findPublishedInAnySeries().stream()
                .filter(post -> language == null || language.equals(post.getLanguage()))
                .collect(Collectors.groupingBy(
                        post -> post.getSeries().getId(), LinkedHashMap::new, Collectors.toList()));
        return partsBySeries.values().stream()
                .map(parts -> toSummary(parts.getFirst().getSeries(), parts, language))
                .sorted(LATEST_FIRST)
                .toList();
    }

    /**
     * A series and its published parts in reading order, each part a post summary with "Part n/m".
     *
     * @throws ApiException 404 {@code SERIES_NOT_FOUND} when there is no such slug, or the series has no published part:
     *                      for readers that series does not exist yet, and the public page must not reveal the name of
     *                      a series being drafted
     */
    public SeriesDetailResponse getPublishedBySlug(String slug) {
        return getPublishedBySlug(slug, null);
    }

    /**
     * Visibility is "a published part in any language", so a page can show the fallback; with a language the title is
     * localized and only the parts in that language are listed (possibly none).
     */
    public SeriesDetailResponse getPublishedBySlug(String slug, String language) {
        Series series = seriesRepository.findBySlug(slug).orElseThrow(() -> notFound(slug));
        List<PostCard> parts = postCardRepository.findPublishedInSeries(series.getId());
        if (parts.isEmpty()) {
            throw notFound(slug);
        }
        // Map inside this transaction (open-in-view is off) with the batch helper of PostService: part counts, view
        // counts.
        List<PostCard> shown = language == null
                ? parts
                : parts.stream()
                        .filter(post -> language.equals(post.getLanguage()))
                        .toList();
        return new SeriesDetailResponse(
                series.getId(),
                LocalizedText.name(series.getTranslations(), language, series.getTitle()),
                series.getSlug(),
                LocalizedText.description(series.getTranslations(), language, series.getDescription()),
                shown.isEmpty() ? List.of() : postService.toSummaries(shown));
    }

    // --- Admin ---------------------------------------------------------------------------------------------

    /** Every series by title, including series with no posts: the admin screen is the only place to add posts to one. */
    public List<SeriesAdminResponse> listAll() {
        List<Series> all = seriesRepository.findAllByOrderByTitleAsc();
        if (all.isEmpty()) {
            return List.of();
        }
        Map<UUID, List<SeriesAdminPostResponse>> members =
                membersOf(all.stream().map(Series::getId).toList());
        return all.stream()
                .map(series -> toAdminResponse(series, members.getOrDefault(series.getId(), List.of())))
                .toList();
    }

    public SeriesAdminResponse getById(UUID id) {
        return toAdminResponse(find(id));
    }

    /** @throws ApiException 409 {@code SERIES_ALREADY_EXISTS} when a series with the same title exists, ignoring letter case */
    @Transactional
    public SeriesAdminResponse create(SeriesRequest request) {
        String title = request.title().strip();
        if (seriesRepository.existsByTitleIgnoreCase(title)) {
            throw alreadyExists(title);
        }
        // Two sources in priority order, like a post slug: the slug sent along (normalized), then the title.
        String requested = request.slug() == null ? "" : SlugGenerator.slugifyOrEmpty(request.slug());
        String baseSlug = requested.isEmpty() ? SlugGenerator.slugify(title) : requested;

        Series series = new Series();
        series.setTitle(title);
        series.setSlug(SlugGenerator.ensureUnique(baseSlug, seriesRepository::existsBySlug));
        series.setDescription(normalizeDescription(request.description()));
        if (request.translations() != null) {
            series.setTranslations(normalize(request));
        }
        // A new series has no posts yet: membership is written only through setPosts.
        Series saved = seriesRepository.save(series);
        searchOutbox.enqueue(DocType.SERIES, saved.getId());
        return toAdminResponse(saved, List.of());
    }

    /**
     * Replaces the whole title and description. A null or empty slug (after normalization) keeps the old slug and does not
     * regenerate it from the title: fixing a typo in the title must not change the public URL of the series.
     *
     * @throws ApiException 404 {@code SERIES_NOT_FOUND}; 409 {@code SERIES_ALREADY_EXISTS} when the title duplicates ANOTHER
     *                      series (changing the letter case of its own title is fine)
     */
    @Transactional
    public SeriesAdminResponse update(UUID id, SeriesRequest request) {
        Series series = find(id);
        String title = request.title().strip();
        if (seriesRepository.existsByTitleIgnoreCaseAndIdNot(title, id)) {
            throw alreadyExists(title);
        }
        series.setTitle(title);
        series.setDescription(normalizeDescription(request.description()));
        if (request.translations() != null) {
            series.setTranslations(normalize(request));
        }
        if (request.slug() != null) {
            String requested = SlugGenerator.slugifyOrEmpty(request.slug());
            if (!requested.isEmpty() && !requested.equals(series.getSlug())) {
                series.setSlug(SlugGenerator.ensureUnique(
                        requested, candidate -> seriesRepository.existsBySlugAndIdNot(candidate, id)));
            }
        }
        // The post documents carry the series name.
        searchOutbox.enqueue(DocType.SERIES, id);
        searchOutbox.publishedPostsInSeries(id);
        // Flush now: @PreUpdate sets updatedAt at flush time, and the response must carry the time of this very edit.
        return toAdminResponse(seriesRepository.saveAndFlush(series));
    }

    /**
     * Replaces the whole membership: the i-th post in the list stands at position i; a post that is in another series moves
     * over (the old series is left with a gap, harmless); a post no longer in the list is detached from the series. This is
     * the ONLY membership write path.
     *
     * One transaction, under the row lock of the series (see {@link SeriesRepository#findByIdForUpdate}): the whole series is
     * detached first and only then assigned, so the new positions never collide with the old ones on the unique
     * constraint. An error on any post rolls back the whole write: the series keeps its old members. A post that stays in the
     * series keeps the part its author declared; a post that comes from another series arrives without one, and a post that
     * leaves loses it.
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the list has duplicate ids; 404 {@code SERIES_NOT_FOUND};
     *                      400 {@code POST_NOT_FOUND} when an id is not any post (the id is in the request body, not in
     *                      the path, so it is a 400 and not a 404)
     */
    @Transactional
    public SeriesAdminResponse setPosts(UUID id, List<UUID> postIds) {
        if (new HashSet<>(postIds).size() < postIds.size()) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "postIds must not contain duplicates");
        }
        // The first lock of every series writer, like every other writer of translation groups: the import and the
        // translation service take this lock before the posts and then the series, so a writer that took the series
        // first could deadlock with them.
        postRepository.lockTranslationWrites();
        Series series = lock(id);
        // Before detaching: the old members, the new members and the current series of those (a series may lose its
        // last published part).
        searchOutbox.enqueue(DocType.SERIES, id);
        searchOutbox.publishedPostsInSeries(id);
        searchOutbox.publishedPostsAndTheirSeries(postIds);
        // The declared parts of the members now, to put back for the posts that stay (the detach below clears them).
        Map<UUID, Integer> declared = new HashMap<>();
        for (SeriesMemberRow member : postRepository.findSeriesMembers(id)) {
            if (member.getPart() != null) {
                declared.put(member.getId(), member.getPart());
            }
        }
        postRepository.clearSeries(id);
        for (int i = 0; i < postIds.size(); i++) {
            UUID postId = postIds.get(i);
            // Check by the number of rows the UPDATE touched instead of looking up first: no gap between the lookup and
            // the
            // write for a deleted post to slip through, and no extra query.
            if (postRepository.assignToSeriesAtPart(postId, id, i + 1, declared.get(postId)) == 0) {
                throw new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.BAD_REQUEST, "Post not found: " + postId);
            }
        }
        // clearSeries/assignToSeries clear the persistence context, so the series here is detached from it; its fields
        // are already loaded and unchanged, while the list of posts is queried again.
        return toAdminResponse(series);
    }

    /**
     * Puts one post into a series at the number its author declared (the import), whatever order the numbers arrive in: the
     * post is inserted before the first member of the same language whose declared part is greater, or at the end when there
     * is none. Members without a declared part stay where they are, and no other member loses its declared part. Appending
     * writes one row; inserting in the middle renumbers the series 1..n by shifting every position out of the way first (the
     * unique constraint is checked row by row). A post that is in another series moves over and leaves its part behind.
     *
     * A post that is already a member keeps its place when the declared parts agree with it: when no member of the same
     * language before it declares a greater part and none after it a smaller one, only its part is written (every member that
     * predates the declared parts has none, and declaring one must not scramble a series an administrator ordered by hand).
     * It is removed and inserted again only when the declared parts say it is out of order.
     *
     * Takes the series row lock; the caller (the import) holds the translation-writes lock and the import-wide lock, and takes
     * the locks of all series it touches in id order before it takes this one again. The search documents of the series, of
     * the post and of the series the post comes from are queued before anything is written, as {@link #setPosts} does.
     *
     * @throws ApiException 404 {@code SERIES_NOT_FOUND}; 400 {@code POST_NOT_FOUND}
     * @throws org.springframework.dao.DataIntegrityViolationException when another post of the same language holds the part
     *                      (the unique index {@code uq_posts_series_language_part}); the transaction must be rolled back
     */
    @Transactional
    public void placeByPart(UUID seriesId, UUID postId, int part) {
        postRepository.lockTranslationWrites();
        lock(seriesId);
        String language = postRepository
                .findLanguageById(postId)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.POST_NOT_FOUND, HttpStatus.BAD_REQUEST, "Post not found: " + postId));
        List<SeriesMemberRow> members = postRepository.findSeriesMembers(seriesId);
        searchOutbox.enqueue(DocType.SERIES, seriesId);
        searchOutbox.publishedPostsInSeries(seriesId);
        searchOutbox.publishedPostsAndTheirSeries(List.of(postId));
        SeriesMemberRow self = members.stream()
                .filter(member -> member.getId().equals(postId))
                .findFirst()
                .orElse(null);
        if (self != null && agreesWithDeclaredParts(members, self, language, part)) {
            postRepository.assignToSeriesAtPart(postId, seriesId, self.getPosition(), part);
            return;
        }
        List<SeriesMemberRow> others = new ArrayList<>(members);
        others.removeIf(member -> member.getId().equals(postId));
        int at = others.size();
        for (int i = 0; i < others.size(); i++) {
            SeriesMemberRow member = others.get(i);
            if (language.equals(member.getLanguage()) && member.getPart() != null && member.getPart() > part) {
                at = i;
                break;
            }
        }
        if (at == others.size()) {
            int last = others.isEmpty() ? 0 : others.getLast().getPosition();
            postRepository.assignToSeriesAtPart(postId, seriesId, last + 1, part);
            return;
        }
        int highest =
                members.stream().mapToInt(SeriesMemberRow::getPosition).max().orElse(0);
        postRepository.shiftSeriesPositions(seriesId, Math.max(highest, others.size() + 1));
        for (int i = 0; i < others.size(); i++) {
            postRepository.setSeriesPosition(others.get(i).getId(), i < at ? i + 1 : i + 2);
        }
        postRepository.assignToSeriesAtPart(postId, seriesId, at + 1, part);
    }

    /**
     * Whether a member can take the declared part where it stands: no member of its own language before it declares a greater
     * part and none after it a smaller one. Members of the other language and members without a declared part do not count.
     */
    private static boolean agreesWithDeclaredParts(
            List<SeriesMemberRow> members, SeriesMemberRow self, String language, int part) {
        boolean before = true;
        for (SeriesMemberRow member : members) {
            if (member.getId().equals(self.getId())) {
                before = false;
            } else if (language.equals(member.getLanguage()) && member.getPart() != null) {
                if (before ? member.getPart() > part : member.getPart() < part) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Gives a series the description of a post file when it has none: a description that is there is never overwritten, and a
     * blank value writes nothing. The search documents of the series and of its published posts (which carry its name) are
     * queued before the write, as {@link #update} does. Takes the series row lock; the caller (the import) holds the
     * translation-writes lock and the import-wide lock.
     *
     * @return whether the description was written
     * @throws ApiException 404 {@code SERIES_NOT_FOUND}
     */
    @Transactional
    public boolean fillDescriptionIfEmpty(UUID id, String description) {
        String wanted = normalizeDescription(description);
        if (wanted == null) {
            return false;
        }
        postRepository.lockTranslationWrites();
        Series series = lock(id);
        if (normalizeDescription(series.getDescription()) != null) {
            return false;
        }
        searchOutbox.enqueue(DocType.SERIES, id);
        searchOutbox.publishedPostsInSeries(id);
        series.setDescription(wanted);
        // Flush now: the statements that move posts clear the persistence context, which would drop this change.
        seriesRepository.saveAndFlush(series);
        return true;
    }

    /**
     * Detaches every post from the series, then deletes the series; the posts stay intact. Detaching first is required: the
     * foreign key posts.series_id has no ON DELETE (V14), so deleting a series that still has posts would be blocked (409)
     * rather than leave a position with no series.
     *
     * @throws ApiException 404 {@code SERIES_NOT_FOUND}
     */
    @Transactional
    public void delete(UUID id) {
        postRepository.lockTranslationWrites();
        lock(id);
        searchOutbox.enqueue(DocType.SERIES, id);
        searchOutbox.publishedPostsInSeries(id);
        postRepository.clearSeries(id);
        seriesRepository.deleteById(id);
    }

    // --- Mapping -------------------------------------------------------------------------------------------

    private Map<String, LocalizedText> normalize(SeriesRequest request) {
        return taxonomyTranslations.normalize(request.translations(), 255, 2000);
    }

    private static SeriesSummaryResponse toSummary(Series series, List<PostCard> parts, String language) {
        // Same function as the readingMinutes of each post: the series "m minutes to read" is the sum of the numbers
        // the
        // reader sees on each part, not a second estimate that could disagree with them.
        int readingMinutes = parts.stream()
                .mapToInt(post -> Math.max(1, post.getReadingMinutes()))
                .sum();
        Instant latestPublishedAt = parts.stream()
                .map(PostCard::getPublishedAt)
                .filter(Objects::nonNull)
                .max(Comparator.naturalOrder())
                .orElse(null);
        List<SeriesPartRef> refs = parts.stream()
                .map(post -> new SeriesPartRef(post.getSlug(), post.getTitle()))
                .toList();
        return new SeriesSummaryResponse(
                series.getId(),
                LocalizedText.name(series.getTranslations(), language, series.getTitle()),
                series.getSlug(),
                LocalizedText.description(series.getTranslations(), language, series.getDescription()),
                parts.size(),
                readingMinutes,
                latestPublishedAt,
                refs);
    }

    private SeriesAdminResponse toAdminResponse(Series series) {
        return toAdminResponse(series, membersOf(List.of(series.getId())).getOrDefault(series.getId(), List.of()));
    }

    private static SeriesAdminResponse toAdminResponse(Series series, List<SeriesAdminPostResponse> posts) {
        return new SeriesAdminResponse(
                series.getId(),
                series.getTitle(),
                series.getSlug(),
                series.getDescription(),
                series.getTranslations(),
                posts,
                series.getCreatedAt(),
                series.getUpdatedAt());
    }

    /** The posts of the given series by position, grouped by series: one query for the whole screen. */
    private Map<UUID, List<SeriesAdminPostResponse>> membersOf(Collection<UUID> seriesIds) {
        // getSeries().getId() reads the id from the LAZY proxy without loading the series.
        return postCardRepository.findAllInSeries(seriesIds).stream()
                .collect(Collectors.groupingBy(
                        post -> post.getSeries().getId(),
                        LinkedHashMap::new,
                        Collectors.mapping(SeriesService::toAdminPost, Collectors.toList())));
    }

    private static SeriesAdminPostResponse toAdminPost(PostCard post) {
        // The position is never null when there is a series: the CHECK chk_posts_series_membership (V14) forces the two
        // columns to go together.
        return new SeriesAdminPostResponse(
                post.getId(), post.getTitle(), post.getSlug(), post.getStatus().name(), post.getSeriesPosition());
    }

    // --- Lookup --------------------------------------------------------------------------------------------

    private Series find(UUID id) {
        return seriesRepository.findById(id).orElseThrow(() -> notFound(id.toString()));
    }

    private Series lock(UUID id) {
        return seriesRepository.findByIdForUpdate(id).orElseThrow(() -> notFound(id.toString()));
    }

    /** A blank description means no description: the UI hides a field that was not filled in, and "" would render as an empty paragraph. */
    private static String normalizeDescription(String description) {
        return description == null || description.isBlank() ? null : description.strip();
    }

    private static ApiException notFound(String idOrSlug) {
        return new ApiException(ErrorCode.SERIES_NOT_FOUND, HttpStatus.NOT_FOUND, "Series not found: " + idOrSlug);
    }

    private static ApiException alreadyExists(String title) {
        return new ApiException(
                ErrorCode.SERIES_ALREADY_EXISTS, HttpStatus.CONFLICT, "Series '" + title + "' already exists");
    }
}
