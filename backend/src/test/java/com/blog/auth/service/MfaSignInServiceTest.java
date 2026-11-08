package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.auth.dto.MfaEnrollmentConfirmedResponse;
import com.blog.auth.dto.MfaEnrollmentSecretResponse;
import com.blog.auth.dto.MfaVerifiedResponse;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;

/**
 * The per-client-address count of the second step of a sign-in. A unit test because what must be proven is the ORDER: the
 * address is counted before the challenge is looked at, so an address over its limit costs the backend no database work and
 * touches no account counter.
 */
@ExtendWith(MockitoExtension.class)
class MfaSignInServiceTest {

    private static final ClientAddress CLIENT =
            ClientAddress.parse("203.0.113.9").orElseThrow();
    private static final String CHALLENGE = "a-raw-challenge";
    private static final String CODE = "123456";

    @Mock
    private RateLimiter rateLimiter;

    @Mock
    private MfaService mfaService;

    @InjectMocks
    private MfaSignInService service;

    private void overTheLimit() {
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "slow down"))
                .when(rateLimiter)
                .check(RateLimiter.MFA_CLIENT, CLIENT.key());
    }

    @Test
    void verify_counts_the_client_address_before_the_challenge_is_looked_at() {
        MfaVerifiedResponse answer = new MfaVerifiedResponse("access", "refresh", 900, 604_800L, 7, false);
        when(mfaService.verify(CHALLENGE, CODE)).thenReturn(answer);

        assertThat(service.verify(CHALLENGE, CODE, CLIENT)).isSameAs(answer);

        InOrder order = inOrder(rateLimiter, mfaService);
        order.verify(rateLimiter).check(RateLimiter.MFA_CLIENT, CLIENT.key());
        order.verify(mfaService).verify(CHALLENGE, CODE);
    }

    @Test
    void verify_from_an_address_over_its_limit_gets_429_and_reaches_no_account() {
        overTheLimit();

        assertThatThrownBy(() -> service.verify(CHALLENGE, CODE, CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.TOO_MANY_REQUESTS);
        verifyNoInteractions(mfaService);
    }

    @Test
    void beginning_an_enrollment_counts_the_client_address_before_the_challenge_is_looked_at() {
        MfaEnrollmentSecretResponse answer =
                new MfaEnrollmentSecretResponse("SECRET", "otpauth://x", "Blog", "account");
        when(mfaService.beginEnrollment(CHALLENGE, "operator-code")).thenReturn(answer);

        assertThat(service.beginEnrollment(CHALLENGE, "operator-code", CLIENT)).isSameAs(answer);

        InOrder order = inOrder(rateLimiter, mfaService);
        order.verify(rateLimiter).check(RateLimiter.MFA_CLIENT, CLIENT.key());
        order.verify(mfaService).beginEnrollment(CHALLENGE, "operator-code");
    }

    @Test
    void beginning_an_enrollment_from_an_address_over_its_limit_gets_429_and_reaches_no_account() {
        overTheLimit();

        assertThatThrownBy(() -> service.beginEnrollment(CHALLENGE, "operator-code", CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED);
        verifyNoInteractions(mfaService);
    }

    @Test
    void confirming_an_enrollment_counts_the_client_address_before_the_challenge_is_looked_at() {
        MfaEnrollmentConfirmedResponse answer =
                new MfaEnrollmentConfirmedResponse("access", "refresh", 900, 604_800L, List.of("code"));
        when(mfaService.confirmEnrollment(CHALLENGE, CODE)).thenReturn(answer);

        assertThat(service.confirmEnrollment(CHALLENGE, CODE, CLIENT)).isSameAs(answer);

        InOrder order = inOrder(rateLimiter, mfaService);
        order.verify(rateLimiter).check(RateLimiter.MFA_CLIENT, CLIENT.key());
        order.verify(mfaService).confirmEnrollment(CHALLENGE, CODE);
    }

    @Test
    void confirming_an_enrollment_from_an_address_over_its_limit_gets_429_and_reaches_no_account() {
        overTheLimit();

        assertThatThrownBy(() -> service.confirmEnrollment(CHALLENGE, CODE, CLIENT))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED);
        verify(rateLimiter).check(RateLimiter.MFA_CLIENT, CLIENT.key());
        verifyNoInteractions(mfaService);
    }
}
