package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.security.PasswordPolicy.Violation;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/** The shared password policy, against the real bundled list. No Spring: it is a plain component. */
class PasswordPolicyTest {

    private final PasswordPolicy policy = new PasswordPolicy();

    @Test
    void a_random_sixteen_character_passphrase_is_accepted() {
        assertThat(policy.check("plum-tractor-violin-9", "owner@example.test")).isEmpty();
        assertThat(policy.check("k3Vq8mZp1xRt7YwN", null)).isEmpty();
    }

    @Test
    void length_is_twelve_to_one_hundred_twenty_eight_characters() {
        assertThat(policy.check("k3Vq8mZp1xR", null)).contains(Violation.TOO_SHORT);
        assertThat(policy.check("k3Vq8mZp1xRt", null)).isEmpty();
        assertThat(policy.check("k3Vq8mZp".repeat(16), null)).isEmpty();
        assertThat(policy.check("k3Vq8mZp".repeat(16) + "x", null)).contains(Violation.TOO_LONG);
        assertThat(policy.check(null, null)).contains(Violation.TOO_SHORT);
    }

    @Test
    void a_listed_password_is_refused_whatever_its_case_and_surrounding_whitespace() {
        PasswordPolicy small = new PasswordPolicy(Set.of("masterbating"));

        assertThat(small.check("masterbating", null)).contains(Violation.TOO_COMMON);
        assertThat(small.check("MasterBating", null)).contains(Violation.TOO_COMMON);
        assertThat(small.check("  masterbating  ", null)).contains(Violation.TOO_COMMON);
        assertThat(small.check("masterbating-and-more", null)).isEmpty();
    }

    @Test
    void a_listed_word_with_only_digits_or_symbols_around_it_is_refused() {
        for (String weak :
                new String[] {"password1234", "welcome12345", "Welcome12345!!", "2024password", "dragon_12345678"}) {
            assertThat(policy.check(weak, null)).as(weak).contains(Violation.TOO_COMMON);
        }
        // A listed word inside a longer phrase of letters is not a listed password.
        assertThat(policy.check("the dragon sleeps 12", null)).isEmpty();
    }

    @Test
    void a_repetitive_or_consecutive_password_is_refused() {
        for (String weak : new String[] {
            "aaaaaaaaaaaa", "abababababab", "123456789012", "987654321098", "abcdefghijkl", "zyxwvutsrqpo"
        }) {
            assertThat(policy.check(weak, null)).as(weak).contains(Violation.TOO_COMMON);
        }
    }

    @Test
    void a_password_containing_the_email_local_part_is_refused_in_any_case() {
        assertThat(policy.check("my-Owner-secret-77", "owner@example.test")).contains(Violation.TOO_COMMON);
        assertThat(policy.check("my-owner-secret-77", "OWNER@example.test")).contains(Violation.TOO_COMMON);
        // The domain is not part of the needle, and a short local part is too weak a needle to refuse anything.
        assertThat(policy.check("my-example-secret-77", "owner@example.test")).isEmpty();
        assertThat(policy.check("my-bob-secret-7755", "bob@example.test")).isEmpty();
    }

    @Test
    void a_password_containing_the_development_password_of_the_seeded_admin_is_refused() {
        PasswordPolicy empty = new PasswordPolicy(Set.of());
        assertThat(empty.check("Admin12345-plum-tractor", null)).contains(Violation.TOO_COMMON);
        assertThat(empty.check("plum-tractor-" + SeedAdmin.DEV_PASSWORD, null)).contains(Violation.TOO_COMMON);
        assertThat(empty.check("plum-tractor-violin-9", null)).isEmpty();
    }

    @Test
    void the_new_password_must_differ_from_the_current_one() {
        assertThat(policy.check("k3Vq8mZp1xRt7YwN", null, "k3Vq8mZp1xRt7YwN")).contains(Violation.SAME_AS_CURRENT);
        assertThat(policy.check("k3Vq8mZp1xRt7YwN", null, "another-password-77"))
                .isEmpty();
    }

    @Test
    void require_throws_400_with_a_stable_message_that_never_contains_the_value() {
        String password = "password1234";
        assertThatThrownBy(() -> policy.require("newPassword", password, "owner@example.test", null))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(e.getMessage())
                            .isEqualTo("newPassword: is too common or too easy to guess")
                            .doesNotContain(password);
                });
        assertThat(Optional.of(Violation.SAME_AS_CURRENT.message()))
                .contains("must be different from the current password");
    }

    @Test
    void every_weak_reason_gives_the_same_message_so_the_list_is_not_an_oracle() {
        List<String> messages = List.of(
                messageOf("password1234", "owner@example.test"),
                messageOf("aaaaaaaaaaaa", "owner@example.test"),
                messageOf("my-owner-secret-77", "owner@example.test"));
        assertThat(new HashSet<>(messages)).hasSize(1);
    }

    private String messageOf(String password, String email) {
        return policy.check(password, email).orElseThrow().message();
    }
}
