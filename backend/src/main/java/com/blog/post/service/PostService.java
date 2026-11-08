package com.blog.post.service;

import static com.blog.search.service.SearchLimits.MAX_PAGE_SIZE;
import static com.blog.search.service.SearchLimits.clampPage;
import static com.blog.search.service.SearchLimits.clampSize;

import com.blog.category.entity.Category;
import com.blog.category.repository.CategoryRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.quota.AuthorQuotaProperties;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.text.UserText;
import com.blog.common.util.SlugGenerator;
import com.blog.media.service.MediaService;
import com.blog.newsletter.service.NewsletterOutbox;
import com.blog.post.dto.PostCreateRequest;
import com.blog.post.dto.PostLimits;
import com.blog.post.dto.PostRedirectResponse;
import com.blog.post.dto.PostResponse;
import com.blog.post.dto.PostSummaryResponse;
import com.blog.post.dto.PostTranslationResponse;
import com.blog.post.dto.PostUpdateRequest;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostCard;
import com.blog.post.entity.PostHead;
import com.blog.post.entity.PostRevision;
import com.blog.post.entity.PostStatus;
import com.blog.post.entity.PostView;
import com.blog.post.mapper.PartInfo;
import com.blog.post.mapper.PostMapper;
import com.blog.post.repository.PartNumberRow;
import com.blog.post.repository.PostCardRepository;
import com.blog.post.repository.PostRepository;
import com.blog.post.repository.PostViewRepository;
import com.blog.post.repository.TranslationRow;
import com.blog.post.specification.PostSpecifications;
import com.blog.search.index.DocType;
import com.blog.search.service.SearchLimits;
import com.blog.search.sync.SearchOutbox;
import com.blog.tag.entity.Tag;
import com.blog.tag.repository.TagRepository;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.PublicSlugs;
import jakarta.persistence.EntityManager;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.data.support.PageableExecutionUtils;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class PostService {

    private static final Logger log = LoggerFactory.getLogger(PostService.class);

    /** The two orders of the public post list ({@code ?sort=}); latest is the default. */
    public static final String SORT_LATEST = "latest";

    public static final String SORT_POPULAR = "popular";

    private final PostRepository postRepository;
    private final PostCardRepository postCardRepository;
    private final CategoryRepository categoryRepository;
    private final TagRepository tagRepository;
    private final UserRepository userRepository;
    private final PostViewRepository postViewRepository;
    private final MediaService mediaService;
    private final PostRevisionService postRevisionService;
    private final EntityManager entityManager;
    private final NewsletterOutbox newsletterOutbox;
    private final SearchOutbox searchOutbox;
    private final Languages languages;
    private final RateLimiter rateLimiter;
    private final AuthorQuotaProperties authorQuota;

    /**
     * Creates a draft owned by {@code authorId}. An AUTHOR is limited (an ADMIN is exempt): {@code app.rate-limit.post-write}
     * writes in ten minutes (429 {@code RATE_LIMITED}), {@code app.author-quota.max-tags-per-post} tags (400
     * {@code VALIDATION_ERROR}) and {@code max-posts-per-day} posts created in 24 hours, imports included (429
     * {@code AUTHOR_QUOTA_EXCEEDED}). The limits are decided by the role of the author the post is created for, who is the
     * caller in every path (the editor, a translation draft, an import).
     */
    @Transactional
    public PostResponse create(UUID authorId, PostCreateRequest request) {
        // NOT_FOUND rather than BAD_REQUEST: since Task 6, authorId no longer arrives in the
        // request body - it comes from the authenticated principal - so a missing author is
        // not a malformed client request. It is the token's subject no longer existing, which
        // is a 404 the same way a vanished post or category is.
        User author = userRepository
                .findById(authorId)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.AUTHOR_NOT_FOUND, HttpStatus.NOT_FOUND, "Author not found: " + authorId));

        if (author.getRole() != UserRole.ADMIN) {
            requireAuthorMayCreatePost(authorId);
            requireTagCount(request.tagIds(), Set.of());
        }
        String title = displayTitle(request.title());
        Post post = new Post();
        post.setTitle(title);
        post.setExcerpt(displayExcerpt(request.excerpt()));
        post.setContent(request.content());
        post.setStatus(PostStatus.DRAFT);
        post.setLanguage(languages.orDefault(request.language()));
        post.setAuthor(author);
        post.setCategory(resolveCategory(request.categoryId()));
        post.setTags(resolveTags(request.tagIds()));

        // Two sources in priority order, and the title is the one that carries the
        // fallback. slugifyOrEmpty is what makes "the author typed punctuation"
        // distinguishable from "the author typed untitled".
        String requested = request.slug() == null ? "" : SlugGenerator.slugifyOrEmpty(request.slug());
        String baseSlug = requested.isEmpty() ? SlugGenerator.slugify(title) : requested;
        // The old slug of a post whose slug changed is also a slug that already has an owner: taking it would make the
        // old
        // link of that other post open this post. Ask posts FIRST and then the history: a concurrent slug change moves
        // the
        // slug from posts to the history in one commit, so in this order, whenever the commit lands, one of the two
        // queries still sees that slug.
        post.setSlug(SlugGenerator.ensureUnique(
                baseSlug,
                candidate -> postRepository.existsBySlug(candidate) || postRepository.existsInSlugHistory(candidate)));

        // No lookups needed: the four read-only columns (cover, series, position, rank) are not in the entity's INSERT,
        // so
        // they are always null on a new post, and a freshly generated id cannot have a row in post_views yet.
        Post saved = postRepository.save(post);
        searchOutbox.enqueue(DocType.POST, saved.getId());
        return PostMapper.toResponse(saved, 0, PartInfo.NONE, List.of());
    }

    /**
     * The limits of an AUTHOR who adds a post by any path: one write counted against {@code app.rate-limit.post-write} (429
     * {@code RATE_LIMITED}), then {@code app.author-quota.max-posts-per-day} posts created in the last 24 hours (429
     * {@code AUTHOR_QUOTA_EXCEEDED}). The editor, an import and a translation draft all call it, so no path adds posts
     * without being counted. The caller skips it for an ADMIN, who is exempt.
     *
     * @param authorId the account the post is created for
     */
    public void requireAuthorMayCreatePost(UUID authorId) {
        rateLimiter.check(RateLimiter.POST_WRITE, authorId);
        if (postRepository.countByAuthorIdAndCreatedAtAfter(
                        authorId, Instant.now().minus(1, ChronoUnit.DAYS))
                >= authorQuota.maxPostsPerDay()) {
            throw new ApiException(
                    ErrorCode.AUTHOR_QUOTA_EXCEEDED,
                    HttpStatus.TOO_MANY_REQUESTS,
                    "At most " + authorQuota.maxPostsPerDay() + " posts can be created in 24 hours");
        }
    }

    /**
     * Replaces the whole post (PUT). Before the new text is assigned, the current text is kept as a revision when this
     * save really changes the title, excerpt or content (the coalescing and limit rules are in
     * {@link PostRevisionService}). Same transaction: a save that fails at a later step (missing category or tag) does
     * not record that revision either.
     *
     * @param editor the person saving, from the token: the author of the revision
     */
    @Transactional
    public PostResponse update(UUID postId, PostUpdateRequest request, UUID editor) {
        if (request.language() != null && !request.language().isBlank()) {
            // A language change checks the group: serialise with every other group write before reading the post.
            postRepository.lockTranslationWrites();
        }
        boolean limited = !isAdmin(editor);
        if (limited) {
            rateLimiter.check(RateLimiter.POST_WRITE, editor);
        }
        String title = displayTitle(request.title());
        String excerpt = displayExcerpt(request.excerpt());
        Post post = getEntityById(postId);
        if (limited) {
            requireTagCount(request.tagIds(), tagIdsOf(post));
        }
        // Before every setter: this is the only place where the old text can still be read on the entity.
        postRevisionService.recordBeforeEdit(post, title, excerpt, request.content(), editor);
        Set<UUID> categoryBefore = categoryIdOf(post);
        Set<UUID> tagsBefore = tagIdsOf(post);
        post.setTitle(title);
        post.setExcerpt(excerpt);
        post.setContent(request.content());
        post.setCategory(resolveCategory(request.categoryId()));
        post.setTags(resolveTags(request.tagIds()));
        boolean languageChanged = changeLanguage(post, request.language());
        if (request.slug() != null) {
            String requested = SlugGenerator.slugifyOrEmpty(request.slug());
            // Empty covers both "field left blank" and "the author typed punctuation",
            // and both answer the same way: keep the slug this post already has.
            // Re-deriving from the title here is the one thing that must never happen —
            // it would move a published post's URL the first time a typo in its title
            // is corrected, which is the whole reason the slug field is editable.
            if (!requested.isEmpty() && !requested.equals(post.getSlug())) {
                // Exclude this post from the uniqueness check. The editor sends the slug
                // field on every save, so the usual case is a slug this post already
                // owns; checking existsBySlug would rename it on every save.
                //
                // The old slug of ANOTHER post is also rejected (suffix), in the same posts-then-history order as in
                // create;
                // this post's own old slug can be taken back.
                String slug = SlugGenerator.ensureUnique(
                        requested,
                        candidate -> postRepository.existsBySlugAndIdNot(candidate, postId)
                                || postRepository.existsInSlugHistoryOfOtherPost(candidate, postId));
                changeSlug(post, slug);
            }
        }
        PostResponse response = saved(post);
        searchOutbox.enqueue(DocType.POST, postId);
        if (languageChanged) {
            // A category, tag or series is listed per language of its published posts: the old and new language change.
            searchOutbox.postAndRelated(postId);
        }
        if (post.getStatus() == PostStatus.PUBLISHED) {
            // Categories and tags only show when they have a published post: the one that just entered or left
            // this post may change visibility.
            searchOutbox.enqueue(DocType.CATEGORY, changed(categoryBefore, categoryIdOf(post)));
            searchOutbox.enqueue(DocType.TAG, changed(tagsBefore, tagIdsOf(post)));
        }
        return response;
    }

    /** An account that cannot be read counts as an AUTHOR: the limits stay on. */
    private boolean isAdmin(UUID account) {
        return userRepository
                .findRoleById(account)
                .filter(role -> role == UserRole.ADMIN)
                .isPresent();
    }

    /**
     * An AUTHOR's post carries at most {@code app.author-quota.max-tags-per-post} tags. A post that already has more (it was
     * written under a higher limit, or an administrator tagged it) can still be saved as long as the save adds no tag: the limit
     * stops growth and never locks an existing post.
     *
     * @param alreadyOnPost the tags the post has now; empty for a new post
     */
    private void requireTagCount(Set<UUID> tagIds, Set<UUID> alreadyOnPost) {
        if (tagIds != null && tagIds.size() > authorQuota.maxTagsPerPost() && !alreadyOnPost.containsAll(tagIds)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "A post can have at most " + authorQuota.maxTagsPerPost() + " tags");
        }
    }

    /**
     * The title of a post is one line of display text: control characters and invisible or text-direction characters are
     * removed (a title is shown in lists, notifications, feeds and mail subjects, where U+202E can make it read as
     * something else), runs of white space become one space. A title with nothing visible left is refused.
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR}
     */
    private static String displayTitle(String raw) {
        String title = UserText.cleanName(raw);
        if (title.isEmpty()) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "title must contain visible text");
        }
        return title;
    }

    /** The excerpt: {@link UserText#clean} (line breaks and indentation stay); null stays null. */
    private static String displayExcerpt(String raw) {
        return raw == null ? null : UserText.clean(raw);
    }

    /**
     * Sets the post's language when the request names one. Inside a translation group two posts may not share a language
     * (constraint {@code uq_posts_translation_group_language}); checked first so the author gets a clear 409 instead of a
     * constraint violation. The slug, and so every old link, does not change with the language.
     *
     * @return whether the language really changed
     */
    private boolean changeLanguage(Post post, String requested) {
        if (requested == null || requested.isBlank()) {
            return false;
        }
        String language = languages.require(requested);
        if (language.equals(post.getLanguage())) {
            return false;
        }
        if (post.getTranslationGroupId() != null
                && postRepository.existsInTranslationGroup(post.getTranslationGroupId(), language, post.getId())) {
            throw new ApiException(
                    ErrorCode.TRANSLATION_CONFLICT,
                    HttpStatus.CONFLICT,
                    "Another translation of this post already uses the language " + language);
        }
        // A declared part is unique per series and language (uq_posts_series_language_part): say so here instead of
        // leaving the unique index to answer with a generic conflict. The part stays with the post; the author's number
        // is never cleared silently.
        if (post.getSeries() != null && post.getSeriesPart() != null) {
            for (UUID holder :
                    postRepository.findSeriesPartHolders(post.getSeries().getId(), language, post.getSeriesPart())) {
                if (!holder.equals(post.getId())) {
                    throw new ApiException(
                            ErrorCode.SERIES_PART_CONFLICT,
                            HttpStatus.CONFLICT,
                            "Another post of this series already has this part in that language");
                }
            }
        }
        post.setLanguage(language);
        return true;
    }

    private static Set<UUID> categoryIdOf(Post post) {
        return post.getCategory() == null ? Set.of() : Set.of(post.getCategory().getId());
    }

    private static Set<UUID> tagIdsOf(Post post) {
        return post.getTags().stream().map(Tag::getId).collect(Collectors.toSet());
    }

    /** Present on exactly one side. */
    private static Set<UUID> changed(Set<UUID> before, Set<UUID> after) {
        Set<UUID> changed = new HashSet<>(before);
        changed.addAll(after);
        changed.removeIf(id -> before.contains(id) && after.contains(id));
        return changed;
    }

    /**
     * Changes the post's slug and keeps its history. Nothing happens when the slug does not really change: the suffix
     * rule can bring the requested slug back to the one the post already has (another post has "bai", this one is
     * "bai-2").
     *
     * Taking back an old slug of the same post deletes that slug's row: the slug lives again, and there is no a -> c -> a
     * loop. The slug just left is recorded only when the post has ever been published ({@code publishedAt} is set, even
     * while unpublished): its link may have been shared. A draft that never launched has no link to keep, and does not
     * hold on to anyone's slug.
     */
    private void changeSlug(Post post, String slug) {
        String previous = post.getSlug();
        if (slug.equals(previous)) {
            return;
        }
        postRepository.forgetOldSlug(slug, post.getId());
        if (post.getPublishedAt() != null) {
            // 0 rows: the slug already has a history row. This post's own (renamed back and forth) is fine; another
            // post's is
            // not (only hand-written data gets there, and the database refuses it too): never move it, stop the edit.
            if (postRepository.recordOldSlug(previous, post.getId()) == 0
                    && postRepository.existsInSlugHistoryOfOtherPost(previous, post.getId())) {
                throw new ApiException(
                        ErrorCode.RESOURCE_CONFLICT,
                        HttpStatus.CONFLICT,
                        "The current address of this post is the old address of another post");
            }
            // The post of an AUTHOR keeps only its newest few old addresses, so renaming again and again cannot reserve
            // a lot of
            // the site's address space for good. An ADMIN's own post keeps them all.
            if (post.getAuthor().getRole() != UserRole.ADMIN) {
                postRepository.trimSlugHistory(post.getId(), authorQuota.maxSlugHistoryPerPost());
            }
        }
        post.setSlug(slug);
    }

    /**
     * Releases an old address (ADMIN): the redirect from it stops working and the slug can be taken by any post. The post
     * itself and its other old addresses are not touched. An AUTHOR's post keeps only its newest few old addresses anyway;
     * this is for one that must be freed at once.
     *
     * @throws ApiException 404 {@code SLUG_HISTORY_NOT_FOUND} when {@code slug} is not an old address of any post
     */
    @Transactional
    public void releaseOldSlug(String slug) {
        if (postRepository.releaseOldSlug(slug) == 0) {
            throw new ApiException(
                    ErrorCode.SLUG_HISTORY_NOT_FOUND, HttpStatus.NOT_FOUND, "Not an old address of any post");
        }
        log.info("old slug released");
    }

    /**
     * Puts the text (title, excerpt, content) of a revision back into the post. Slug, status, publish date, category,
     * tags, series and cover are kept.
     *
     * The current text is recorded as a revision first, WITHOUT coalescing by the 10-minute window: if a restore was a
     * mistake, restoring the revision it just wrote undoes it. A post that already carries exactly that revision's text
     * does nothing (no duplicate revision, no updatedAt change): clicking restore twice is the same as once.
     *
     * Reads the post under a row lock: two overlapping restores (two tabs) make the later one wait, then record exactly
     * the state the earlier one left, so the undo chain loses no step. Saves and flushes at once so the response carries
     * the updatedAt that was written.
     *
     * @param editor the person restoring, from the token: the author of the revision that keeps the current state
     * @throws ApiException 404 {@code POST_NOT_FOUND}; 404 {@code REVISION_NOT_FOUND} when the revision does not exist
     *                      or belongs to another post
     */
    @Transactional
    public PostResponse restoreRevision(UUID postId, UUID revisionId, UUID editor) {
        Post post = postRepository
                .findByIdForUpdate(postId)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId));
        PostRevision revision = postRevisionService.find(postId, revisionId);
        // Read the revision's text before writing: the statement that keeps 20 revisions below may delete this very
        // revision
        // (it is the oldest), even though its text is still restored, and the post then carries exactly that text.
        // A revision saved before titles were cleaned may hold invisible or text-direction characters: they do not
        // come back (a title with nothing visible left keeps the current one).
        String cleanedTitle = UserText.cleanName(revision.getTitle());
        String title = cleanedTitle.isEmpty() ? post.getTitle() : cleanedTitle;
        String excerpt = displayExcerpt(revision.getExcerpt());
        String content = revision.getContent();
        if (title.equals(post.getTitle())
                && Objects.equals(excerpt, post.getExcerpt())
                && content.equals(post.getContent())) {
            return toResponse(post);
        }
        // A revision saved before the size limits can be longer than a post may be; the database refuses to store it
        // (V46), so say
        // so instead of answering with a conflict. Nothing was written yet.
        if (content.length() > PostLimits.CONTENT_MAX
                || (excerpt != null && excerpt.length() > PostLimits.EXCERPT_MAX)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "That revision is longer than a post may be");
        }
        postRevisionService.record(post, editor);
        post.setTitle(title);
        post.setExcerpt(excerpt);
        post.setContent(content);
        searchOutbox.enqueue(DocType.POST, postId);
        return saved(post);
    }

    /**
     * The delete button. An ADMIN deletes for good ({@link #delete(UUID)}). Anyone else (an AUTHOR, deleting their own post)
     * only hides it: the post leaves the site, the author's list and the search index, and everything that hangs on it stays,
     * because a hard delete would also destroy rows that belong to other people (the readers' comments with their likes and
     * notifications, saved posts, post likes, the newsletter record, the body images other posts may link to). The slug stays
     * reserved. An ADMIN sees the hidden post as ARCHIVED and can delete it for good. Hiding twice is not an error.
     *
     * @param caller the person deleting, from the token
     * @param admin  whether that person is an ADMIN
     * @throws ApiException 404 {@code POST_NOT_FOUND}
     */
    @Transactional
    public void delete(UUID postId, UUID caller, boolean admin) {
        if (admin) {
            long comments = postRepository.countCommentsOf(postId);
            delete(postId);
            log.info("post deleted postId={} by={} role=ADMIN kind=hard comments={}", postId, caller, comments);
            return;
        }
        // First lock, like every translation write: the hidden post leaves its translation group below.
        postRepository.lockTranslationWrites();
        Post post = postRepository
                .findByIdForUpdate(postId)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId));
        if (post.getDeletedAt() != null) {
            return;
        }
        UUID group = post.getTranslationGroupId();
        if (group != null) {
            postRepository.lockTranslationGroup(group);
        }
        post.setStatus(PostStatus.ARCHIVED);
        post.setDeletedAt(Instant.now().truncatedTo(ChronoUnit.MICROS));
        post.setDeletedBy(caller);
        // Taken off the public pages and out of the search index, like an unpublish; the translations are re-indexed
        // too.
        searchOutbox.postAndRelated(postId);
        if (group != null) {
            // Like the delete of an ADMIN: the siblings are left as they were and a group of one is dissolved, so that
            // the
            // sibling can be linked to another post of that language. Both statements flush the fields set above first.
            postRepository.clearTranslationGroup(postId);
            postRepository.dissolveSingleMemberGroup(group);
        }
        log.info(
                "post deleted postId={} by={} role=AUTHOR kind=hidden comments={}",
                postId,
                caller,
                postRepository.countCommentsOf(postId));
    }

    /**
     * Deletes the post and its cover image. The cover belongs to exactly this post (created through the post, unique
     * index on cover_media_id): leaving it would keep a few MB nothing points at in the DB, and its public URL would
     * still serve the image of a deleted post. Same transaction, so if deleting the post fails the image stays too.
     *
     * Images in the post body, revisions and old slugs go with the post through the {@code ON DELETE CASCADE} of the post
     * DELETE statement itself, and the image bytes through the media_content foreign key: no statement is needed here.
     *
     * Reads the post under a row lock, like every cover operation (PostCoverService): a concurrent cover replacement
     * either commits first and the new image is deleted with the post, or waits and finds the post gone. Without the lock
     * the new image would be attached to a post about to be deleted and stay behind as an orphan.
     */
    @Transactional
    public void delete(UUID postId) {
        // First lock, like every translation write: a post left alone in its group is dissolved below, and the group is
        // read after the lock so that a link made a moment earlier is seen.
        postRepository.lockTranslationWrites();
        Post post = postRepository
                .findByIdForUpdate(postId)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId));
        UUID group = post.getTranslationGroupId();
        if (group != null) {
            postRepository.lockTranslationGroup(group);
        }
        // The id is read from the LAZY proxy, without loading the image.
        UUID coverId = post.getCover() == null ? null : post.getCover().getId();
        // Before the delete: the post's category, tags, series and author can still be read in the DB.
        searchOutbox.postAndRelated(postId);
        postRepository.delete(post);
        if (group != null) {
            postRepository.dissolveSingleMemberGroup(group);
        }
        if (coverId != null) {
            mediaService.delete(coverId);
        }
    }

    public PostResponse getById(UUID postId) {
        return toResponse(getEntityById(postId));
    }

    /**
     * Publishes the post. The first publish also records the newsletter issue of the post: queued for the worker when an
     * ADMIN publishes, held for an administrator's approval when anyone else does (an AUTHOR writes text that would go to
     * every subscriber of the language).
     *
     * @param byAdmin whether the person publishing is an ADMIN: the caller reads it from the token, never from the request
     */
    @Transactional
    public PostResponse publish(UUID postId, boolean byAdmin) {
        // Row lock: two overlapping first publishes make the later one see that publishedAt is already set, so
        // only one issue goes out.
        Post post = postRepository
                .findByIdForUpdate(postId)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId));
        if (post.getContent() == null || post.getContent().isBlank()) {
            throw new ApiException(
                    ErrorCode.POST_NOT_PUBLISHABLE,
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    "Post content must not be blank before publishing");
        }
        if (post.getCategory() == null) {
            throw new ApiException(
                    ErrorCode.POST_NOT_PUBLISHABLE,
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    "Post must have a category before publishing");
        }
        if (post.getPublishedAt() == null) {
            // Truncate to microseconds: Postgres timestamptz columns store microsecond
            // precision, but Instant.now() on some JVM/OS combinations carries sub-microsecond
            // digits. Without truncation, the value returned in this response (still the
            // un-flushed in-memory Instant) would differ from the value read back from the
            // database on a later publish, making the "unchanged publishedAt" guarantee appear
            // violated even though the persisted instant never changes.
            post.setPublishedAt(Instant.now().truncatedTo(ChronoUnit.MICROS));
            newsletterOutbox.firstPublished(post.getId(), byAdmin);
        }
        post.setStatus(PostStatus.PUBLISHED);
        // Only an ADMIN gets here for a post its author deleted (an author no longer owns it): publishing it brings it
        // back.
        post.setDeletedAt(null);
        post.setDeletedBy(null);
        searchOutbox.postAndRelated(postId);
        return saved(post);
    }

    /**
     * Back to DRAFT, which removes the post from every public endpoint because those
     * filter on PUBLISHED. publishedAt is deliberately left alone: it records when this
     * post first went out, and publish() already guarantees that instant never changes
     * once set, so re-publishing restores the original date rather than inventing a new one.
     */
    @Transactional
    public PostResponse unpublish(UUID postId) {
        Post post = getEntityById(postId);
        if (post.getStatus() != PostStatus.PUBLISHED) {
            // Rejected rather than idempotent: a button that reports success without
            // changing anything is how a UI comes to show the wrong state confidently.
            throw new ApiException(
                    ErrorCode.POST_NOT_PUBLISHABLE,
                    HttpStatus.UNPROCESSABLE_ENTITY,
                    "Only a published post can be unpublished; this one is " + post.getStatus());
        }
        post.setStatus(PostStatus.DRAFT);
        searchOutbox.postAndRelated(postId);
        return saved(post);
    }

    /**
     * Idempotent on purpose, unlike publish/unpublish. Featuring is a presentation choice a
     * caller may reasonably set twice — a toggle in a UI, a re-run of the seed script — and
     * there is no state to corrupt by doing so, so 422 would be noise. Publish is different:
     * it has a side effect on `publishedAt` and on what the public can see, which is why it
     * refuses a no-op.
     *
     * A native statement rather than an entity save, because unfeaturing must clear the
     * curated rank in the same statement (see PostRepository#setFeatured) and the rank is a
     * read-only column on the entity. Featuring leaves the rank as it is. The entity is
     * reloaded afterwards so the response carries what the database now holds.
     */
    @Transactional
    public PostResponse setFeatured(UUID postId, boolean featured) {
        if (postRepository.setFeatured(postId, featured) == 0) {
            throw new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId);
        }
        return toResponse(getEntityById(postId));
    }

    /**
     * Replaces the whole "Featured posts" order: the i-th post in the list is featured with rank i; every other post
     * keeps its {@code featured} flag and only loses its rank. Never unfeatures any post: a re-run of the seed or an old
     * tab that does not know about a post the site owner just featured will only make that post lose its rank (it then
     * stands after the ranked posts), not vanish from "Featured posts". Unfeaturing stays a separate per-post action
     * ({@link #setFeatured}).
     *
     * One transaction: clears every rank then assigns 1..n in list order. An error at any post rolls the whole write
     * back, so the old order stays intact. Two overlapping writes (repeated click, two tabs saving two different lists)
     * are serialised by an advisory lock ({@link PostRepository#lockFeaturedOrder}): the later one waits for the earlier
     * to commit and then replaces everything, exactly "the last save wins", never a 409 or a rank left over from the
     * earlier one.
     *
     * @return every featured post, any status, in "Featured posts" order ({@link PostRepository#findAllFeaturedByRank})
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the list has duplicate ids; 400 {@code POST_NOT_FOUND} when
     *                      an id is not any post (the id is in the request body, not in the path, so it is a 400 rather
     *                      than a 404, like series members)
     */
    @Transactional
    public List<PostSummaryResponse> setFeaturedOrder(List<UUID> postIds) {
        if (new HashSet<>(postIds).size() < postIds.size()) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "postIds must not contain duplicates");
        }
        postRepository.lockFeaturedOrder();
        postRepository.clearFeaturedRanks();
        for (int i = 0; i < postIds.size(); i++) {
            UUID postId = postIds.get(i);
            // Checked by the number of rows the UPDATE touches instead of a lookup first, like
            // SeriesService.setPosts: no gap between the lookup and the write, and no extra query.
            if (postRepository.rankAsFeatured(postId, i + 1) == 0) {
                throw new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.BAD_REQUEST, "Post not found: " + postId);
            }
        }
        // The UPDATE statements above cleared the persistence context, so the posts are reloaded with the new ranks.
        return toSummaries(postCardRepository.findAllFeaturedByRank());
    }

    /**
     * Ranked full-text search over published posts, with optional filters that all combine with AND, several tags
     * included ({@link PostRepository.Search}).
     *
     * A blank query with no filter short-circuits to an empty page rather than reaching the database.
     * `plainto_tsquery('vi_unaccent', '')` is a valid empty tsquery that matches nothing, so the
     * query would answer correctly anyway — but it would also cost a round trip per empty
     * keystroke from a search box, and "no query" is not the same event as "no results".
     *
     * A malformed slug is also an empty page with no SQL run: it cannot match any stored slug, and a NUL in it once
     * reached Postgres and became a 409. A repeated {@code category} parameter arrives here as "a,b", which is malformed,
     * so no post matches.
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when {@code q} is longer than 200 characters after sanitising, or
     *                      there are more than 5 distinct tags
     */
    public Page<PostSummaryResponse> search(
            String query, String category, List<String> tags, String series, int page, int size) {
        return search(query, category, tags, series, page, size, null);
    }

    /** {@link #search} restricted to posts of one language; null means every language. */
    public Page<PostSummaryResponse> search(
            String query, String category, List<String> tags, String series, int page, int size, String language) {
        Pageable pageable = PageRequest.of(clampPage(page), clampSize(size, MAX_PAGE_SIZE));
        String text = SearchLimits.query(query);
        List<String> tagSlugs = SearchLimits.tagFilters(tags);
        String categorySlug = SearchLimits.slugFilter(category);
        String seriesSlug = SearchLimits.slugFilter(series);
        if (text.isEmpty() && categorySlug == null && seriesSlug == null && tagSlugs.isEmpty()) {
            return Page.empty(pageable);
        }
        if (!SearchLimits.isSlugOrAbsent(categorySlug)
                || !SearchLimits.isSlugOrAbsent(seriesSlug)
                || !tagSlugs.stream().allMatch(SearchLimits::isSlug)) {
            return Page.empty(pageable);
        }
        return toSummaryPage(findPublished(
                new PostRepository.Search(text.isEmpty() ? null : text, categorySlug, seriesSlug, tagSlugs, language),
                pageable));
    }

    /**
     * The page statement, then the count statement only when needed: exactly how Spring Data runs a
     * native query with a Pageable.
     */
    private Page<PostCard> findPublished(PostRepository.Search search, Pageable pageable) {
        @SuppressWarnings("unchecked")
        List<PostCard> content = search.bind(entityManager.createNativeQuery(search.sql(), PostCard.class))
                .setFirstResult(Math.toIntExact(pageable.getOffset()))
                .setMaxResults(pageable.getPageSize())
                .getResultList();
        return PageableExecutionUtils.getPage(
                content,
                pageable,
                () -> ((Number) search.bind(entityManager.createNativeQuery(search.countSql()))
                                .getSingleResult())
                        .longValue());
    }

    Post getEntityById(UUID postId) {
        return postRepository
                .findById(postId)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId));
    }

    /**
     * The public post list in one of two orders ({@code GET /api/v1/posts?sort=}): {@code latest} newest first, with the
     * filters as before; {@code popular} most viewed first ({@link #listPopular}).
     *
     * {@code popular} does not combine with filters: it is the site-wide "most read" block, and a ranking inside a
     * category needs a different query that nobody uses yet. Rejected instead of silently dropping the filter: dropping
     * it would give the caller posts outside the category it asked for without telling it. Only what really filters is
     * rejected, exactly as in latest: {@code featured=false} and an empty string filter nothing there, so they are not
     * blocked here either.
     *
     * @param authorSlug public handle of the writer, filtered like category and tag
     * @throws ApiException 400 {@code VALIDATION_ERROR} when {@code sort} is neither latest nor popular, or when
     *                      popular comes with a filter
     */
    public Page<PostSummaryResponse> listPublished(
            int page, int size, String categorySlug, String tagSlug, Boolean featured, String authorSlug, String sort) {
        return listPublished(page, size, categorySlug, tagSlug, featured, authorSlug, sort, null);
    }

    /** The same list restricted to one language; null means every language. */
    public Page<PostSummaryResponse> listPublished(
            int page,
            int size,
            String categorySlug,
            String tagSlug,
            Boolean featured,
            String authorSlug,
            String sort,
            String language) {
        if (SORT_LATEST.equals(sort)) {
            return listLatest(page, size, categorySlug, tagSlug, featured, authorSlug, language);
        }
        if (!SORT_POPULAR.equals(sort)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "sort must be '" + SORT_LATEST + "' or '" + SORT_POPULAR + "'");
        }
        if (SearchLimits.isFilter(categorySlug)
                || SearchLimits.isFilter(tagSlug)
                || SearchLimits.isFilter(authorSlug)
                || Boolean.TRUE.equals(featured)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "sort=" + SORT_POPULAR + " cannot be combined with filters");
        }
        return listPopular(page, size, language);
    }

    /**
     * Every published post, most viewed first; on equal views the later-published post first
     * ({@link PostRepository#findPopularPublished}). The views in the DTO are exactly the figure it was sorted by.
     */
    public Page<PostSummaryResponse> listPopular(int page, int size) {
        return listPopular(page, size, null);
    }

    /** {@link #listPopular(int, int)} restricted to one language; null means every language. */
    public Page<PostSummaryResponse> listPopular(int page, int size, String language) {
        // An unsorted Pageable: the order lives in the native SQL, like search.
        Pageable pageable = PageRequest.of(clampPage(page), clampSize(size, MAX_PAGE_SIZE));
        return toSummaryPage(
                language == null
                        ? postCardRepository.findPopularPublished(pageable)
                        : postCardRepository.findPopularPublishedInLanguage(language, pageable));
    }

    public Page<PostSummaryResponse> listPublished(
            int page, int size, String categorySlug, String tagSlug, Boolean featured, String authorSlug) {
        return listLatest(page, size, categorySlug, tagSlug, featured, authorSlug, null);
    }

    /**
     * The latest-first list restricted to one language (null means every language). Not another {@code listPublished}
     * overload: with a trailing language it would have the same parameters as the one that takes a sort.
     */
    public Page<PostSummaryResponse> listLatest(
            int page,
            int size,
            String categorySlug,
            String tagSlug,
            Boolean featured,
            String authorSlug,
            String language) {
        // Only "Featured posts" (?featured=true) follow the rank the site owner set; a featured post without a rank
        // stands
        // after them, newest first. Every other list, including ?featured=false, is still newest first.
        Sort sort = Boolean.TRUE.equals(featured)
                ? Sort.by(Sort.Order.asc("featuredRank").nullsLast(), Sort.Order.desc("publishedAt"))
                : Sort.by(Sort.Direction.DESC, "publishedAt");
        Pageable pageable = PageRequest.of(clampPage(page), clampSize(size, MAX_PAGE_SIZE), sort);

        // The same slug checks as search: a malformed slug matches no post, and never reaches the DB.
        String category = SearchLimits.slugFilter(categorySlug);
        String tag = SearchLimits.slugFilter(tagSlug);
        String author = SearchLimits.slugFilter(authorSlug);
        if (!SearchLimits.isSlugOrAbsent(category)
                || !SearchLimits.isSlugOrAbsent(tag)
                || (author != null && !PublicSlugs.isWellFormed(author))) {
            return Page.empty(pageable);
        }
        Specification<PostCard> spec = Specification.where(PostSpecifications.hasStatus(PostStatus.PUBLISHED));
        if (language != null) {
            spec = spec.and(PostSpecifications.hasLanguage(language));
        }
        if (category != null) {
            spec = spec.and(PostSpecifications.inCategorySlug(category));
        }
        if (tag != null) {
            spec = spec.and(PostSpecifications.hasTagSlug(tag));
        }
        if (author != null) {
            spec = spec.and(PostSpecifications.authoredByPublicSlug(author));
        }
        // Boolean, not boolean: absent and false are different requests. Absent means "every
        // published post"; false would mean "only the ones that are not featured", which no
        // caller wants but which a primitive default of false would silently deliver.
        if (Boolean.TRUE.equals(featured)) {
            spec = spec.and(PostSpecifications.isFeatured());
        }

        return toSummaryPage(postCardRepository.findAll(spec, pageable));
    }

    /**
     * Admin listing over every status (DRAFT, PUBLISHED, ARCHIVED). Sorted by
     * createdAt rather than publishedAt: drafts have no publishedAt, and an
     * admin list is about recency of work, not publication.
     */
    /**
     * The admin listing over every status (DRAFT, PUBLISHED, ARCHIVED).
     *
     * {@code authorScope} null means "every author", which only an ADMIN is given; an AUTHOR
     * is scoped to its own id. The scope is a parameter rather than something read from the
     * security context here so that this method stays unit-testable and so the one place that
     * decides who may see everything is the controller, next to the role check it mirrors.
     *
     * Note the filter is applied as a specification rather than by filtering the page
     * afterwards. Post-filtering a page would leave the pagination metadata describing the
     * unfiltered set — the author would be told there were five pages of its own posts when
     * four of them belong to someone else.
     */
    public Page<PostSummaryResponse> listAll(int page, int size, UUID authorScope) {
        Pageable pageable = PageRequest.of(
                clampPage(page), clampSize(size, MAX_PAGE_SIZE), Sort.by(Sort.Direction.DESC, "createdAt"));

        if (authorScope == null) {
            return toSummaryPage(postCardRepository.findAll(pageable));
        }
        // An AUTHOR does not see a post they deleted; an ADMIN does, as ARCHIVED, and can delete it for good.
        return toSummaryPage(postCardRepository.findAll(
                PostSpecifications.<PostCard>authoredBy(authorScope).and(PostSpecifications.notDeleted()), pageable));
    }

    public PostResponse getPublishedBySlug(String slug) {
        Post post = postRepository
                .findBySlug(slug)
                .filter(p -> p.getStatus() == PostStatus.PUBLISHED)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + slug));
        return toResponse(post);
    }

    /**
     * Where an old slug lives now: the current slug of the published post that once held {@code slug}, one hop however
     * many times the post changed it ({@link PostRepository#findPublishedSlugByOldSlug}).
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND} when {@code slug} is not the old slug of any published post: an
     *                      unknown slug, a post's current slug, or a post that is a draft, unpublished, archived or
     *                      deleted. The same code as {@code GET /api/v1/posts/{slug}}, so the asker cannot tell a draft
     *                      from an unknown slug.
     */
    public PostRedirectResponse findRedirect(String slug) {
        return postRepository
                .findPublishedSlugByOldSlug(slug)
                .map(PostRedirectResponse::new)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.POST_NOT_FOUND,
                        HttpStatus.NOT_FOUND,
                        "No published post has moved from slug: " + slug));
    }

    // --- Read model: views and "Part n/m" in batches ----------------------------------------------------

    /**
     * Summary DTOs for a batch of posts, keeping the input order. The cover and series come with the entity (LAZY
     * relations, which Hibernate loads in batches thanks to default_batch_fetch_size); views and "Part n/m" are exactly
     * one query each for the whole batch, not one query per post.
     *
     * Public because the series detail page also returns a list of posts with their part numbers. Must be called inside
     * a transaction: open-in-view is off, so outside a transaction the LAZY relations cannot be loaded.
     */
    public List<PostSummaryResponse> toSummaries(List<? extends PostHead> posts) {
        ReadModel model = readModelOf(posts);
        return posts.stream()
                .map(post ->
                        PostMapper.toSummary(post, model.viewCount(post), model.part(post), model.translations(post)))
                .toList();
    }

    private Page<PostSummaryResponse> toSummaryPage(Page<? extends PostHead> page) {
        ReadModel model = readModelOf(page.getContent());
        return page.map(
                post -> PostMapper.toSummary(post, model.viewCount(post), model.part(post), model.translations(post)));
    }

    private PostResponse toResponse(Post post) {
        ReadModel model = readModelOf(List.of(post));
        return PostMapper.toResponse(post, model.viewCount(post), model.part(post), model.translations(post));
    }

    /**
     * The DTO of a post just edited (PUT, publish, unpublish, restore), after the write has reached the DB. Flushes
     * before mapping, instead of leaving it to Hibernate at commit: the view-count read in {@link #readModelOf} triggers
     * an auto-flush probe, which calls {@code @PreUpdate} (updatedAt = that moment) and then discards it, because the
     * post_views table does not touch the posts table; the flush at commit calls it again and writes a different
     * instant. The response would then carry an updatedAt that was never in the DB (measured: off by a few ms). Flushing
     * here makes {@code @PreUpdate} run exactly once, and the response carries exactly the stored value.
     */
    private PostResponse saved(Post post) {
        return toResponse(postRepository.saveAndFlush(post));
    }

    private ReadModel readModelOf(List<? extends PostHead> posts) {
        if (posts.isEmpty()) {
            return ReadModel.EMPTY;
        }
        Map<UUID, Long> views =
                postViewRepository
                        .findAllByPostIdIn(posts.stream().map(PostHead::getId).toList())
                        .stream()
                        .collect(Collectors.toMap(PostView::getPostId, PostView::getViewCount));
        Map<UUID, List<TranslationRow>> siblings = publishedTranslationsByGroup(posts);

        // Only the series of PUBLISHED posts: an unpublished post has no part number, so a page with only drafts of a
        // series does not need to ask the DB. getSeries().getId() reads the id from the proxy, without loading the
        // series.
        Set<UUID> seriesIds = posts.stream()
                .filter(post -> post.getStatus() == PostStatus.PUBLISHED && post.getSeries() != null)
                .map(post -> post.getSeries().getId())
                .collect(Collectors.toSet());
        if (seriesIds.isEmpty()) {
            return new ReadModel(views, Map.of(), siblings);
        }
        // Part numbers are counted in the DB, so state just changed in this transaction (publish, unpublish) must reach
        // the
        // DB first. Hibernate does that itself: in a transaction with FlushMode AUTO and a JPA-style bootstrap (like
        // Spring
        // Boot), it flushes the whole session before any native query (NativeQueryImpl.prepareForExecution).
        // PostReadModelIT
        // pins that: the response of the publish itself already carries the new part numbers.
        Map<UUID, PartInfo> parts = postRepository.findPartNumbers(seriesIds).stream()
                .collect(Collectors.toMap(
                        PartNumberRow::getPostId, row -> new PartInfo(row.getPartNumber(), row.getPartCount())));
        return new ReadModel(views, parts, siblings);
    }

    /**
     * The published members of the translation groups on this page: one query, none when no post of the page is linked. Rows
     * of draft or unpublished posts are not selected, so a response can never name one.
     */
    private Map<UUID, List<TranslationRow>> publishedTranslationsByGroup(List<? extends PostHead> posts) {
        Set<UUID> groupIds = posts.stream()
                .map(PostHead::getTranslationGroupId)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
        if (groupIds.isEmpty()) {
            return Map.of();
        }
        return postRepository.findPublishedTranslations(groupIds).stream()
                .collect(Collectors.groupingBy(TranslationRow::getGroupId));
    }

    /** Missing from the map means 0 views and no part number (not in a series, or not published). */
    private record ReadModel(
            Map<UUID, Long> views, Map<UUID, PartInfo> parts, Map<UUID, List<TranslationRow>> siblings) {

        static final ReadModel EMPTY = new ReadModel(Map.of(), Map.of(), Map.of());

        long viewCount(PostHead post) {
            return views.getOrDefault(post.getId(), 0L);
        }

        PartInfo part(PostHead post) {
            return parts.getOrDefault(post.getId(), PartInfo.NONE);
        }

        /** The other published posts of the same article; empty for an unlinked post. */
        List<PostTranslationResponse> translations(PostHead post) {
            if (post.getTranslationGroupId() == null) {
                return List.of();
            }
            return siblings.getOrDefault(post.getTranslationGroupId(), List.of()).stream()
                    .filter(row -> !row.getPostId().equals(post.getId()))
                    .map(row -> new PostTranslationResponse(
                            row.getLanguage(), row.getSlug(), row.getTitle(), PostStatus.PUBLISHED.name()))
                    .toList();
        }
    }

    private Category resolveCategory(UUID categoryId) {
        if (categoryId == null) {
            return null;
        }
        return categoryRepository
                .findById(categoryId)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.CATEGORY_NOT_FOUND, HttpStatus.BAD_REQUEST, "Category not found: " + categoryId));
    }

    private Set<Tag> resolveTags(Set<UUID> tagIds) {
        if (tagIds == null || tagIds.isEmpty()) {
            return new HashSet<>();
        }
        Set<Tag> resolved = new HashSet<>(tagRepository.findAllByIdIn(tagIds));
        if (resolved.size() < tagIds.size()) {
            throw new ApiException(ErrorCode.TAG_NOT_FOUND, HttpStatus.BAD_REQUEST, "One or more tags not found");
        }
        return resolved;
    }
}
