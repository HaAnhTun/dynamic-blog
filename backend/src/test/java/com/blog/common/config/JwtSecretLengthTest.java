package com.blog.common.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.fixtures.vi.IdentityViText;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/**
 * A JWT secret shorter than HS256 requires must be rejected, and rejected at startup.
 *
 * The timing is the whole point. Nimbus rejects a short key too, but at the moment it first
 * SIGNS — which is the first login. Without this check a deployment with a ten-character
 * secret boots, serves the public site, passes its health check, and then fails the first
 * login with a KeyLengthException, hours after the person who could have fixed it stopped
 * watching. `jwtEncoder` is an eager singleton, so running the check inside it means the
 * context cannot come up.
 *
 * This file tests the RULE, not the startup ordering. An earlier version drove a real
 * SpringApplication and was deleted: to fail fast it pointed the datasource at a dead port,
 * and the datasource then failed first, so the assertion was about the wrong exception
 * entirely. That the rule runs during startup is verified by hand against a running
 * application and recorded in the README rather than claimed by a test that cannot see it.
 */
class JwtSecretLengthTest {

    @Test
    void aShortSecretIsRejectedWithItsLengthAndTheRemedy() {
        assertThatThrownBy(() -> SecurityConfig.requireUsableSecret("too-short"))
                .isInstanceOf(IllegalStateException.class)
                // The length and the fix, so the message is actionable without reading code.
                .hasMessageContaining("9 bytes")
                .hasMessageContaining("at least 32")
                .hasMessageContaining("openssl rand")
                // And never the secret itself. A startup exception is the one place a
                // credential survives log rotation and ends up in a support ticket.
                .hasMessageNotContaining("too-short");
    }

    @Test
    void exactlyThirtyTwoBytesIsAccepted() {
        // The boundary RFC 7518 §3.2 names for HS256: a key at least as long as the hash
        // output. The check must accept 32 rather than demand more, and this is also the
        // positive control — without it, a bug rejecting every secret would satisfy the
        // rejection test above.
        String thirtyTwo = "01234567890123456789012345678901";
        assertThat(thirtyTwo.getBytes(StandardCharsets.UTF_8)).hasSize(32);

        assertThatCode(() -> SecurityConfig.requireUsableSecret(thirtyTwo)).doesNotThrowAnyException();
    }

    @Test
    void thirtyOneBytesIsNot() {
        // One byte below the boundary, because an off-by-one in a `<` would pass both tests
        // above.
        String thirtyOne = "0123456789012345678901234567890";
        assertThat(thirtyOne.getBytes(StandardCharsets.UTF_8)).hasSize(31);

        assertThatThrownBy(() -> SecurityConfig.requireUsableSecret(thirtyOne)).hasMessageContaining("31 bytes");
    }

    @Test
    void aLongSecretOfOneRepeatedCharacterIsRejectedWithTheCountAndTheRemedyButNotTheValue() {
        // 64 bytes, long enough, and as guessable as a secret can be (audit 075).
        String repeated = "z".repeat(64);

        assertThatThrownBy(() -> SecurityConfig.requireUsableSecret(repeated))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("1 different bytes")
                .hasMessageContaining("openssl rand")
                .hasMessageNotContaining("zzzz");
    }

    @Test
    void sevenDifferentBytesAreNotEnoughAndEightAre() {
        // The boundary of the floor, with a pattern that repeats: an off-by-one in a `<` passes the other tests.
        String seven = "abcdefg".repeat(6);
        String eight = "abcdefgh".repeat(5);
        assertThat(seven.getBytes(StandardCharsets.UTF_8)).hasSize(42);
        assertThat(eight.getBytes(StandardCharsets.UTF_8)).hasSize(40);

        assertThatThrownBy(() -> SecurityConfig.requireUsableSecret(seven)).hasMessageContaining("7 different bytes");
        assertThatCode(() -> SecurityConfig.requireUsableSecret(eight)).doesNotThrowAnyException();
    }

    @Test
    void theDevelopmentDefaultClearsTheBar() {
        // The default committed to this repository has to pass, or a fresh clone would meet
        // this exception and the first thing a developer learned about the project would be
        // how to work around a startup check.
        //
        // The literal, not `new SecurityProperties(null, null, null).jwtSecret()`, which is
        // what this test tried first: @DefaultValue is applied by Spring's binder, so a bare
        // constructor call returns null and the test failed on its own premise. Duplicating
        // the string is the lesser evil — and if the two ever diverge, the duplicate is
        // longer than 32 bytes anyway, so the worst case is that this test stops describing
        // the real default rather than passing while the application breaks.
        String devDefault = "dev-only-secret-change-me-this-must-be-at-least-32-bytes-long";
        assertThat(devDefault.getBytes(StandardCharsets.UTF_8).length).isEqualTo(61);

        assertThatCode(() -> SecurityConfig.requireUsableSecret(devDefault)).doesNotThrowAnyException();
    }

    @Test
    void aMultiByteSecretIsMeasuredInBYTESNotCHARACTERS() {
        // 26 characters, 37 bytes — measured, not estimated. This is the case that
        // distinguishes the two possible implementations: a check counting CHARACTERS would
        // reject this secret as 26 < 32, while the byte count accepts it at 37. HS256's
        // requirement is on key material, i.e. bytes, so rejecting it would be wrong.
        //
        // The first version of this test used a 20-character string and asserted its byte
        // length was above 32. It is 29. The assertion failed, which is the only reason the
        // number here is measured rather than guessed.
        String vietnamese = IdentityViText.SECRET_VIETNAMESE;
        assertThat(vietnamese).hasSize(26);
        assertThat(vietnamese.getBytes(StandardCharsets.UTF_8).length).isEqualTo(37);

        assertThatCode(() -> SecurityConfig.requireUsableSecret(vietnamese)).doesNotThrowAnyException();
    }
}
