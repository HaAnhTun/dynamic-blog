package com.blog.analytics.service;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Maps the host of the page that led to a post (header {@code X-View-Referrer}, sent by the Next route, not trusted)
 * to a {@link ViewSource}. The host is never kept: only the group is recorded.
 *
 * <p>A valid host: after trimming, only ASCII letters, digits, dots and hyphens, one trailing dot dropped, at most 253
 * characters, each label 1-63 characters and neither starting nor ending with a hyphen; compared case-insensitively.
 * Not sent or empty is {@code direct}; malformed (scheme, path, query, port, IPv6, Unicode...) is {@code other}. IDNs
 * travel as punycode ({@code xn--}). A group matches when the host is exactly a domain in its list or a subdomain of it
 * (by dot boundary, never by substring: {@code notgoogle.com} is {@code other}).
 *
 * <p>Order: {@code internal} (the host of {@code SITE_URL}, with and without {@code www.}), {@code search},
 * {@code social}, {@code github}, everything else {@code other}. The lists below are the complete rules.
 */
public final class ViewSourceClassifier {

    static final int MAX_HOST_LENGTH = 253;

    /** google.* and yandex.*: the brand name plus a country suffix (google.com, google.de, google.com.vn, google.co.uk). */
    private static final Pattern SEARCH_BRANDS =
            Pattern.compile("(?:^|\\.)(?:google|yandex)\\.(?:[a-z]{2,}|com?\\.[a-z]{2})$");

    private static final List<String> SEARCH = List.of(
            "bing.com",
            "duckduckgo.com",
            "search.yahoo.com",
            "baidu.com",
            "ecosia.org",
            "coccoc.com",
            "search.brave.com",
            "startpage.com",
            "qwant.com",
            "kagi.com");

    private static final List<String> SOCIAL = List.of(
            "facebook.com",
            "fb.com",
            "fb.me",
            "messenger.com",
            "instagram.com",
            "threads.net",
            "threads.com",
            "t.co",
            "twitter.com",
            "x.com",
            "linkedin.com",
            "lnkd.in",
            "reddit.com",
            "news.ycombinator.com",
            "zalo.me",
            "bsky.app",
            "mastodon.social",
            "youtube.com",
            "youtu.be",
            "tiktok.com",
            "t.me",
            "discord.com",
            "pinterest.com");

    private static final List<String> GITHUB = List.of("github.com", "github.io", "githubusercontent.com");

    /** The site's own host, with and without {@code www.}; empty when SITE_URL is blank or yields no host. */
    private final Set<String> siteHosts;

    /** @param siteUrl {@code SITE_URL}; null or blank means there is no {@code internal} group */
    public ViewSourceClassifier(String siteUrl) {
        this.siteHosts = siteHosts(siteUrl);
    }

    public ViewSource classify(String referrerHost) {
        if (referrerHost == null || referrerHost.isBlank()) {
            return ViewSource.DIRECT;
        }
        String host = normalize(referrerHost.strip());
        if (host == null) {
            return ViewSource.OTHER;
        }
        if (siteHosts.contains(host)) {
            return ViewSource.INTERNAL;
        }
        if (SEARCH_BRANDS.matcher(host).find() || matchesAny(host, SEARCH)) {
            return ViewSource.SEARCH;
        }
        if (matchesAny(host, SOCIAL)) {
            return ViewSource.SOCIAL;
        }
        if (matchesAny(host, GITHUB)) {
            return ViewSource.GITHUB;
        }
        return ViewSource.OTHER;
    }

    /** The normalized host (lowercase, no trailing dot), or null when malformed. */
    static String normalize(String value) {
        if (value.length() > MAX_HOST_LENGTH + 1) {
            return null;
        }
        // Check characters before lowercasing: some non-ASCII characters lowercase to ASCII letters (Kelvin sign K
        // becomes k).
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean allowed =
                    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-';
            if (!allowed) {
                return null;
            }
        }
        String host = value.toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1);
        }
        if (host.isEmpty() || host.length() > MAX_HOST_LENGTH) {
            return null;
        }
        for (String label : host.split("\\.", -1)) {
            if (label.isEmpty() || label.length() > 63 || label.startsWith("-") || label.endsWith("-")) {
                return null;
            }
        }
        return host;
    }

    private static boolean matchesAny(String host, List<String> domains) {
        for (String domain : domains) {
            if (host.equals(domain) || host.endsWith("." + domain)) {
                return true;
            }
        }
        return false;
    }

    private static Set<String> siteHosts(String siteUrl) {
        if (siteUrl == null || siteUrl.isBlank()) {
            return Set.of();
        }
        String host;
        try {
            host = new URI(siteUrl.strip()).getHost();
        } catch (URISyntaxException e) {
            return Set.of();
        }
        host = host == null ? null : normalize(host);
        if (host == null) {
            return Set.of();
        }
        String bare = host.startsWith("www.") ? host.substring("www.".length()) : host;
        return Set.of(bare, "www." + bare);
    }
}
