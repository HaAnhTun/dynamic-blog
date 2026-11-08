package com.blog.auth.controller;

import com.blog.auth.dto.MfaCodeRequest;
import com.blog.auth.dto.MfaEnrollRequest;
import com.blog.auth.dto.MfaEnrollmentConfirmedResponse;
import com.blog.auth.dto.MfaEnrollmentSecretResponse;
import com.blog.auth.dto.MfaVerifiedResponse;
import com.blog.auth.dto.MfaVerifyRequest;
import com.blog.auth.service.MfaSignInService;
import com.blog.common.ratelimit.ClientAddressResolver;
import com.blog.common.response.ApiResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The second step of a sign-in, before any session exists. The paths are public (no token), so they sit in the token
 * endpoints chain of {@code SecurityConfig} next to {@code /auth/login}: an expired bearer header on the request must not
 * turn a code into a 401 from the filter. The challenge from the login answer is the only credential here.
 *
 * Every call is counted against the client address first ({@link MfaSignInService}), so a backend reached without Next is
 * limited too.
 */
@RestController
@RequestMapping("/api/v1/auth/mfa")
@RequiredArgsConstructor
public class MfaLoginController {

    private final MfaSignInService mfaSignIn;
    private final ClientAddressResolver clientAddresses;

    /** Checks an authenticator code or a recovery code and, when right, answers with the tokens like a login does. */
    @PostMapping("/verify")
    public ApiResponse<MfaVerifiedResponse> verify(
            @Valid @RequestBody MfaVerifyRequest request, HttpServletRequest http) {
        return ApiResponse.of(mfaSignIn.verify(request.challenge(), request.code(), clientAddresses.resolve(http)));
    }

    /**
     * Begins the forced enrollment of an account whose sign-in answered a challenge of purpose {@code ENROLL}: checks the
     * operator's enrollment code unless the enrollment window is open, stores a new secret PENDING and answers with it once.
     * Nothing about the account changes until the first code is confirmed.
     */
    @PostMapping("/enroll/begin")
    public ApiResponse<MfaEnrollmentSecretResponse> beginEnrollment(
            @Valid @RequestBody MfaEnrollRequest request, HttpServletRequest http) {
        return ApiResponse.of(mfaSignIn.beginEnrollment(
                request.challenge(), request.enrollmentCode(), clientAddresses.resolve(http)));
    }

    /**
     * Confirms the enrollment with the first code of the new authenticator: the enrollment becomes active, the ten recovery
     * codes are answered once, every older session of the account is revoked and the new session is issued.
     */
    @PostMapping("/enroll/confirm")
    public ApiResponse<MfaEnrollmentConfirmedResponse> confirmEnrollment(
            @Valid @RequestBody MfaCodeRequest request, HttpServletRequest http) {
        return ApiResponse.of(
                mfaSignIn.confirmEnrollment(request.challenge(), request.code(), clientAddresses.resolve(http)));
    }
}
