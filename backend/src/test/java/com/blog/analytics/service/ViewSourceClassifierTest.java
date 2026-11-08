package com.blog.analytics.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Maps the referrer page's host to a source group. The header comes from the Next route but cannot be trusted: any
 * value that is not a clean host is {@code other}, and no value can produce a group outside the six fixed ones.
 */
class ViewSourceClassifierTest {

    private final ViewSourceClassifier classifier = new ViewSourceClassifier("https://blog.example.com");

    @Test
    void missing_or_blank_is_direct() {
        assertAll(ViewSource.DIRECT, Arrays.asList(null, "", "   ", "\t"));
    }

    @Test
    void search_engines_including_google_and_yandex_with_country_suffixes() {
        assertAll(
                ViewSource.SEARCH,
                List.of(
                        "google.com",
                        "www.google.com",
                        "google.com.vn",
                        "www.google.com.vn",
                        "google.co.uk",
                        "google.de",
                        "news.google.com",
                        "yandex.ru",
                        "yandex.com.tr",
                        "bing.com",
                        "www.bing.com",
                        "duckduckgo.com",
                        "search.yahoo.com",
                        "vn.search.yahoo.com",
                        "baidu.com",
                        "ecosia.org",
                        "coccoc.com",
                        "search.brave.com",
                        "startpage.com"));
    }

    @Test
    void social_networks_and_github_match_exact_domain_or_subdomain() {
        assertAll(
                ViewSource.SOCIAL,
                List.of(
                        "facebook.com",
                        "l.facebook.com",
                        "m.facebook.com",
                        "lm.facebook.com",
                        "t.co",
                        "twitter.com",
                        "x.com",
                        "www.linkedin.com",
                        "lnkd.in",
                        "old.reddit.com",
                        "news.ycombinator.com",
                        "zalo.me",
                        "threads.net",
                        "bsky.app",
                        "youtube.com",
                        "instagram.com",
                        "tiktok.com",
                        "t.me",
                        "discord.com"));
        assertAll(
                ViewSource.GITHUB,
                List.of("github.com", "gist.github.com", "someone.github.io", "raw.githubusercontent.com"));
    }

    @Test
    void uppercase_trailing_dot_and_surrounding_whitespace_are_normalized() {
        assertThat(classifier.classify("WWW.GOOGLE.COM")).isEqualTo(ViewSource.SEARCH);
        assertThat(classifier.classify("GitHub.com.")).isEqualTo(ViewSource.GITHUB);
        assertThat(classifier.classify("  t.co  ")).isEqualTo(ViewSource.SOCIAL);
    }

    @Test
    void own_site_with_and_without_www_is_internal_and_wins_over_every_other_group() {
        assertAll(ViewSource.INTERNAL, List.of("blog.example.com", "www.blog.example.com", "BLOG.EXAMPLE.COM."));
        // Only the exact host and www: the parent domain, other subdomains and look-alike names are elsewhere.
        assertAll(ViewSource.OTHER, List.of("example.com", "sub.blog.example.com", "evil-blog.example.com"));

        // SITE_URL with a port and path, written with www: still just the host, with and without www.
        ViewSourceClassifier withWww = new ViewSourceClassifier("https://www.example.com:8443/blog/");
        assertThat(withWww.classify("example.com")).isEqualTo(ViewSource.INTERNAL);
        assertThat(withWww.classify("www.example.com")).isEqualTo(ViewSource.INTERNAL);
        // A site on github.io: a view from itself is internal, from another github.io page it is github.
        ViewSourceClassifier onGithubPages = new ViewSourceClassifier("https://me.github.io");
        assertThat(onGithubPages.classify("me.github.io")).isEqualTo(ViewSource.INTERNAL);
        assertThat(onGithubPages.classify("other.github.io")).isEqualTo(ViewSource.GITHUB);
        // SITE_URL empty, broken or IPv6: there is no internal group.
        for (String siteUrl : Arrays.asList(null, "", "khong phai url", "http://[::1]:3000")) {
            assertThat(new ViewSourceClassifier(siteUrl).classify("localhost"))
                    .as(siteUrl)
                    .isEqualTo(ViewSource.OTHER);
        }
    }

    @Test
    void matching_is_by_dot_boundary_not_substring() {
        assertAll(
                ViewSource.OTHER,
                List.of(
                        "notgoogle.com",
                        "evilgoogle.com",
                        "mygoogle.co.uk",
                        "google.com.evil.io",
                        "google.com.vn.evil.com",
                        "google-com.evil.net",
                        "notfacebook.com",
                        "facebook.com.evil.net",
                        "at.me",
                        "github.com.evil.io",
                        "fakegithub.io",
                        "example.org"));
    }

    @Test
    void value_with_scheme_path_query_port_or_odd_characters_is_other() {
        assertAll(
                ViewSource.OTHER,
                List.of(
                        "https://evil/x?y",
                        "javascript:alert(1)",
                        "google.com/search?q=",
                        "https://www.google.com/",
                        "google.com:443",
                        "google.com?q=1",
                        "google.com#x",
                        "[::1]",
                        "::1",
                        "goo gle.com",
                        "google..com",
                        ".google.com",
                        "-google.com",
                        "google-.com",
                        "google.com..",
                        "google.com,t.co",
                        "user@google.com",
                        "%67oogle.com",
                        "<script>.com"));
        // Non-ASCII is malformed, including characters that lowercase to ASCII (Kelvin K becomes k): checked before
        // lowercasing.
        assertThat(classifier.classify((char) 0x212A + "akao.com")).isEqualTo(ViewSource.OTHER);
        assertThat(classifier.classify("b" + (char) 0xFC + "cher.de")).isEqualTo(ViewSource.OTHER);
        assertThat(classifier.classify("google" + (char) 0x3002 + "com")).isEqualTo(ViewSource.OTHER);
    }

    @Test
    void ip_and_punycode_idn_are_valid_hosts_but_belong_to_no_group() {
        assertAll(ViewSource.OTHER, List.of("192.168.1.10", "127.0.0.1", "xn--bcher-kva.de", "xn--80ak6aa92e.com"));
    }

    @Test
    void at_most_253_characters_and_63_per_label() {
        String prefix = "a".repeat(60) + "." + "b".repeat(60) + "." + "c".repeat(60) + ".";
        String longest = prefix + "d".repeat(59) + ".google.com";
        assertThat(longest).hasSize(253);
        assertThat(classifier.classify(longest)).isEqualTo(ViewSource.SEARCH);
        assertThat(classifier.classify(longest + ".")).isEqualTo(ViewSource.SEARCH);

        assertThat(classifier.classify(prefix + "d".repeat(60) + ".google.com")).isEqualTo(ViewSource.OTHER);
        assertThat(classifier.classify("a".repeat(63) + ".google.com")).isEqualTo(ViewSource.SEARCH);
        assertThat(classifier.classify("a".repeat(64) + ".google.com")).isEqualTo(ViewSource.OTHER);
        assertThat(classifier.classify("google.com" + ".x".repeat(5_000))).isEqualTo(ViewSource.OTHER);
    }

    private void assertAll(ViewSource expected, List<String> hosts) {
        for (String host : hosts) {
            assertThat(classifier.classify(host)).as("%s", host).isEqualTo(expected);
        }
    }
}
