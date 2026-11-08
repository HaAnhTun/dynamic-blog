package com.blog.newsletter.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.newsletter.dto.NewsletterHeldIssueResponse;
import com.blog.newsletter.dto.NewsletterReleaseRequest;
import com.blog.newsletter.dto.NewsletterStatsResponse;
import com.blog.newsletter.service.NewsletterService;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Newsletter figures and the newsletters held for approval. ADMIN only: everything under {@code /api/v1/admin} is, except
 * the trees SecurityConfig lists for an AUTHOR, and the newsletter is not one of them.
 */
@RestController
@RequestMapping("/api/v1/admin/newsletter")
@RequiredArgsConstructor
public class NewsletterAdminController {

    private final NewsletterService newsletterService;

    @GetMapping
    public ApiResponse<NewsletterStatsResponse> stats() {
        return ApiResponse.of(newsletterService.stats());
    }

    /** The newsletters of posts that an AUTHOR published, waiting for an administrator. */
    @GetMapping("/held")
    public ApiResponse<List<NewsletterHeldIssueResponse>> held() {
        return ApiResponse.of(newsletterService.held());
    }

    /** Lets a held newsletter go to the subscribers of the post language, if the post is still the text the list showed. */
    @PostMapping("/issues/{postId}/release")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void release(@PathVariable UUID postId, @Valid @RequestBody NewsletterReleaseRequest request) {
        newsletterService.release(postId, request.version(), AuthenticatedUser.requireUserId());
    }

    /** Refuses a held newsletter: it is kept as a record and never sent. */
    @PostMapping("/issues/{postId}/discard")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void discard(@PathVariable UUID postId) {
        newsletterService.discard(postId, AuthenticatedUser.requireUserId());
    }
}
