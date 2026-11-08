package com.blog.newsletter.controller;

import com.blog.common.ratelimit.ClientAddressResolver;
import com.blog.common.response.ApiResponse;
import com.blog.newsletter.dto.NewsletterStateResponse;
import com.blog.newsletter.dto.NewsletterSubscribeRequest;
import com.blog.newsletter.dto.NewsletterTokenRequest;
import com.blog.newsletter.service.NewsletterService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The public newsletter, no login required (SecurityConfig): only the Next BFF route calls it. A successful response
 * is a constant and never echoes an address or a token.
 */
@RestController
@RequestMapping("/api/v1/newsletter")
@RequiredArgsConstructor
public class NewsletterController {

    private final NewsletterService newsletterService;
    private final ClientAddressResolver clientAddresses;

    @PostMapping("/subscriptions")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public ApiResponse<NewsletterStateResponse> subscribe(
            @Valid @RequestBody NewsletterSubscribeRequest request, HttpServletRequest http) {
        newsletterService.subscribe(request.email(), request.locale(), clientAddresses.resolve(http));
        return ApiResponse.of(NewsletterStateResponse.PENDING_CONFIRMATION);
    }

    @PostMapping("/confirm")
    public ApiResponse<NewsletterStateResponse> confirm(
            @RequestBody NewsletterTokenRequest request, HttpServletRequest http) {
        newsletterService.confirm(request.token(), clientAddresses.resolve(http));
        return ApiResponse.of(NewsletterStateResponse.CONFIRMED);
    }

    @PostMapping("/unsubscribe")
    public ApiResponse<NewsletterStateResponse> unsubscribe(
            @RequestBody NewsletterTokenRequest request, HttpServletRequest http) {
        newsletterService.unsubscribe(request.token(), clientAddresses.resolve(http));
        return ApiResponse.of(NewsletterStateResponse.UNSUBSCRIBED);
    }
}
