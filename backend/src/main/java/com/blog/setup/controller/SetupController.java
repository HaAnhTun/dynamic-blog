package com.blog.setup.controller;

import com.blog.common.ratelimit.ClientAddressResolver;
import com.blog.common.response.ApiResponse;
import com.blog.setup.dto.SetupCompletedResponse;
import com.blog.setup.dto.SetupRequest;
import com.blog.setup.dto.SetupStatusResponse;
import com.blog.setup.service.SetupService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * First-run setup, without authentication (the pre-auth chain of SecurityConfig). No {@code @Valid}: SetupService checks
 * the rate limit, the state and the setup code before it looks at the form.
 */
@RestController
@RequestMapping("/api/v1/setup")
@RequiredArgsConstructor
public class SetupController {

    private final SetupService setupService;
    private final ClientAddressResolver clientAddresses;

    @GetMapping("/status")
    public ApiResponse<SetupStatusResponse> status() {
        return ApiResponse.of(setupService.status());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<SetupCompletedResponse> complete(
            @RequestBody(required = false) SetupRequest request, HttpServletRequest http) {
        return ApiResponse.of(setupService.complete(request, clientAddresses.resolve(http)));
    }
}
