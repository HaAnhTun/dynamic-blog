package com.blog.post.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.util.SlugGenerator;
import com.blog.post.dto.AdminPostTranslationResponse;
import com.blog.post.dto.PostResponse;
import com.blog.post.dto.PostTranslationCreateRequest;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostStatus;
import com.blog.post.repository.PostRepository;
import com.blog.search.index.DocType;
import com.blog.search.sync.SearchOutbox;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The translation groups of posts: posts that share a {@code translation_group_id} are the languages of one article.
 * Who may do what is decided in the controller ({@code CAN_MANAGE}, and both posts for a link); this class keeps the
 * data consistent.
 *
 * Every write runs in one transaction under row locks: first the members of the groups involved, in id order, then the
 * posts named by the request, in id order. A group never keeps a single member: the last one is released.
 */
@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class PostTranslationService {

    private final PostRepository postRepository;
    private final PostService postService;
    private final SearchOutbox searchOutbox;
    private final Languages languages;

    /**
     * The other posts of the group that the caller may see: an ADMIN sees every status; anyone else sees the published
     * ones and their own posts, never another author's draft.
     */
    public List<AdminPostTranslationResponse> list(UUID postId, UUID caller, boolean admin) {
        Post post = postService.getEntityById(postId);
        if (post.getTranslationGroupId() == null) {
            return List.of();
        }
        return postRepository.findByTranslationGroupId(post.getTranslationGroupId()).stream()
                .filter(sibling -> !sibling.getId().equals(postId))
                .filter(sibling -> admin
                        || sibling.getStatus() == PostStatus.PUBLISHED
                        || sibling.getAuthor().getId().equals(caller))
                .map(sibling -> new AdminPostTranslationResponse(
                        sibling.getId(),
                        sibling.getLanguage(),
                        sibling.getSlug(),
                        sibling.getTitle(),
                        sibling.getStatus().name()))
                .toList();
    }

    /**
     * A new draft of the post in another language, in the same group (a group is created when the post had none). It
     * copies the title, excerpt, category, tags and series membership (at the end of the series), with empty content; the
     * cover is not copied. The author stays the author of the source post.
     *
     * A draft is a post created: an AUTHOR is held to the same limits as in the editor ({@link
     * PostService#requireAuthorMayCreatePost}: the write rate and the posts per day), so creating, unlinking and creating
     * again cannot add posts without end. An ADMIN is exempt.
     *
     * @throws ApiException 400 for an unknown language; 409 {@code TRANSLATION_CONFLICT} when the post or its group
     *                      already has the language; 409 {@code RESOURCE_CONFLICT} when the requested slug is taken;
     *                      429 {@code RATE_LIMITED} or {@code AUTHOR_QUOTA_EXCEEDED} for an AUTHOR over a limit
     */
    @Transactional
    public PostResponse createDraft(UUID sourceId, PostTranslationCreateRequest request, UUID caller, boolean admin) {
        String language = languages.require(request.language());
        if (!admin) {
            // Before the global lock of translation writes: a refused request must not queue behind it.
            postService.requireAuthorMayCreatePost(caller);
        }
        postRepository.lockTranslationWrites();
        Post source = lockPosts(sourceId).get(sourceId);
        UUID group = source.getTranslationGroupId();
        requireOwnGroup(group, caller, admin);
        if (language.equals(source.getLanguage())
                || (group != null && postRepository.existsInTranslationGroup(group, language, sourceId))) {
            throw conflict("This article already has a translation in the language " + language);
        }

        Post draft = new Post();
        draft.setTitle(source.getTitle());
        draft.setExcerpt(source.getExcerpt());
        draft.setContent("");
        draft.setStatus(PostStatus.DRAFT);
        draft.setLanguage(language);
        draft.setAuthor(source.getAuthor());
        draft.setCategory(source.getCategory());
        draft.setTags(new HashSet<>(source.getTags()));
        draft.setSlug(draftSlug(request.slug(), source.getSlug(), language));
        // Read before the statements below: they clear the persistence context.
        UUID seriesId = source.getSeries() == null ? null : source.getSeries().getId();

        UUID draftId = postRepository.save(draft).getId();
        UUID target = group != null ? group : UUID.randomUUID();
        if (group == null) {
            postRepository.setTranslationGroup(sourceId, target);
        }
        postRepository.setTranslationGroup(draftId, target);
        // Series membership is an ADMIN decision (SeriesService); an AUTHOR's translation draft does not join the
        // series.
        if (seriesId != null && admin) {
            postRepository.lockSeries(seriesId);
            postRepository.assignToSeries(draftId, seriesId, postRepository.nextSeriesPosition(seriesId));
        }
        searchOutbox.enqueue(DocType.POST, List.of(sourceId, draftId));
        return postService.getById(draftId);
    }

    /**
     * Makes {@code otherId} a translation of {@code postId}. Idempotent when they already share a group.
     *
     * @throws ApiException 400 when both ids are the same; 404 {@code POST_NOT_FOUND}; 409 {@code TRANSLATION_CONFLICT}
     *                      when both have the same language, both belong to different groups, or the group of one
     *                      already has the language of the other
     */
    @Transactional
    public PostResponse link(UUID postId, UUID otherId, UUID caller, boolean admin) {
        if (postId.equals(otherId)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "A post cannot be a translation of itself");
        }
        postRepository.lockTranslationWrites();
        Map<UUID, Post> locked = lockPosts(postId, otherId);
        Post post = locked.get(postId);
        Post other = locked.get(otherId);
        UUID postGroup = post.getTranslationGroupId();
        UUID otherGroup = other.getTranslationGroupId();
        requireOwnGroup(postGroup, caller, admin);
        requireOwnGroup(otherGroup, caller, admin);

        if (postGroup != null && postGroup.equals(otherGroup)) {
            return postService.getById(postId);
        }
        if (post.getLanguage().equals(other.getLanguage())) {
            throw conflict("Both posts are in the language " + post.getLanguage());
        }
        if (postGroup != null && otherGroup != null) {
            throw conflict("Both posts already belong to a different set of translations");
        }
        if (postGroup != null) {
            join(other, postGroup);
        } else if (otherGroup != null) {
            join(post, otherGroup);
        } else {
            UUID group = UUID.randomUUID();
            postRepository.setTranslationGroup(postId, group);
            postRepository.setTranslationGroup(otherId, group);
        }
        searchOutbox.enqueue(DocType.POST, List.of(postId, otherId));
        return postService.getById(postId);
    }

    /** Removes the post from its group; a group left with one post is dissolved. Nothing happens for a post with no group. */
    @Transactional
    public void unlink(UUID postId, UUID caller, boolean admin) {
        postRepository.lockTranslationWrites();
        Post post = lockPosts(postId).get(postId);
        UUID group = post.getTranslationGroupId();
        if (group == null) {
            return;
        }
        requireOwnGroup(group, caller, admin);
        List<UUID> members = postRepository.lockTranslationGroup(group);
        postRepository.clearTranslationGroup(postId);
        postRepository.dissolveSingleMemberGroup(group);
        searchOutbox.enqueue(DocType.POST, members);
    }

    /**
     * An AUTHOR may only change a group whose posts are all their own: a group that an ADMIN made from posts of several people
     * is the admin's to change, so nobody can attach to, or detach from, someone else's article.
     *
     * @throws ApiException 403 {@code FORBIDDEN}
     */
    private void requireOwnGroup(UUID group, UUID caller, boolean admin) {
        if (admin || group == null) {
            return;
        }
        boolean foreign = postRepository.findByTranslationGroupId(group).stream()
                .anyMatch(member -> !member.getAuthor().getId().equals(caller));
        if (foreign) {
            throw new ApiException(
                    ErrorCode.FORBIDDEN, HttpStatus.FORBIDDEN, "These translations include posts of another author");
        }
    }

    private void join(Post joining, UUID group) {
        if (postRepository.existsInTranslationGroup(group, joining.getLanguage(), joining.getId())) {
            throw conflict("The other translations already use the language " + joining.getLanguage());
        }
        postRepository.setTranslationGroup(joining.getId(), group);
    }

    /**
     * The slug of a new draft: the requested one as it is (409 when taken, in posts or in the history of an old slug), or
     * the source slug with the language, made unique.
     */
    private String draftSlug(String requested, String sourceSlug, String language) {
        String slug = requested == null ? "" : SlugGenerator.slugifyOrEmpty(requested);
        if (slug.isEmpty()) {
            return SlugGenerator.ensureUnique(sourceSlug + "-" + language, this::slugTaken);
        }
        if (slugTaken(slug)) {
            throw new ApiException(
                    ErrorCode.RESOURCE_CONFLICT, HttpStatus.CONFLICT, "The slug is already taken: " + slug);
        }
        return slug;
    }

    private boolean slugTaken(String slug) {
        // Posts first, then the history: see PostService.create.
        return postRepository.existsBySlug(slug) || postRepository.existsInSlugHistory(slug);
    }

    /**
     * Row locks on the members of the groups the posts belong to, then on the posts, each in id order. The posts are
     * loaded only after their locks are held, so what the caller reads is what is in the DB now.
     */
    private Map<UUID, Post> lockPosts(UUID... ids) {
        Set<UUID> groups = new TreeSet<>();
        for (UUID id : ids) {
            UUID group = postRepository.findTranslationGroupId(id);
            if (group != null) {
                groups.add(group);
            }
        }
        groups.forEach(postRepository::lockTranslationGroup);
        Map<UUID, Post> locked = new LinkedHashMap<>();
        for (UUID id : new TreeSet<>(Arrays.asList(ids))) {
            locked.put(
                    id,
                    postRepository
                            .findByIdForUpdate(id)
                            .orElseThrow(() -> new ApiException(
                                    ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + id)));
        }
        return locked;
    }

    private static ApiException conflict(String message) {
        return new ApiException(ErrorCode.TRANSLATION_CONFLICT, HttpStatus.CONFLICT, message);
    }
}
