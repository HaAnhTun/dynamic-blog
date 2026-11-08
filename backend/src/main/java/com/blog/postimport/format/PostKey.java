package com.blog.postimport.format;

import java.util.Arrays;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * The fixed list of front matter keys of a post file. A problem names its key by one of these, never by what the file
 * wrote. {@code featured} and {@code status} are read and then ignored by the import. The three series keys are read for
 * everybody and used for an administrator only.
 */
public enum PostKey {
    TITLE("title"),
    SLUG("slug"),
    LANGUAGE("language"),
    EXCERPT("excerpt"),
    CATEGORY("category"),
    TAGS("tags"),
    FEATURED("featured"),
    STATUS("status"),
    TRANSLATION_OF("translation_of"),
    SERIES("series"),
    SERIES_PART("series_part"),
    SERIES_DESCRIPTION("series_description"),
    COVER("cover"),
    COVER_ALT("cover_alt");

    private static final Map<String, PostKey> BY_NAME =
            Arrays.stream(values()).collect(Collectors.toUnmodifiableMap(PostKey::keyName, Function.identity()));

    private final String keyName;

    PostKey(String keyName) {
        this.keyName = keyName;
    }

    /** The key as written in the file, for example {@code translation_of}. */
    public String keyName() {
        return keyName;
    }

    /** The key written exactly like this (case matters), or null when the format has no such key. */
    public static PostKey byName(String name) {
        return BY_NAME.get(name);
    }
}
