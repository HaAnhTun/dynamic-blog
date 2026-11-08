package com.blog.post.controller;

import com.blog.common.i18n.Languages;
import com.blog.common.response.ApiResponse;
import com.blog.common.response.PageMeta;
import com.blog.common.response.PagedResponse;
import com.blog.post.dto.PostRedirectResponse;
import com.blog.post.dto.PostResponse;
import com.blog.post.dto.PostSummaryResponse;
import com.blog.post.service.PostService;
import com.blog.post.service.PostViewService;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/posts")
@RequiredArgsConstructor
public class PostController {

    private final PostService postService;
    private final PostViewService postViewService;
    private final Languages languages;

    @GetMapping
    public PagedResponse<PostSummaryResponse> list(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String category,
            @RequestParam(required = false) String tag,
            // Boxed and with no default, so "absent" stays distinguishable from "false".
            // A primitive would default to false and silently turn a plain /posts request
            // into "only posts that are not featured".
            @RequestParam(required = false) Boolean featured,
            // Public handle of the writer, like GET /api/v1/users/{slug}.
            @RequestParam(required = false) String author,
            // The order is a query param rather than a /popular path: a literal there would hide a post whose slug is
            // "popular". Sending it empty is also the default (Spring uses defaultValue for an empty value).
            @RequestParam(defaultValue = PostService.SORT_LATEST) String sort,
            // Absent means every language; an unknown code is a 400.
            @RequestParam(required = false) String lang) {
        Page<PostSummaryResponse> result =
                postService.listPublished(page, size, category, tag, featured, author, sort, languages.optional(lang));
        return new PagedResponse<>(
                result.getContent(),
                new PageMeta(result.getNumber(), result.getSize(), result.getTotalElements(), result.getTotalPages()));
    }

    /**
     * Ranked full-text search over published posts.
     *
     * Mapped before {@code /{slug}} in this file for readability only — Spring MVC prefers
     * the literal path over the template regardless of declaration order, so {@code /search}
     * can never be mistaken for a post whose slug is "search". Worth knowing rather than
     * relying on: if a post ever needed that slug, this endpoint would still win.
     *
     * A blank or missing {@code q} with no filter answers an empty page rather than 400. A search box that
     * submits on empty is a normal thing for a reader to do, and an error envelope for it
     * would be a worse answer than "nothing matched yet".
     *
     * The filters are slugs: {@code category} and {@code series} one each, {@code tag} may repeat (Spring also splits
     * "a,b"). Rules and limits are in {@link PostService#search}.
     */
    @GetMapping("/search")
    public PagedResponse<PostSummaryResponse> search(
            @RequestParam(required = false, defaultValue = "") String q,
            @RequestParam(required = false) String category,
            @RequestParam(required = false) List<String> tag,
            @RequestParam(required = false) String series,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String lang) {
        Page<PostSummaryResponse> result =
                postService.search(q, category, tag, series, page, size, languages.optional(lang));
        return new PagedResponse<>(
                result.getContent(),
                new PageMeta(result.getNumber(), result.getSize(), result.getTotalElements(), result.getTotalPages()));
    }

    @GetMapping("/{slug}")
    public ApiResponse<PostResponse> getBySlug(@PathVariable String slug) {
        return ApiResponse.of(postService.getPublishedBySlug(slug));
    }

    /**
     * The current slug of the published post that once held {@code slug}: Next asks after {@code GET /{slug}} returned
     * 404, then redirects permanently, so shared links survive a slug edit. One hop however many times the post changed
     * slug; never returns {@code slug} itself.
     *
     * A separate path instead of putting the new slug in the 404 body of {@code GET /{slug}}: the 404 keeps its meaning,
     * and the (cached) post page does not have to read the slug history on every view. Public like every GET under
     * {@code /api/v1/posts/**}; one {slug} segment followed by a literal, like {@code /{slug}/like}, so it hides no
     * post: a post with the slug "redirect" is still at {@code /redirect}. 404 {@code POST_NOT_FOUND} in every other
     * case, including a post that once held this slug but is now a draft.
     */
    @GetMapping("/{slug}/redirect")
    public ApiResponse<PostRedirectResponse> redirect(@PathVariable String slug) {
        return ApiResponse.of(postService.findRedirect(slug));
    }

    /**
     * One view for a published post. The Next server calls it after it has answered the reader, filtering bots and
     * counting once per session; the browser never calls it directly.
     *
     * No login needed (a dedicated POST rule for exactly this path in SecurityConfig). When {@code app.views.token} is
     * set, the {@code X-View-Token} header must match; PostViewService checks it, because a URL rule cannot compare
     * headers in constant time. 204 with no body: there is nothing for the caller to read.
     *
     * {@code X-View-Referrer} (optional): the host of the page that led to the post, sent by the Next route; it cannot
     * be trusted, and only its source group is recorded (ViewSourceClassifier).
     */
    @PostMapping("/{slug}/views")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void recordView(
            @PathVariable String slug,
            @RequestHeader(name = "X-View-Token", required = false) String viewToken,
            @RequestHeader(name = "X-View-Referrer", required = false) String referrerHost) {
        postViewService.record(slug, viewToken, referrerHost);
    }
}
