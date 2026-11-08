package com.blog.post.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.common.response.PageMeta;
import com.blog.common.response.PagedResponse;
import com.blog.post.dto.CoverAltTextRequest;
import com.blog.post.dto.FeaturedOrderRequest;
import com.blog.post.dto.PostCreateRequest;
import com.blog.post.dto.PostResponse;
import com.blog.post.dto.PostSummaryResponse;
import com.blog.post.dto.PostUpdateRequest;
import com.blog.post.service.PostCoverService;
import com.blog.post.service.PostService;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * Every method that names an existing post carries the same rule:
 *
 * <pre>hasRole('ADMIN') or &#64;postAccess.isOwner(#id)</pre>
 *
 * ADMIN manages every post; AUTHOR manages only its own. The filter chain has already
 * established that the caller holds one of the two roles before any of this runs, so the
 * expression's job is purely the ownership half.
 *
 * Three consequences worth stating, because each is a decision rather than a side effect:
 *
 * <ul>
 *   <li><b>{@code delete} is no longer ADMIN-only.</b> It was, and the rule now reads the way
 *       the product requires: an AUTHOR may delete a post it wrote, and may not touch anyone
 *       else's. The previous rule refused an author their own draft. An AUTHOR's delete only hides
 *       the post (V49): the rows of other people that hang on it are kept; an ADMIN deletes for good.</li>
 *   <li><b>{@code getById} is gated too</b>, not only the writes. It returns the full body of a
 *       post whatever its status, so leaving it open would let one author read another's
 *       unpublished drafts — and would also hand the editor a post it could load but not
 *       save.</li>
 *   <li><b>A post that does not exist is 403 for an AUTHOR and 404 for an ADMIN.</b> The
 *       expression runs before the service loads anything, so an AUTHOR cannot enumerate post
 *       ids by reading status codes. An ADMIN passes the check and gets the honest answer.</li>
 * </ul>
 *
 * {@code create} needs no ownership check — the author is the caller, taken from the principal
 * and not from the request. {@code listAll} cannot be expressed as a per-row annotation and is
 * scoped in the service instead; see the {@code authorScope} argument below.
 * {@code setFeaturedOrder} names no single post: it reorders the whole site's curated list,
 * which spans every author's posts, so it is ADMIN-only rather than owner-or-admin.
 */
@RestController
@RequestMapping("/api/v1/admin/posts")
@RequiredArgsConstructor
public class AdminPostController {

    /**
     * The rule of every route that names an existing post, including the sibling controllers under the same
     * {@code /api/v1/admin/posts/{id}} tree (images in the body, revisions): a single source for "owner or ADMIN". The
     * path variable must be named {@code id}.
     */
    static final String CAN_MANAGE = "hasRole('ADMIN') or @postAccess.isOwner(#id)";

    private final PostService postService;
    private final PostCoverService postCoverService;

    @GetMapping
    public PagedResponse<PostSummaryResponse> listAll(
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "20") int size) {
        // An ADMIN sees every post; an AUTHOR sees only its own. Scoping the list to match
        // what the caller may actually edit is not cosmetic: a list showing posts that every
        // write then refuses is a UI that invites the author to try, and it also discloses the
        // titles of other people's drafts.
        UUID authorScope = AuthenticatedUser.hasRole("ADMIN") ? null : AuthenticatedUser.requireUserId();

        Page<PostSummaryResponse> result = postService.listAll(page, size, authorScope);
        return new PagedResponse<>(
                result.getContent(),
                new PageMeta(result.getNumber(), result.getSize(), result.getTotalElements(), result.getTotalPages()));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<PostResponse> create(@Valid @RequestBody PostCreateRequest request) {
        return ApiResponse.of(postService.create(AuthenticatedUser.requireUserId(), request));
    }

    @GetMapping("/{id}")
    @PreAuthorize(CAN_MANAGE)
    public ApiResponse<PostResponse> getById(@PathVariable UUID id) {
        return ApiResponse.of(postService.getById(id));
    }

    @PutMapping("/{id}")
    @PreAuthorize(CAN_MANAGE)
    public ApiResponse<PostResponse> update(@PathVariable UUID id, @Valid @RequestBody PostUpdateRequest request) {
        return ApiResponse.of(postService.update(id, request, AuthenticatedUser.requireUserId()));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize(CAN_MANAGE)
    public void delete(@PathVariable UUID id) {
        // An ADMIN deletes for good; an AUTHOR only hides their own post (PostService.delete).
        postService.delete(id, AuthenticatedUser.requireUserId(), AuthenticatedUser.hasRole("ADMIN"));
    }

    @PostMapping("/{id}/publish")
    @PreAuthorize(CAN_MANAGE)
    public ApiResponse<PostResponse> publish(@PathVariable UUID id) {
        // The newsletter of a post an AUTHOR publishes is held for an ADMIN (NewsletterOutbox).
        return ApiResponse.of(postService.publish(id, AuthenticatedUser.hasRole("ADMIN")));
    }

    @PostMapping("/{id}/unpublish")
    @PreAuthorize(CAN_MANAGE)
    public ApiResponse<PostResponse> unpublish(@PathVariable UUID id) {
        return ApiResponse.of(postService.unpublish(id));
    }

    /**
     * Featuring is a presentation choice — which posts the public homepage leads with — and is
     * separate from publishing. A draft may be marked featured; it simply will not appear
     * anywhere until it is also published, because every public query filters on PUBLISHED.
     *
     * Two endpoints rather than one taking a body, to match publish/unpublish. ADMIN only (V7a):
     * homepage prominence is a site-level decision, not an author's.
     */
    @PostMapping("/{id}/feature")
    @PreAuthorize("hasRole('ADMIN')")
    public ApiResponse<PostResponse> feature(@PathVariable UUID id) {
        return ApiResponse.of(postService.setFeatured(id, true));
    }

    @PostMapping("/{id}/unfeature")
    @PreAuthorize("hasRole('ADMIN')")
    public ApiResponse<PostResponse> unfeature(@PathVariable UUID id) {
        return ApiResponse.of(postService.setFeatured(id, false));
    }

    /**
     * The "Featured posts" order of the whole site: replaces the whole list of ranks; a post not in the list keeps its
     * {@code featured} flag and only loses its rank. Returns every featured post, any status, in the new order: exactly
     * the list the sorting screen just sent, plus the posts that are featured but have no rank yet.
     *
     * ADMIN only, because the order spans the posts of every author: an AUTHOR gets 403 even when the list holds only
     * its own posts. Enforced with {@code @PreAuthorize} rather than a URL rule because the route sits under
     * {@code /api/v1/admin/posts/**}, where every route is decided by {@code @PreAuthorize} (SecurityErrorEnvelopeIT).
     * A literal path beats {@code /{id}} at handler selection (like {@code /search} in PostController), so it is never
     * read as a post with the id "featured-order".
     */
    @PutMapping("/featured-order")
    @PreAuthorize("hasRole('ADMIN')")
    public ApiResponse<List<PostSummaryResponse>> setFeaturedOrder(@Valid @RequestBody FeaturedOrderRequest request) {
        return ApiResponse.of(postService.setFeaturedOrder(request.postIds()));
    }

    /**
     * Cover image: uploaded and attached in one call, replacing and deleting the old image if there was one. There is
     * no standalone image upload endpoint, so no image exists without belonging to a post, and the permission on the
     * cover is exactly the permission on the post.
     *
     * {@code file} is not required at the binding layer: a missing part makes MediaService return 400
     * VALIDATION_ERROR just like an empty file, and that runs AFTER the permission check, so someone with no permission
     * on the post gets 403 whether the file part is missing or empty. {@code consumes} turns a request that is not
     * multipart (JSON, say) into 415 instead of "missing file"; that is decided at handler selection, before the
     * permission check, like every other content-type error.
     */
    @PostMapping(path = "/{id}/cover", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @PreAuthorize(CAN_MANAGE)
    public ApiResponse<PostResponse> uploadCover(
            @PathVariable UUID id,
            @RequestParam(name = "file", required = false) MultipartFile file,
            @RequestParam(name = "altText", required = false) String altText) {
        return ApiResponse.of(postCoverService.upload(id, file, altText, AuthenticatedUser.requireUserId()));
    }

    /** Replaces the whole cover description; a post with no cover returns 404 MEDIA_NOT_FOUND. */
    @PutMapping("/{id}/cover")
    @PreAuthorize(CAN_MANAGE)
    public ApiResponse<PostResponse> updateCoverAltText(
            @PathVariable UUID id, @RequestBody CoverAltTextRequest request) {
        return ApiResponse.of(postCoverService.updateAltText(id, request.altText()));
    }

    /** Detaches and deletes the cover. 200 with the post, not 204: admin-api cannot read a 204. Idempotent. */
    @DeleteMapping("/{id}/cover")
    @PreAuthorize(CAN_MANAGE)
    public ApiResponse<PostResponse> removeCover(@PathVariable UUID id) {
        return ApiResponse.of(postCoverService.remove(id));
    }
}
