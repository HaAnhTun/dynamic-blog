package com.blog.auth.controller;

import com.blog.auth.dto.CurrentUserResponse;
import com.blog.auth.dto.LoginRequest;
import com.blog.auth.dto.RefreshRequest;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.AuthService;
import com.blog.auth.service.FirstFactorResult;
import com.blog.common.ratelimit.ClientAddressResolver;
import com.blog.common.response.ApiResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;
    private final ClientAddressResolver clientAddresses;

    /**
     * Password login. {@code 200} with the token pair when no second factor applies (a reader, an author without
     * two-step verification); {@code 202 Accepted} with a {@code MfaChallengeResponse} and no token when one does (every
     * admin, and an author who enrolled). A client that does not know about two-step verification finds no
     * {@code accessToken} in a 202 and fails closed: that is the reason it is not a 200 with a union body.
     */
    @PostMapping("/login")
    public ResponseEntity<ApiResponse<?>> login(@Valid @RequestBody LoginRequest request, HttpServletRequest http) {
        return switch (authService.login(request, clientAddresses.resolve(http))) {
            case FirstFactorResult.Session session -> ResponseEntity.ok(ApiResponse.of(session.tokens()));
            case FirstFactorResult.Challenge challenge ->
                ResponseEntity.status(HttpStatus.ACCEPTED).body(ApiResponse.of(challenge.challenge()));
        };
    }

    @PostMapping("/refresh")
    public ApiResponse<TokenResponse> refresh(@Valid @RequestBody RefreshRequest request, HttpServletRequest http) {
        return ApiResponse.of(authService.refresh(request, clientAddresses.resolve(http)));
    }

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void logout(@Valid @RequestBody RefreshRequest request) {
        authService.logout(request);
    }

    /**
     * "Sign out everywhere": revokes every session of the caller, the one making this call included. Needs a valid
     * access token (main security chain).
     */
    @PostMapping("/sessions/revoke-all")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void signOutEverywhere() {
        authService.signOutEverywhere();
    }

    @GetMapping("/me")
    public ApiResponse<CurrentUserResponse> me() {
        return ApiResponse.of(authService.me());
    }
}
