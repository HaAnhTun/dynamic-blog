package com.blog.auth.oauth;

import com.blog.common.text.UserText;
import java.math.BigInteger;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * What the blog keeps from a GitHub profile: the numeric id, the login, a sanitized display name and the avatar. There
 * is no email: the blog neither reads nor stores the GitHub email, so the record has no place for it either.
 *
 * {@link #from} is the only place GitHub data enters the DB, so it validates strictly and throws
 * {@link IllegalArgumentException} for any malformed profile; GithubOAuth2UserService turns that error into 401
 * OAUTH_LOGIN_FAILED. Error messages do not copy values: a malformed profile is still a person's data.
 *
 * @param id          numeric id of the GitHub account: the immutable identifier (the login can change, the id cannot)
 * @param login       GitHub username, following GitHub's rules
 * @param displayName sanitized display name, at most {@value #MAX_DISPLAY_NAME_CODE_POINTS} code points
 * @param avatarUrl   avatar on avatars.githubusercontent.com, or null
 */
public record GithubProfile(long id, String login, String displayName, String avatarUrl) {

    /** GitHub's login rule: letters, digits and hyphens, not starting with a hyphen, at most 39 characters. */
    private static final Pattern LOGIN = Pattern.compile("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$");

    static final int MAX_DISPLAY_NAME_CODE_POINTS = 100;
    static final int MAX_AVATAR_URL_LENGTH = 500;
    static final String AVATAR_PREFIX = "https://avatars.githubusercontent.com/";

    /**
     * @param attributes the {@code GET /user} profile from GitHub, as DefaultOAuth2UserService read it
     * @throws IllegalArgumentException when the id is not a positive integer, or the login breaks the rules
     */
    public static GithubProfile from(Map<String, Object> attributes) {
        long id = requireId(attributes.get("id"));
        String login = requireLogin(attributes.get("login"));
        String name = attributes.get("name") instanceof String text ? UserText.cleanName(text) : "";
        String displayName = firstCodePoints(name.isEmpty() ? login : name, MAX_DISPLAY_NAME_CODE_POINTS);
        return new GithubProfile(id, login, displayName, avatarUrl(attributes.get("avatar_url")));
    }

    /**
     * Only whole numbers, and they must fit a {@code long}. {@code Number.longValue()} on a floating-point number or an
     * oversized BigInteger would silently truncate or wrap around, which could yield another person's id.
     */
    private static long requireId(Object raw) {
        long id;
        if (raw instanceof Integer || raw instanceof Long || raw instanceof Short || raw instanceof Byte) {
            id = ((Number) raw).longValue();
        } else if (raw instanceof BigInteger big && big.bitLength() < Long.SIZE) {
            id = big.longValue();
        } else {
            throw new IllegalArgumentException("GitHub profile id is not a whole number");
        }
        if (id <= 0) {
            throw new IllegalArgumentException("GitHub profile id is not positive");
        }
        return id;
    }

    private static String requireLogin(Object raw) {
        if (!(raw instanceof String login) || !LOGIN.matcher(login).matches()) {
            throw new IllegalArgumentException("GitHub profile login does not follow GitHub's rules");
        }
        return login;
    }

    /** Cuts by code point, not by char: never leaves half of an emoji's surrogate pair. */
    private static String firstCodePoints(String value, int max) {
        if (value.codePointCount(0, value.length()) <= max) {
            return value;
        }
        return value.substring(0, value.offsetByCodePoints(0, max)).strip();
    }

    /** Only images on GitHub's avatar host, over https: the frontend shows it without going through Next's image optimizer. */
    private static String avatarUrl(Object raw) {
        if (raw instanceof String url && url.startsWith(AVATAR_PREFIX) && url.length() <= MAX_AVATAR_URL_LENGTH) {
            return url;
        }
        return null;
    }
}
