package com.blog.tag.service;

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
import com.blog.tag.dto.TagMergeResponse;
import com.blog.tag.dto.TagRequest;
import com.blog.tag.dto.TagResponse;
import com.blog.tag.entity.Tag;
import com.blog.tag.repository.TagRepository;
import java.util.Comparator;
import java.util.LinkedHashMap;
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
public class TagService {

    private final TagRepository tagRepository;
    private final SearchOutbox searchOutbox;
    private final TaxonomyTranslations taxonomyTranslations;
    private final RateLimiter rateLimiter;
    private final AuthorQuotaProperties authorQuota;

    /**
     * Creates a tag for a caller who is an ADMIN or an AUTHOR. An AUTHOR is limited: {@code app.rate-limit.taxonomy-create}
     * creations an hour (429 {@code RATE_LIMITED}) and a catalog of at most {@code app.author-quota.max-tags} tags (422
     * {@code AUTHOR_QUOTA_EXCEEDED}), because the public lists read every tag whole. An ADMIN is exempt.
     *
     * @param creator the account creating the tag, from the token
     * @param admin   whether that account is an ADMIN
     */
    @Transactional
    public TagResponse create(TagRequest request, UUID creator, boolean admin) {
        if (!admin) {
            rateLimiter.check(RateLimiter.TAXONOMY_CREATE, creator);
            if (tagRepository.count() >= authorQuota.maxTags()) {
                throw new ApiException(
                        ErrorCode.AUTHOR_QUOTA_EXCEEDED,
                        HttpStatus.UNPROCESSABLE_CONTENT,
                        "The tag list is full (" + authorQuota.maxTags() + "); ask an administrator");
            }
        }
        return create(request);
    }

    /** Creates a tag with no limit: only for a caller that is an ADMIN (sample content), or one that already counted the caller's limits. */
    @Transactional
    public TagResponse create(TagRequest request) {
        String name = displayName(request.name());
        if (tagRepository.existsByNameIgnoreCase(name)) {
            throw alreadyExists(name);
        }
        String baseSlug = SlugGenerator.slugify(name);
        String slug = SlugGenerator.ensureUnique(baseSlug, tagRepository::existsBySlug);

        Tag tag = new Tag();
        tag.setName(name);
        tag.setSlug(slug);
        if (request.translations() != null) {
            tag.setTranslations(normalize(request));
        }
        Tag saved = tagRepository.save(tag);
        searchOutbox.enqueue(DocType.TAG, saved.getId());
        return toAdminResponse(saved);
    }

    /**
     * Every tag by name, including ones attached to no post or only to drafts: the admin area, where the
     * post editor picks them.
     */
    public List<TagResponse> list() {
        return tagRepository.findAllByOrderByNameAsc().stream()
                .map(TagService::toAdminResponse)
                .toList();
    }

    /**
     * Public list: only tags attached to at least one published post, like CategoryService#listPublic. Removing the last
     * post carrying the tag (or moving it to ARCHIVED) takes the tag off the list.
     */
    public List<TagResponse> listPublic() {
        return listPublic(null);
    }

    /**
     * With a language: only tags attached to a published post in that language, named in it (fallback to the base
     * name), by localized name. Without one: as {@link #listPublic()}.
     */
    public List<TagResponse> listPublic(String language) {
        if (language == null) {
            return tagRepository.findAllWithPublishedPosts().stream()
                    .map(tag -> toResponse(tag, null))
                    .toList();
        }
        return tagRepository.findAllWithPublishedPostsIn(language).stream()
                .map(tag -> toResponse(tag, language))
                .sorted(Comparator.comparing(TagResponse::name, String.CASE_INSENSITIVE_ORDER))
                .toList();
    }

    /**
     * One tag on the public side.
     *
     * @throws ApiException 404 {@code TAG_NOT_FOUND} when no tag has that slug, or the tag is attached to no published
     *                      post: the answer is identical to the one for an unknown slug
     */
    public TagResponse getPublicBySlug(String slug) {
        return getPublicBySlug(slug, null);
    }

    /** Visibility is "a published post in any language"; the language only localizes the name. */
    public TagResponse getPublicBySlug(String slug, String language) {
        return tagRepository
                .findBySlugWithPublishedPosts(slug)
                .map(tag -> toResponse(tag, language))
                .orElseThrow(() -> notFound(slug));
    }

    /**
     * Renames a tag. The slug is kept, not regenerated from the name: it is the public URL {@code /tags/{slug}}.
     *
     * @throws ApiException 404 {@code TAG_NOT_FOUND}; 409 {@code TAG_ALREADY_EXISTS} when the name clashes with a
     *                      DIFFERENT tag, case-insensitively (changing the case of its own name is fine)
     */
    @Transactional
    public TagResponse update(UUID id, TagRequest request) {
        Tag tag = lock(id);
        String name = displayName(request.name());
        if (tagRepository.existsByNameIgnoreCaseAndIdNot(name, id)) {
            throw alreadyExists(name);
        }
        tag.setName(name);
        if (request.translations() != null) {
            tag.setTranslations(normalize(request));
        }
        // The post documents carry the tag name.
        searchOutbox.enqueue(DocType.TAG, id);
        searchOutbox.publishedPostsWithTag(id);
        return toAdminResponse(tag);
    }

    /**
     * Deletes a tag. The tag leaves every post that carries it through the {@code ON DELETE CASCADE} of post_tags; the
     * posts stay intact, including {@code updated_at}: removing a site tag is an editorial act, not a post edit.
     *
     * @throws ApiException 404 {@code TAG_NOT_FOUND}, including when another delete has just removed it
     */
    @Transactional
    public void delete(UUID id) {
        Tag tag = lock(id);
        // Before the delete: the cascade takes post_tags with it, the only place that knows which posts carry the tag.
        searchOutbox.enqueue(DocType.TAG, id);
        searchOutbox.publishedPostsWithTag(id);
        tagRepository.delete(tag);
    }

    /**
     * Merges tag {@code sourceId} into tag {@code targetId}: every post carrying the source tag, any status, carries the
     * target tag (a post that has both keeps the target tag exactly once), then the source tag is deleted. No post
     * changes {@code updated_at}: merging tags is an editorial act, like deleting a tag. The source tag's slug (URL
     * {@code /tags/{slug}}) becomes 404 like any deleted tag.
     *
     * One transaction, under the FOR UPDATE lock on both tags taken in id order
     * ({@link TagRepository#findAllByIdForUpdate}): two merges in opposite directions do not lock crosswise, and a post
     * tagged with the source tag at that very moment does not slip through.
     *
     * @return the target tag, and the number of posts that carried the source tag
     * @throws ApiException 400 {@code VALIDATION_ERROR} when merging a tag into itself; 404 {@code TAG_NOT_FOUND} when
     *                      the source tag (in the path) does not exist, including when another merge has just deleted
     *                      it; 400 {@code TAG_NOT_FOUND} when the target tag (in the request body) does not exist
     */
    @Transactional
    public TagMergeResponse merge(UUID sourceId, UUID targetId) {
        if (sourceId.equals(targetId)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "targetId must be another tag than the one being merged");
        }
        Map<UUID, Tag> locked = tagRepository.findAllByIdForUpdate(List.of(sourceId, targetId)).stream()
                .collect(Collectors.toMap(Tag::getId, Function.identity()));
        Tag source = locked.get(sourceId);
        if (source == null) {
            throw notFound(sourceId.toString());
        }
        Tag target = locked.get(targetId);
        if (target == null) {
            throw new ApiException(ErrorCode.TAG_NOT_FOUND, HttpStatus.BAD_REQUEST, "Tag not found: " + targetId);
        }
        long moved = tagRepository.countPosts(sourceId);
        searchOutbox.publishedPostsWithTag(sourceId);
        searchOutbox.enqueue(DocType.TAG, List.of(sourceId, targetId));
        tagRepository.copyPosts(sourceId, targetId);
        // The source tag's remaining post_tags rows go with it through ON DELETE CASCADE, as when deleting a tag.
        tagRepository.delete(source);
        return new TagMergeResponse(toAdminResponse(target), moved);
    }

    /** Tags have a name only: a translated description is dropped. */
    private Map<String, LocalizedText> normalize(TagRequest request) {
        Map<String, LocalizedText> names = new LinkedHashMap<>();
        taxonomyTranslations
                .normalize(request.translations(), 100, Integer.MAX_VALUE)
                .forEach((language, text) -> {
                    if (text.name() != null) {
                        names.put(language, new LocalizedText(text.name(), null));
                    }
                });
        return names;
    }

    /** The public shape: localized when a language is given, never with the raw translations. */
    private static TagResponse toResponse(Tag tag, String language) {
        return new TagResponse(
                tag.getId(), LocalizedText.name(tag.getTranslations(), language, tag.getName()), tag.getSlug());
    }

    private static TagResponse toAdminResponse(Tag tag) {
        return new TagResponse(tag.getId(), tag.getName(), tag.getSlug(), tag.getTranslations());
    }

    private Tag lock(UUID id) {
        return tagRepository.findByIdForUpdate(id).orElseThrow(() -> notFound(id.toString()));
    }

    private static ApiException notFound(String idOrSlug) {
        return new ApiException(ErrorCode.TAG_NOT_FOUND, HttpStatus.NOT_FOUND, "Tag not found: " + idOrSlug);
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

    private static ApiException alreadyExists(String name) {
        return new ApiException(ErrorCode.TAG_ALREADY_EXISTS, HttpStatus.CONFLICT, "Tag '" + name + "' already exists");
    }
}
