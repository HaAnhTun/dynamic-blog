package com.blog.postimport.dto;

/**
 * Something noteworthy that does not block the file. {@code code} is one of the constants below (the page turns it into a
 * sentence), {@code key} a name of the format or, for {@link #KEY_IGNORED}, the unknown key when it is a plain word, and
 * {@code line} the line of the key; both may be null. Never a value of the file.
 */
public record PostImportNote(String code, String key, Integer line) {

    /** The file names no language: a new post takes the default language of the site. */
    public static final String LANGUAGE_DEFAULTED = "language_defaulted";
    /** The slug came from the file name, not from a {@code slug} key. */
    public static final String SLUG_FROM_FILE_NAME = "slug_from_file_name";
    /** The slug was made from the title (the file has neither a slug key nor a usable file name). */
    public static final String SLUG_FROM_TITLE = "slug_from_title";
    /** The file's {@code featured} differs from the post's state; the import never changes it. */
    public static final String FEATURED_IGNORED = "featured_ignored";
    /** The file's {@code status} differs from the post's status; the import never publishes or unpublishes. */
    public static final String STATUS_IGNORED = "status_ignored";
    /** The file gives a {@code translation_of}: the key is read but this import does not use it. */
    public static final String TRANSLATION_OF_IGNORED = "translation_of_ignored";
    /** The post is published: the change goes live as soon as it is applied. */
    public static final String PUBLISHED_GOES_LIVE = "published_goes_live";
    /** A key the import does not use: one the format does not know, or {@code cover_alt} without a {@code cover}. */
    public static final String KEY_IGNORED = "key_ignored";
    /** The post has no category and the file gives none: it imports as a draft but cannot be published until one is chosen. */
    public static final String CATEGORY_MISSING = "category_missing";
    /** The category does not exist yet and will be created. */
    public static final String CATEGORY_WILL_BE_CREATED = "category_will_be_created";
    /** At least one tag does not exist yet and will be created. */
    public static final String TAGS_WILL_BE_CREATED = "tags_will_be_created";
    /** The series does not exist yet and will be created (administrators only). */
    public static final String SERIES_WILL_BE_CREATED = "series_will_be_created";
    /** The author's series keys are read and checked but not used: only an administrator puts a post in a series. */
    public static final String SERIES_IGNORED_AUTHOR = "series_ignored_author";
    /** The name was found by its slug or by letter case; the series keeps the title it has. */
    public static final String SERIES_TITLE_DIFFERS = "series_title_differs";
    /** A description was given for a series that already has one, or that an earlier file describes; it is not used. */
    public static final String SERIES_DESCRIPTION_IGNORED = "series_description_ignored";
    /** The series exists without a description and this is the first file to give one: the apply fills it in. */
    public static final String SERIES_DESCRIPTION_WILL_BE_SET = "series_description_will_be_set";
    /** An image of a ZIP package that the article does not use: it is not stored. {@code key} is its path in the package, cut. */
    public static final String ASSET_UNUSED = "asset_unused";
    /** The post gets the cover image of the package: a new post, or a post that has no cover. */
    public static final String COVER_WILL_BE_SET = "cover_will_be_set";
    /** The post has a cover that differs from the one of the package: the package wins and the apply replaces it. */
    public static final String COVER_WILL_BE_REPLACED = "cover_will_be_replaced";
}
