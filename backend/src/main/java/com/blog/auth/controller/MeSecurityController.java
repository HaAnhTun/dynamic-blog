package com.blog.auth.controller;

import com.blog.auth.dto.ChangePasswordRequest;
import com.blog.auth.dto.MeMfaBeginRequest;
import com.blog.auth.dto.MeMfaCodeRequest;
import com.blog.auth.dto.MeMfaStepUpRequest;
import com.blog.auth.dto.MfaEnrollmentConfirmedResponse;
import com.blog.auth.dto.MfaEnrollmentSecretResponse;
import com.blog.auth.dto.MfaRecoveryCodesResponse;
import com.blog.auth.dto.MfaStatusResponse;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.AccountSecurityService;
import com.blog.common.response.ApiResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The signed-in person's own security: two-step verification and the password. Every mutation needs a sign-in within the
 * last minutes (401 {@code REAUTHENTICATION_REQUIRED} otherwise), then its own step-up (a code, and the current password
 * where the account has one). Those that end the other sessions answer the caller's NEW session as a token pair, which the
 * Next route puts in the cookies.
 *
 * Who may call what is decided by the URL rules of {@code SecurityConfig} (reading the status is open to any signed-in
 * account; the rest is ADMIN or AUTHOR, the password change any account with a password) and by the service (an
 * administrator cannot turn two-step verification off, an author is the only one who turns it on here).
 */
@RestController
@RequestMapping("/api/v1/me")
@RequiredArgsConstructor
public class MeSecurityController {

    private final AccountSecurityService security;

    @GetMapping("/mfa")
    public ApiResponse<MfaStatusResponse> status() {
        return ApiResponse.of(security.status());
    }

    /** An author starts turning two-step verification on: answers the secret once; nothing changes until the first code. */
    @PostMapping("/mfa/enroll/begin")
    public ApiResponse<MfaEnrollmentSecretResponse> beginEnrollment(@Valid @RequestBody MeMfaBeginRequest request) {
        return ApiResponse.of(security.beginEnrollment(request.currentPassword()));
    }

    /** Confirms it with the first code: ten recovery codes (once) and the caller's new session. */
    @PostMapping("/mfa/enroll/confirm")
    public ApiResponse<MfaEnrollmentConfirmedResponse> confirmEnrollment(@Valid @RequestBody MeMfaCodeRequest request) {
        return ApiResponse.of(security.confirmEnrollment(request.code()));
    }

    /** Ten new recovery codes; the older ones are void. */
    @PostMapping("/mfa/recovery-codes/regenerate")
    public ApiResponse<MfaRecoveryCodesResponse> regenerateRecoveryCodes(
            @Valid @RequestBody MeMfaStepUpRequest request) {
        return ApiResponse.of(security.regenerateRecoveryCodes(request.code(), request.currentPassword()));
    }

    /** A new authenticator waits next to the current one, which keeps working. */
    @PostMapping("/mfa/replace/begin")
    public ApiResponse<MfaEnrollmentSecretResponse> beginReplace(@Valid @RequestBody MeMfaStepUpRequest request) {
        return ApiResponse.of(security.beginReplace(request.code(), request.currentPassword()));
    }

    /** Swaps the authenticator at the first code of the new one: ten new recovery codes and the caller's new session. */
    @PostMapping("/mfa/replace/confirm")
    public ApiResponse<MfaEnrollmentConfirmedResponse> confirmReplace(@Valid @RequestBody MeMfaCodeRequest request) {
        return ApiResponse.of(security.confirmReplace(request.code()));
    }

    /** An author turns it off (an administrator cannot: 403 {@code MFA_REQUIRED}); answers the caller's new session. */
    @DeleteMapping("/mfa")
    public ApiResponse<TokenResponse> disable(@Valid @RequestBody MeMfaCodeRequest request) {
        return ApiResponse.of(security.disable(request.code()));
    }

    /** Changes the password; every other device is signed out; answers the caller's new session. */
    @PostMapping("/password")
    public ApiResponse<TokenResponse> changePassword(@Valid @RequestBody ChangePasswordRequest request) {
        return ApiResponse.of(security.changePassword(request));
    }
}
