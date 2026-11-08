package com.blog.auth.oauth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.fixtures.vi.IdentityViText;
import java.math.BigInteger;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * A GitHub profile becomes blog data that is allowed to be stored: a numeric id, a login that follows GitHub's rules, a sanitized
 * display name, an avatar only from avatars.githubusercontent.com, and no email.
 *
 * Special characters are built from code points ({@link #cp}), not written directly in the source, like UserTextTest.
 */
class GithubProfileTest {

    private static final String AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4";

    private static String cp(int... codePoints) {
        return new String(codePoints, 0, codePoints.length);
    }

    // --- id ----------------------------------------------------------------------------------------------

    @Test
    void id_as_Integer_or_Long_above_2_pow_31_are_both_accepted() {
        assertThat(GithubProfile.from(attributes(583231, "octocat")).id()).isEqualTo(583231L);
        // Jackson reads a small number as Integer and a large one as Long: both are real GitHub ids.
        assertThat(GithubProfile.from(attributes(3_000_000_001L, "bigid")).id()).isEqualTo(3_000_000_001L);
        assertThat(GithubProfile.from(attributes(BigInteger.valueOf(Long.MAX_VALUE), "maxid"))
                        .id())
                .isEqualTo(Long.MAX_VALUE);
    }

    @Test
    void id_that_is_not_positive_integer_fitting_a_long_is_rejected() {
        for (Object id : new Object[] {
            "583231", null, 0, -7, 1.5d, 583231.0d, BigInteger.TWO.pow(64).add(BigInteger.valueOf(583231)), true
        }) {
            assertThatThrownBy(() -> GithubProfile.from(attributes(id, "octocat")))
                    .as("id = %s", id)
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    // --- login -------------------------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(strings = {"octocat", "a", "A-b-9", "x23456789012345678901234567890123456789"})
    void login_following_github_rules_is_accepted_verbatim(String login) {
        assertThat(login.length()).isLessThanOrEqualTo(39);
        assertThat(GithubProfile.from(attributes(1, login)).login()).isEqualTo(login);
    }

    @Test
    void login_breaking_rules_is_rejected() {
        String forty = "x".repeat(40);
        for (Object login : new Object[] {
            "a/b",
            "../x",
            forty,
            "-abc",
            "",
            " octocat",
            "octo cat",
            "octocat\n",
            "octo_cat",
            "octocat" + cp(0x200B),
            IdentityViText.LOGIN_WITH_DIACRITICS,
            null,
            42
        }) {
            assertThatThrownBy(() -> GithubProfile.from(attributes(1, login)))
                    .as("login = %s", login)
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    // --- Display name -----------------------------------------------------------------------------------

    @Test
    void missing_name_or_name_of_only_invisible_chars_falls_back_to_login() {
        Map<String, Object> noName = attributes(1, "octocat");
        Map<String, Object> invisible = attributes(1, "octocat");
        invisible.put("name", cp(0x200B, 0x202E, 0x2066) + "  \t");
        Map<String, Object> notText = attributes(1, "octocat");
        notText.put("name", 12345);

        assertThat(GithubProfile.from(noName).displayName()).isEqualTo("octocat");
        assertThat(GithubProfile.from(invisible).displayName()).isEqualTo("octocat");
        assertThat(GithubProfile.from(notText).displayName()).isEqualTo("octocat");
    }

    @Test
    void name_has_control_and_bidi_chars_removed_and_whitespace_collapsed() {
        Map<String, Object> spoof = attributes(1, "octocat");
        spoof.put(
                "name",
                "  " + IdentityViText.NAME_NGUYEN + cp(0x202E) + "  " + IdentityViText.NAME_VAN + "\nA" + cp(0x200F)
                        + "  ");

        assertThat(GithubProfile.from(spoof).displayName())
                .isEqualTo(IdentityViText.NAME_NGUYEN + " " + IdentityViText.NAME_VAN + " A");
    }

    @Test
    void long_name_is_cut_at_100_code_points_without_splitting_an_emoji() {
        Map<String, Object> longName = attributes(1, "octocat");
        longName.put("name", cp(0x1F600).repeat(150));

        String displayName = GithubProfile.from(longName).displayName();
        assertThat(displayName.codePointCount(0, displayName.length())).isEqualTo(100);
        assertThat(displayName).isEqualTo(cp(0x1F600).repeat(100));
    }

    // --- Avatar -----------------------------------------------------------------------------------------

    @Test
    void avatar_kept_only_on_avatars_githubusercontent_com_over_https_and_within_500_chars() {
        assertThat(avatarOf(AVATAR)).isEqualTo(AVATAR);
        String exactly500 = "https://avatars.githubusercontent.com/u/1?v=" + "4".repeat(500 - 44);
        assertThat(exactly500).hasSize(500);
        assertThat(avatarOf(exactly500)).isEqualTo(exactly500);

        assertThat(avatarOf(exactly500 + "4")).isNull();
        assertThat(avatarOf("http://avatars.githubusercontent.com/u/1?v=4")).isNull();
        assertThat(avatarOf("https://avatars.githubusercontent.com.evil.example/u/1"))
                .isNull();
        assertThat(avatarOf("https://evil.example/https://avatars.githubusercontent.com/u/1"))
                .isNull();
        assertThat(avatarOf("javascript:alert(1)")).isNull();
        assertThat(avatarOf("")).isNull();
        assertThat(avatarOf(null)).isNull();
        assertThat(avatarOf(7)).isNull();
    }

    // --- Email -------------------------------------------------------------------------------------------

    @Test
    void email_is_ignored_and_there_is_nowhere_to_keep_it() {
        Map<String, Object> withEmail = attributes(1, "octocat");
        withEmail.put("email", "admin@blog.local");

        GithubProfile profile = GithubProfile.from(withEmail);

        assertThat(profile).isEqualTo(GithubProfile.from(attributes(1, "octocat")));
        assertThat(Arrays.stream(GithubProfile.class.getRecordComponents()).map(c -> c.getName()))
                .containsExactly("id", "login", "displayName", "avatarUrl");
    }

    // --- Helpers ----------------------------------------------------------------------------------------

    private static Map<String, Object> attributes(Object id, Object login) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put("id", id);
        attributes.put("login", login);
        return attributes;
    }

    private static String avatarOf(Object avatarUrl) {
        Map<String, Object> attributes = attributes(1, "octocat");
        attributes.put("avatar_url", avatarUrl);
        return GithubProfile.from(attributes).avatarUrl();
    }
}
