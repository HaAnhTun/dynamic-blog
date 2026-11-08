package com.blog.user.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.fixtures.vi.IdentityViNames;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import org.junit.jupiter.api.Test;

/** The rule that generates and validates the shape of the public handle, the same rule V32 uses for old rows (UserPublicSlugMigrationIT). */
class PublicSlugsTest {

    @Test
    void base_strips_diacritics_lowercases_collapses_odd_characters_into_one_dash_and_trims_dashes() {
        assertThat(PublicSlugs.base("Octocat")).isEqualTo("octocat");
        assertThat(PublicSlugs.base(IdentityViNames.NGUYEN_VAN_DUC)).isEqualTo("nguyen-van-duc");
        assertThat(PublicSlugs.base(IdentityViNames.DUONG_DI)).isEqualTo("duong-di");
        assertThat(PublicSlugs.base("--a__b  c--")).isEqualTo("a-b-c");
        assertThat(PublicSlugs.base("dev--ops-")).isEqualTo("dev-ops");
        // NFD text (combining marks separated) gives the same base as NFC.
        assertThat(PublicSlugs.base("Trần")).isEqualTo("tran");
    }

    @Test
    void base_max_40_characters_no_trailing_dash_and_empty_becomes_nguoi_dung() {
        assertThat(PublicSlugs.base("a".repeat(50))).isEqualTo("a".repeat(40));
        assertThat(PublicSlugs.base("x".repeat(39) + " yyy")).isEqualTo("x".repeat(39));
        assertThat(PublicSlugs.base("a".repeat(30) + " " + "b".repeat(30)))
                .isEqualTo("a".repeat(30) + "-" + "b".repeat(9));
        assertThat(PublicSlugs.base("!!! ???")).isEqualTo("nguoi-dung");
        assertThat(PublicSlugs.base("日本語")).isEqualTo("nguoi-dung");
        assertThat(PublicSlugs.base("")).isEqualTo("nguoi-dung");
        assertThat(PublicSlugs.base(null)).isEqualTo("nguoi-dung");
    }

    @Test
    void base_takes_login_first_then_display_name() {
        assertThat(PublicSlugs.baseOf("octocat", IdentityViNames.TEN_KHAC)).isEqualTo("octocat");
        assertThat(PublicSlugs.baseOf("", IdentityViNames.TEN_KHAC)).isEqualTo("ten-khac");
        assertThat(PublicSlugs.baseOf(null, IdentityViNames.TEN_KHAC)).isEqualTo("ten-khac");
    }

    @Test
    void only_lowercase_digits_and_single_dashes_up_to_64_characters_is_valid_shape() {
        assertThat(PublicSlugs.isWellFormed("octocat")).isTrue();
        assertThat(PublicSlugs.isWellFormed("nguyen-van-duc-2")).isTrue();
        assertThat(PublicSlugs.isWellFormed("a".repeat(64))).isTrue();
        assertThat(PublicSlugs.isWellFormed("a".repeat(65))).isFalse();
        for (String malformed :
                new String[] {null, "", "Octocat", "a--b", "-a", "a-", "a b", "a_b", IdentityViNames.D_STROKE, "a/b"}) {
            assertThat(PublicSlugs.isWellFormed(malformed))
                    .as("'%s'", malformed)
                    .isFalse();
        }
    }

    @Test
    void suspended_person_has_no_slug_to_link_to() {
        User user = new User();
        user.setPublicSlug("doc-gia");
        assertThat(PublicSlugs.profileSlugOf(user)).isEqualTo("doc-gia");
        user.setStatus(UserStatus.SUSPENDED);
        assertThat(PublicSlugs.profileSlugOf(user)).isNull();
    }
}
