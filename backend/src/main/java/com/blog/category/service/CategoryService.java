package com.blog.category.service;

import com.blog.category.dto.CategoryMergeResponse;
import com.blog.category.dto.CategoryRequest;
import com.blog.category.dto.CategoryResponse;
import com.blog.category.entity.Category;
import com.blog.category.repository.CategoryRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.LocalizedText;
import com.blog.common.i18n.TaxonomyTranslations;
import com.blog.common.quota.AuthorQuotaProperties;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.text.UserText;
import com.blog.common.util.SlugGenerator;
import com.blog.search.index.DocType;
import com.blog.search.sync.SearchOutbox;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class CategoryService {

    private final CategoryRepository categoryRepository;
    private final SearchOutbox searchOutbox;
    private final TaxonomyTranslations taxonomyTranslations;
    private final RateLimiter rateLimiter;
    private final AuthorQuotaProperties authorQuota;

    /**
     * Creates a category for a caller who is an ADMIN or an AUTHOR. An AUTHOR is limited: {@code app.rate-limit.taxonomy-create}
     * creations an hour (429 {@code RATE_LIMITED}) and a catalog of at most {@code app.author-quota.max-categories} (422
     * {@code AUTHOR_QUOTA_EXCEEDED}), because the public lists read every category whole. An ADMIN is exempt.
     *
     * @param creator the account creating the category, from the token
     * @param admin   whether that account is an ADMIN
     */
    @Transactional
    public CategoryResponse create(CategoryRequest request, UUID creator, boolean admin) {
        if (!admin) {
            rateLimiter.check(RateLimiter.TAXONOMY_CREATE, creator);
            if (categoryRepository.count() >= authorQuota.maxCategories()) {
                throw new ApiException(
                        ErrorCode.AUTHOR_QUOTA_EXCEEDED,
                        HttpStatus.UNPROCESSABLE_CONTENT,
                        "The category list is full (" + authorQuota.maxCategories() + "); ask an administrator");
            }
        }
        return create(request);
    }

    /** Creates a category with no limit: only for a caller that is an ADMIN (sample content), or one that already counted the caller's limits. */
    @Transactional
    public CategoryResponse create(CategoryRequest request) {
        String name = displayName(request.name());
        if (categoryRepository.existsByNameIgnoreCase(name)) {
            throw alreadyExists(name);
        }
        String baseSlug = SlugGenerator.slugify(name);
        String slug = SlugGenerator.ensureUnique(baseSlug, categoryRepository::existsBySlug);

        Category category = new Category();
        category.setName(name);
        category.setSlug(slug);
        category.setDescription(normalizeDescription(request.description()));
        if (request.translations() != null) {
            category.setTranslations(normalize(request));
        }
        Category saved = categoryRepository.save(category);
        searchOutbox.enqueue(DocType.CATEGORY, saved.getId());
        return toAdminResponse(saved);
    }

    /**
     * Every category by name, including ones with no posts or only drafts: the admin area, where the post
     * editor picks them.
     */
    public List<CategoryResponse> list() {
        return categoryRepository.findAllByOrderByNameAsc().stream()
                .map(CategoryService::toAdminResponse)
                .toList();
    }

    /**
     * Public list: only categories with at least one published post. A category with only drafts is the name of a
     * topic about to be written, not yet to be revealed; a category with no posts has nothing for the reader. Removing
     * the last post (or moving it to ARCHIVED) takes the category off the list.
     */
    public List<CategoryResponse> listPublic() {
        return listPublic(null);
    }

    /**
     * With a language: only categories with a published post in that language, named and described in it (fallback to
     * the base text), by localized name. Without one: as {@link #listPublic()}.
     */
    public List<CategoryResponse> listPublic(String language) {
        if (language == null) {
            return categoryRepository.findAllWithPublishedPosts().stream()
                    .map(category -> toResponse(category, null))
                    .toList();
        }
        return categoryRepository.findAllWithPublishedPostsIn(language).stream()
                .map(category -> toResponse(category, language))
                .sorted(Comparator.comparing(CategoryResponse::name, String.CASE_INSENSITIVE_ORDER))
                .toList();
    }

    /**
     * One category on the public side.
     *
     * @throws ApiException 404 {@code CATEGORY_NOT_FOUND} when no category has that slug, or the category has no
     *                      published post: to the reader it does not exist yet, and the answer is identical to the one
     *                      for an unknown slug
     */
    public CategoryResponse getPublicBySlug(String slug) {
        return getPublicBySlug(slug, null);
    }

    /** Visibility is "a published post in any language"; the language only localizes the text. */
    public CategoryResponse getPublicBySlug(String slug, String language) {
        return categoryRepository
                .findBySlugWithPublishedPosts(slug)
                .map(category -> toResponse(category, language))
                .orElseThrow(() -> notFound(slug));
    }

    /**
     * Replaces the whole name and description. The slug is kept, not regenerated from the name: it is the public URL
     * {@code /categories/{slug}}, and fixing a typo in the name must not break that URL.
     *
     * @throws ApiException 404 {@code CATEGORY_NOT_FOUND}; 409 {@code CATEGORY_ALREADY_EXISTS} when the name clashes
     *                      with a DIFFERENT category, case-insensitively (changing the case of its own name is fine)
     */
    @Transactional
    public CategoryResponse update(UUID id, CategoryRequest request) {
        Category category = lock(id);
        String name = displayName(request.name());
        if (categoryRepository.existsByNameIgnoreCaseAndIdNot(name, id)) {
            throw alreadyExists(name);
        }
        category.setName(name);
        category.setDescription(normalizeDescription(request.description()));
        if (request.translations() != null) {
            category.setTranslations(normalize(request));
        }
        // The post documents carry the category name.
        searchOutbox.enqueue(DocType.CATEGORY, id);
        searchOutbox.publishedPostsInCategory(id);
        return toAdminResponse(category);
    }

    /**
     * Deletes a category no post uses any more. Does not detach the category from posts the way deleting a series does:
     * a published post must have a category (PostService.publish), and where posts move to is the site owner's call, not
     * a side effect of a delete button. The foreign key {@code posts.category_id} has no ON DELETE, so the DB enforces
     * that too.
     *
     * Counts and deletes under the FOR UPDATE lock on the category row ({@link CategoryRepository#findByIdForUpdate}): a
     * post assigned at that very moment also becomes 409 {@code CATEGORY_IN_USE}, instead of slipping past the count and
     * then tripping over the foreign key at commit.
     *
     * @throws ApiException 404 {@code CATEGORY_NOT_FOUND}, including when another delete has just removed it;
     *                      409 {@code CATEGORY_IN_USE} while any post uses it, in any status
     */
    @Transactional
    public void delete(UUID id) {
        Category category = lock(id);
        long posts = categoryRepository.countPosts(id);
        if (posts > 0) {
            throw new ApiException(
                    ErrorCode.CATEGORY_IN_USE,
                    HttpStatus.CONFLICT,
                    "Category '" + category.getName() + "' is used by " + posts + (posts == 1 ? " post" : " posts"));
        }
        searchOutbox.enqueue(DocType.CATEGORY, id);
        categoryRepository.delete(category);
    }

    /**
     * Merges category {@code sourceId} into category {@code targetId}, i.e. "move the posts, then delete": every post of
     * the source category, any status including drafts, goes to the target category, then the source category (now
     * empty) is deleted. No post changes {@code updated_at}, status or publish date. The source category's slug (URL
     * {@code /categories/{slug}}) becomes 404 like any deleted category.
     *
     * One transaction, under the FOR UPDATE lock on both categories taken in id order
     * ({@link CategoryRepository#findAllByIdForUpdate}): there is no gap between the move and the delete for a post to
     * slip into the source category.
     *
     * @return the target category, and the number of posts moved
     * @throws ApiException 400 {@code VALIDATION_ERROR} when merging a category into itself; 404
     *                      {@code CATEGORY_NOT_FOUND} when the source category (in the path) does not exist, including
     *                      when another merge has just deleted it; 400 {@code CATEGORY_NOT_FOUND} when the target
     *                      category (in the request body) does not exist
     */
    @Transactional
    public CategoryMergeResponse merge(UUID sourceId, UUID targetId) {
        if (sourceId.equals(targetId)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "targetId must be another category than the one being merged");
        }
        Map<UUID, Category> locked = categoryRepository.findAllByIdForUpdate(List.of(sourceId, targetId)).stream()
                .collect(Collectors.toMap(Category::getId, Function.identity()));
        Category source = locked.get(sourceId);
        if (source == null) {
            throw notFound(sourceId.toString());
        }
        Category target = locked.get(targetId);
        if (target == null) {
            throw new ApiException(
                    ErrorCode.CATEGORY_NOT_FOUND, HttpStatus.BAD_REQUEST, "Category not found: " + targetId);
        }
        // Before the move: the source category's posts can still be found through it.
        searchOutbox.publishedPostsInCategory(sourceId);
        searchOutbox.enqueue(DocType.CATEGORY, List.of(sourceId, targetId));
        int moved = categoryRepository.movePosts(sourceId, targetId);
        categoryRepository.delete(source);
        return new CategoryMergeResponse(toAdminResponse(target), moved);
    }

    private Map<String, LocalizedText> normalize(CategoryRequest request) {
        return taxonomyTranslations.normalize(request.translations(), 255, Integer.MAX_VALUE);
    }

    /** The public shape: localized when a language is given, never with the raw translations. */
    private static CategoryResponse toResponse(Category category, String language) {
        return new CategoryResponse(
                category.getId(),
                LocalizedText.name(category.getTranslations(), language, category.getName()),
                category.getSlug(),
                LocalizedText.description(category.getTranslations(), language, category.getDescription()));
    }

    private static CategoryResponse toAdminResponse(Category category) {
        return new CategoryResponse(
                category.getId(),
                category.getName(),
                category.getSlug(),
                category.getDescription(),
                category.getTranslations());
    }

    private Category lock(UUID id) {
        return categoryRepository.findByIdForUpdate(id).orElseThrow(() -> notFound(id.toString()));
    }

    /**
     * A blank description means no description: the UI hides an unfilled field, and "" would render as an
     * empty paragraph.
     */
    private static String normalizeDescription(String description) {
        if (description == null) {
            return null;
        }
        String cleaned = UserText.clean(description);
        return cleaned.isEmpty() ? null : cleaned;
    }

    /** One line without invisible or text-direction characters; a name with nothing visible left is refused (400). */
    private static String displayName(String raw) {
        String name = UserText.cleanName(raw);
        if (name.isEmpty()) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "name must contain visible text");
        }
        return name;
    }

    private static ApiException notFound(String idOrSlug) {
        return new ApiException(ErrorCode.CATEGORY_NOT_FOUND, HttpStatus.NOT_FOUND, "Category not found: " + idOrSlug);
    }

    private static ApiException alreadyExists(String name) {
        return new ApiException(
                ErrorCode.CATEGORY_ALREADY_EXISTS, HttpStatus.CONFLICT, "Category '" + name + "' already exists");
    }
}
