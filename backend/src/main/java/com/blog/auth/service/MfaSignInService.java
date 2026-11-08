package com.blog.auth.service;

import com.blog.auth.dto.MfaEnrollmentConfirmedResponse;
import com.blog.auth.dto.MfaEnrollmentSecretResponse;
import com.blog.auth.dto.MfaVerifiedResponse;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/**
 * The front door of the second step of a sign-in (verify a code, begin and confirm the forced enrollment): the three public
 * endpoints under {@code /auth/mfa}. It counts the client address BEFORE a database transaction opens and before the
 * challenge is looked at, then hands over to {@link MfaService}, exactly as the password login counts its address before
 * the account is read.
 *
 * Why it exists: the limits in Next are per address too, but a backend with a public URL of its own is reached without
 * Next. The guarantee against guessing a code is the per-account counter inside {@link MfaService}; this count only keeps
 * one address from spending the backend's work (and the challenge attempts of other people) at will. Every attempt is
 * counted, wrong or right, and the three endpoints share one count.
 *
 * Nothing here logs. The challenge and the code stay in the arguments.
 */
@Service
@RequiredArgsConstructor
public class MfaSignInService {

    private final RateLimiter rateLimiter;
    private final MfaService mfaService;

    /**
     * @param client where the request comes from (ClientAddressResolver)
     * @throws com.blog.common.exception.ApiException 429 {@code RATE_LIMITED} when this client address made too many
     *     attempts; otherwise what {@link MfaService#verify} throws
     */
    public MfaVerifiedResponse verify(String challenge, String code, ClientAddress client) {
        rateLimiter.check(RateLimiter.MFA_CLIENT, client.key());
        return mfaService.verify(challenge, code);
    }

    /** Like {@link #verify}, for {@link MfaService#beginEnrollment}. */
    public MfaEnrollmentSecretResponse beginEnrollment(String challenge, String enrollmentCode, ClientAddress client) {
        rateLimiter.check(RateLimiter.MFA_CLIENT, client.key());
        return mfaService.beginEnrollment(challenge, enrollmentCode);
    }

    /** Like {@link #verify}, for {@link MfaService#confirmEnrollment}. */
    public MfaEnrollmentConfirmedResponse confirmEnrollment(String challenge, String code, ClientAddress client) {
        rateLimiter.check(RateLimiter.MFA_CLIENT, client.key());
        return mfaService.confirmEnrollment(challenge, code);
    }
}
