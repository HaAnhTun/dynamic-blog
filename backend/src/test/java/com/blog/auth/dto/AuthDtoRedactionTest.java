package com.blog.auth.dto;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.auth.entity.ChallengePurpose;
import com.blog.auth.service.FirstFactorResult;
import com.blog.auth.service.MfaChallengeService;
import com.blog.auth.service.RefreshTokenService;
import com.blog.common.response.ApiResponse;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The records that carry a password, a token or a challenge print none of them. Spring MVC and a debugger print a
 * request or response body with {@code toString} (DEBUG and TRACE body logging, an assertion message, an exception that
 * wraps a value), so a secret that a generated {@code toString} prints is a secret in a log. Other secret-bearing
 * records already say so ({@code SetupRequest}, {@code MfaCodeRequest}); these did not.
 */
class AuthDtoRedactionTest {

    private static final String PASSWORD = "pw-secret-123-not-a-real-one";
    private static final String ACCESS = "at-value-not-a-real-access-token";
    private static final String REFRESH = "rt-value-not-a-real-refresh-token";
    private static final String CHALLENGE = "ch-value-not-a-real-challenge";
    private static final String EMAIL = "someone-private@example.test";

    @Test
    void the_login_request_prints_neither_the_password_nor_the_address() {
        assertThat(new LoginRequest(EMAIL, PASSWORD).toString())
                .doesNotContain(PASSWORD)
                .doesNotContain(EMAIL);
    }

    @Test
    void the_refresh_request_prints_no_token() {
        assertThat(new RefreshRequest(REFRESH).toString()).doesNotContain(REFRESH);
    }

    @Test
    void the_token_response_prints_no_token_alone_or_wrapped() {
        TokenResponse tokens = new TokenResponse(ACCESS, REFRESH, 900, 604_800L);

        assertThat(tokens.toString()).doesNotContain(ACCESS).doesNotContain(REFRESH);
        assertThat(ApiResponse.of(tokens).toString()).doesNotContain(ACCESS).doesNotContain(REFRESH);
        assertThat(new FirstFactorResult.Session(tokens).toString())
                .doesNotContain(ACCESS)
                .doesNotContain(REFRESH);
        // What is left is useful: the lifetime.
        assertThat(tokens.toString()).contains("900");
    }

    @Test
    void the_second_step_answers_print_no_token_and_no_challenge() {
        MfaChallengeResponse challenge =
                new MfaChallengeResponse(CHALLENGE, "VERIFY", List.of("TOTP", "RECOVERY_CODE"), 300, false);
        MfaVerifiedResponse verified = new MfaVerifiedResponse(ACCESS, REFRESH, 900, 604_800L, 9, false);

        assertThat(challenge.toString()).doesNotContain(CHALLENGE).contains("VERIFY");
        assertThat(new FirstFactorResult.Challenge(challenge).toString()).doesNotContain(CHALLENGE);
        assertThat(ApiResponse.of(challenge).toString()).doesNotContain(CHALLENGE);
        assertThat(verified.toString()).doesNotContain(ACCESS).doesNotContain(REFRESH);
        assertThat(MfaVerifiedResponse.of(new TokenResponse(ACCESS, REFRESH, 900, 604_800L), 9, false)
                        .toString())
                .doesNotContain(ACCESS)
                .doesNotContain(REFRESH);
    }

    @Test
    void the_service_records_that_hold_a_raw_token_print_none() {
        UUID session = UUID.randomUUID();

        assertThat(new RefreshTokenService.IssuedToken(REFRESH, session, 604_800L).toString())
                .doesNotContain(REFRESH);
        assertThat(new RefreshTokenService.RotationResult(null, REFRESH, session, null, 604_800L).toString())
                .doesNotContain(REFRESH);
        assertThat(new MfaChallengeService.Issued(CHALLENGE, ChallengePurpose.VERIFY, 300, false).toString())
                .doesNotContain(CHALLENGE);
    }
}
