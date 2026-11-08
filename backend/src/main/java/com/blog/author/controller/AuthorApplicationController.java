package com.blog.author.controller;

import com.blog.author.dto.AuthorApplicationRequest;
import com.blog.author.dto.AuthorApplicationResponse;
import com.blog.author.dto.MyAuthorApplicationResponse;
import com.blog.author.service.AuthorApplicationService;
import com.blog.common.response.ApiResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The caller's own author application: view the latest one, submit one. Requires login, any role (per-method rules in
 * SecurityConfig); no route accepts an application id or a user id, and there is no way to withdraw an application.
 */
@RestController
@RequestMapping("/api/v1/me/author-application")
@RequiredArgsConstructor
public class AuthorApplicationController {

    private final AuthorApplicationService authorApplicationService;

    @GetMapping
    public ApiResponse<MyAuthorApplicationResponse> mine() {
        return ApiResponse.of(authorApplicationService.mine());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<AuthorApplicationResponse> submit(@Valid @RequestBody AuthorApplicationRequest request) {
        return ApiResponse.of(authorApplicationService.submit(request));
    }
}
