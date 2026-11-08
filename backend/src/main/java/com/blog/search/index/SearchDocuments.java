package com.blog.search.index;

import com.blog.common.security.SeedAdmin;
import com.blog.post.mapper.PostMapper;
import com.blog.search.service.SearchItems;
import com.blog.search.service.StaticSearchContent;
import java.lang.reflect.RecordComponent;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Mapper from sources to {@link SearchDocument} for every type. Every text field has the private-use range U+E000-U+F8FF
 * stripped ({@link SearchText#stripPrivateUse}), the id is checked against Meilisearch's rule (one bad id fails the whole
 * batch), and {@code contentHash} is computed last over every other field.
 *
 * Accepts only data that already passed the visibility rules of {@link SearchDocumentSource}: the mapper knows nothing
 * about status.
 */
public final class SearchDocuments {

    /** Meilisearch id rule: letters, digits, {@code -}, {@code _}, under 512 bytes. */
    public static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,511}");

    private static final List<RecordComponent> HASHED = List.of(SearchDocument.class.getRecordComponents()).stream()
            .filter(component -> !component.getName().equals("contentHash"))
            .toList();

    private SearchDocuments() {}

    public record TagRef(String name, String slug) {}

    /** A published post of an ACTIVE author; {@code tags} by name. */
    public record PostRow(
            UUID id,
            String slug,
            String title,
            String excerpt,
            String content,
            Instant publishedAt,
            String categoryName,
            String categorySlug,
            String seriesTitle,
            String seriesSlug,
            UUID authorId,
            String authorName,
            String authorSlug,
            List<TagRef> tags,
            String language) {}

    /**
     * A category, tag or series that has a published post; {@code name} is the title for a series, {@code description} is
     * null for a tag. {@code languages} are the languages of those published posts.
     */
    public record TaxonRow(UUID id, String name, String slug, String description, List<String> languages) {}

    /** {@code languages} are the languages of the author's published posts. */
    public record AuthorRow(UUID id, String displayName, String publicSlug, List<String> languages) {}

    /** An author who is the site owner carries the site's name, like the author line and JSON-LD of the frontend. */
    public static SearchDocument post(PostRow row, StaticSearchContent.Owner owner) {
        String excerpt = row.excerpt() == null ? "" : row.excerpt().strip();
        List<TagRef> tags = row.tags().stream()
                .sorted(Comparator.comparing(TagRef::name).thenComparing(TagRef::slug))
                .toList();
        return build(
                DocType.POST,
                row.id().toString(),
                row.slug(),
                SearchItems.postHref(row.slug()),
                row.title(),
                excerpt.isEmpty() ? null : excerpt,
                emptyToNull(MarkdownText.plain(row.content())),
                tags.stream().map(TagRef::name).toList(),
                tags.stream().map(TagRef::slug).toList(),
                row.categoryName(),
                row.categorySlug(),
                row.seriesTitle(),
                row.seriesSlug(),
                SeedAdmin.ID.equals(row.authorId()) ? owner.name() : row.authorName(),
                row.authorSlug(),
                row.publishedAt() == null ? null : row.publishedAt().toEpochMilli(),
                PostMapper.readingMinutes(row.content()),
                row.language());
    }

    public static SearchDocument category(TaxonRow row) {
        return taxon(DocType.CATEGORY, row, SearchItems.categoryHref(row.slug()));
    }

    public static SearchDocument tag(TaxonRow row) {
        return taxon(DocType.TAG, row, SearchItems.tagHref(row.slug()));
    }

    public static SearchDocument series(TaxonRow row) {
        return taxon(DocType.SERIES, row, SearchItems.seriesHref(row.slug()));
    }

    /** The site owner goes to {@code /about} with the site's name; anyone else goes to the profile {@code /u/<slug>}. */
    public static SearchDocument author(AuthorRow row, StaticSearchContent.Owner owner) {
        boolean isOwner = SeedAdmin.ID.equals(row.id());
        return build(
                DocType.AUTHOR,
                row.id().toString(),
                row.publicSlug(),
                isOwner ? owner.href() : SearchItems.authorHref(row.publicSlug()),
                isOwner ? owner.name() : row.displayName(),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                languages(row.languages()));
    }

    public static SearchDocument caseStudy(StaticSearchContent.CaseStudy study) {
        return build(
                DocType.CASE_STUDY,
                study.slug(),
                study.slug(),
                study.href(),
                study.title(),
                emptyToNull(study.summary()),
                emptyToNull(study.body()),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null);
    }

    public static SearchDocument page(StaticSearchContent.Page page) {
        return build(
                DocType.PAGE,
                page.slug(),
                page.slug(),
                page.href(),
                page.title(),
                emptyToNull(page.description()),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null);
    }

    private static SearchDocument taxon(DocType type, TaxonRow row, String href) {
        return build(
                type,
                row.id().toString(),
                row.slug(),
                href,
                row.name(),
                emptyToNull(row.description()),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                languages(row.languages()));
    }

    private static SearchDocument build(
            DocType type,
            String sourceId,
            String slug,
            String href,
            String title,
            String excerpt,
            String body,
            List<String> tags,
            List<String> tagSlugs,
            String category,
            String categorySlug,
            String series,
            String seriesSlug,
            String author,
            String authorSlug,
            Long publishedAt,
            Integer readingMinutes,
            Object language) {
        String id = type.documentId(sourceId);
        if (sourceId == null || sourceId.isEmpty() || !ID.matcher(id).matches()) {
            throw new IllegalArgumentException("Search document id is not valid for " + type.value());
        }
        SearchDocument document = new SearchDocument(
                id,
                type.value(),
                sourceId,
                slug,
                href,
                clean(title),
                clean(excerpt),
                clean(body),
                clean(tags),
                tagSlugs,
                clean(category),
                categorySlug,
                clean(series),
                seriesSlug,
                clean(author),
                authorSlug,
                publishedAt,
                readingMinutes,
                language,
                null);
        return new SearchDocument(
                document.id(),
                document.type(),
                document.sourceId(),
                document.slug(),
                document.href(),
                document.title(),
                document.excerpt(),
                document.body(),
                document.tags(),
                document.tagSlugs(),
                document.category(),
                document.categorySlug(),
                document.series(),
                document.seriesSlug(),
                document.author(),
                document.authorSlug(),
                document.publishedAt(),
                document.readingMinutes(),
                document.language(),
                contentHash(document));
    }

    /**
     * SHA-256 (hex) of every field except itself, in the record's declaration order, each value tagged with its kind and
     * length: two different documents cannot give the same input string. Stable across runs and across Jackson versions.
     */
    public static String contentHash(SearchDocument document) {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is not available", e);
        }
        for (RecordComponent component : HASHED) {
            Object value;
            try {
                value = component.getAccessor().invoke(document);
            } catch (ReflectiveOperationException e) {
                throw new IllegalStateException("Cannot read " + component.getName(), e);
            }
            feed(digest, component.getName());
            feed(digest, value);
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static void feed(MessageDigest digest, Object value) {
        switch (value) {
            case null -> digest.update((byte) 'N');
            case String text -> {
                byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
                digest.update((byte) 'S');
                digest.update(Integer.toString(bytes.length).getBytes(StandardCharsets.US_ASCII));
                digest.update((byte) ':');
                digest.update(bytes);
            }
            case List<?> list -> {
                digest.update((byte) 'L');
                digest.update(Integer.toString(list.size()).getBytes(StandardCharsets.US_ASCII));
                digest.update((byte) ':');
                list.forEach(item -> feed(digest, item));
            }
            case Number number -> {
                digest.update((byte) 'I');
                digest.update(number.toString().getBytes(StandardCharsets.US_ASCII));
                digest.update((byte) ';');
            }
            default ->
                throw new IllegalStateException(
                        "Unexpected field type " + value.getClass().getSimpleName());
        }
    }

    /** Sorted and distinct so that the hash does not depend on the query order; null (absent) when there is none. */
    private static List<String> languages(List<String> languages) {
        if (languages == null || languages.isEmpty()) {
            return null;
        }
        return languages.stream().distinct().sorted().toList();
    }

    private static String clean(String text) {
        return SearchText.stripPrivateUse(text);
    }

    private static List<String> clean(List<String> texts) {
        return texts == null
                ? null
                : texts.stream().map(SearchText::stripPrivateUse).toList();
    }

    private static String emptyToNull(String text) {
        return text == null || text.isEmpty() ? null : text;
    }
}
