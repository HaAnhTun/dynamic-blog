package com.blog.search.index;

import com.blog.search.index.SearchDocuments.AuthorRow;
import com.blog.search.index.SearchDocuments.PostRow;
import com.blog.search.index.SearchDocuments.TagRef;
import com.blog.search.index.SearchDocuments.TaxonRow;
import com.blog.search.service.StaticSearchContent;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Function;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Reads public content for the search index, following the Postgres visibility rules: published posts of ACTIVE authors;
 * categories, tags, series that have a published post; ACTIVE authors with a published post; case studies and static
 * pages. Anything that fails the rules is absent here: the caller (index build, outbox worker) treats it as a document
 * to delete.
 *
 * In capped batches, keyset by id: never holds every post in memory, and each batch is exactly two queries (posts, then
 * the tags of the whole batch), no N+1. No transaction wraps it: each query returns its connection right away, so a
 * {@code sink} that calls Meilisearch between two batches holds no DB connection.
 */
@Component
public class SearchDocumentSource {

    private static final String POSTS = """
            select p.id, p.slug, p.title, p.excerpt, p.content, p.published_at,
                   c.name as category_name, c.slug as category_slug, s.title as series_title, s.slug as series_slug,
                   u.id as author_id, u.display_name, u.public_slug, p.language
            from posts p
            join users u on u.id = p.author_id
            left join categories c on c.id = p.category_id
            left join series s on s.id = p.series_id
            where p.status = 'PUBLISHED' and u.status = 'ACTIVE'%s""";
    private static final String TAGS_OF_POSTS = """
            select pt.post_id, t.name, t.slug
            from post_tags pt
            join tags t on t.id = pt.tag_id
            where pt.post_id in (:ids)""";
    private static final String CATEGORIES = """
            select c.id, c.name, c.slug, c.description,
                   (select array_agg(distinct p.language order by p.language) from posts p
                    where p.category_id = c.id and p.status = 'PUBLISHED') as languages
            from categories c
            where exists (select 1 from posts p where p.category_id = c.id and p.status = 'PUBLISHED')%s""";
    private static final String TAGS = """
            select t.id, t.name, t.slug, null as description,
                   (select array_agg(distinct p.language order by p.language)
                    from post_tags pt join posts p on p.id = pt.post_id
                    where pt.tag_id = t.id and p.status = 'PUBLISHED') as languages
            from tags t
            where exists (select 1 from post_tags pt join posts p on p.id = pt.post_id
                          where pt.tag_id = t.id and p.status = 'PUBLISHED')%s""";
    private static final String SERIES = """
            select s.id, s.title as name, s.slug, s.description,
                   (select array_agg(distinct p.language order by p.language) from posts p
                    where p.series_id = s.id and p.status = 'PUBLISHED') as languages
            from series s
            where exists (select 1 from posts p where p.series_id = s.id and p.status = 'PUBLISHED')%s""";
    private static final String AUTHORS = """
            select u.id, u.display_name, u.public_slug,
                   (select array_agg(distinct p.language order by p.language) from posts p
                    where p.author_id = u.id and p.status = 'PUBLISHED') as languages
            from users u
            where u.status = 'ACTIVE'
              and exists (select 1 from posts p where p.author_id = u.id and p.status = 'PUBLISHED')%s""";

    private final NamedParameterJdbcTemplate jdbc;
    private final StaticSearchContent staticContent;

    public SearchDocumentSource(JdbcTemplate jdbcTemplate, StaticSearchContent staticContent) {
        this.jdbc = new NamedParameterJdbcTemplate(jdbcTemplate);
        this.staticContent = staticContent;
    }

    /** Every public document, type after type, each batch at most {@code batchSize} documents. */
    public void forEachBatch(int batchSize, Consumer<List<SearchDocument>> sink) {
        for (DocType type : DocType.values()) {
            if (!type.fromDatabase()) {
                continue;
            }
            UUID after = null;
            while (true) {
                List<Keyed> batch = query(type, after, batchSize, null);
                if (batch.isEmpty()) {
                    break;
                }
                sink.accept(batch.stream().map(Keyed::document).toList());
                if (batch.size() < batchSize) {
                    break;
                }
                after = batch.getLast().id();
            }
        }
        List<SearchDocument> statics = new ArrayList<>();
        staticContent.caseStudies().forEach(study -> statics.add(SearchDocuments.caseStudy(study)));
        staticContent.pages().forEach(page -> statics.add(SearchDocuments.page(page)));
        for (int from = 0; from < statics.size(); from += batchSize) {
            sink.accept(statics.subList(from, Math.min(from + batchSize, statics.size())));
        }
    }

    /**
     * The documents of these sources that are still public; an id missing from the result is a source that is gone or no
     * longer public (the outbox worker deletes its document). Call with moderate batches: one {@code IN} query for the list.
     */
    public List<SearchDocument> load(DocType type, Collection<UUID> ids) {
        if (!type.fromDatabase()) {
            throw new IllegalArgumentException("Static content is not loaded by id");
        }
        if (ids.isEmpty()) {
            return List.of();
        }
        return query(type, null, ids.size(), ids).stream().map(Keyed::document).toList();
    }

    /**
     * Number of public documents by type ({@link DocType#value()}, in enum order), counted with exactly the same query as
     * {@link #forEachBatch}: the reindex dry run and the status page compare it with the index.
     */
    public Map<String, Long> countByType() {
        Map<String, Long> counts = new LinkedHashMap<>();
        for (DocType type : DocType.values()) {
            long count = switch (type) {
                case CASE_STUDY -> staticContent.caseStudies().size();
                case PAGE -> staticContent.pages().size();
                default ->
                    jdbc.getJdbcTemplate()
                            .queryForObject(
                                    "select count(*) from (" + visible(type).formatted("") + ") as visible",
                                    Long.class);
            };
            counts.put(type.value(), count);
        }
        return counts;
    }

    private static String visible(DocType type) {
        return switch (type) {
            case POST -> POSTS;
            case CATEGORY -> CATEGORIES;
            case TAG -> TAGS;
            case SERIES -> SERIES;
            case AUTHOR -> AUTHORS;
            case CASE_STUDY, PAGE -> throw new IllegalArgumentException("Static content");
        };
    }

    private record Keyed(UUID id, SearchDocument document) {}

    private List<Keyed> query(DocType type, UUID after, int limit, Collection<UUID> ids) {
        String alias = switch (type) {
            case POST -> "p";
            case CATEGORY -> "c";
            case TAG -> "t";
            case SERIES -> "s";
            case AUTHOR -> "u";
            case CASE_STUDY, PAGE -> throw new IllegalArgumentException("Static content");
        };
        Map<String, Object> params = new HashMap<>();
        StringBuilder where = new StringBuilder();
        if (ids != null) {
            where.append(" and ").append(alias).append(".id in (:ids)");
            params.put("ids", ids);
        }
        if (after != null) {
            where.append(" and ").append(alias).append(".id > :after");
            params.put("after", after);
        }
        String sql = visible(type).formatted(where) + " order by " + alias + ".id limit " + limit;
        return switch (type) {
            case POST -> posts(sql, params);
            case CATEGORY -> taxa(sql, params, SearchDocuments::category);
            case TAG -> taxa(sql, params, SearchDocuments::tag);
            case SERIES -> taxa(sql, params, SearchDocuments::series);
            case AUTHOR ->
                jdbc.query(sql, params, (rs, row) -> {
                    AuthorRow author = new AuthorRow(
                            rs.getObject("id", UUID.class),
                            rs.getString("display_name"),
                            rs.getString("public_slug"),
                            languages(rs));
                    return new Keyed(author.id(), SearchDocuments.author(author, staticContent.owner()));
                });
            case CASE_STUDY, PAGE -> throw new IllegalArgumentException("Static content");
        };
    }

    private static List<String> languages(ResultSet rs) throws SQLException {
        Array array = rs.getArray("languages");
        return array == null ? List.of() : List.of((String[]) array.getArray());
    }

    private List<Keyed> taxa(String sql, Map<String, Object> params, Function<TaxonRow, SearchDocument> mapper) {
        return jdbc.query(sql, params, (rs, row) -> {
            TaxonRow taxon = new TaxonRow(
                    rs.getObject("id", UUID.class),
                    rs.getString("name"),
                    rs.getString("slug"),
                    rs.getString("description"),
                    languages(rs));
            return new Keyed(taxon.id(), mapper.apply(taxon));
        });
    }

    /** One query for the posts, one for the tags of the whole batch. */
    private List<Keyed> posts(String sql, Map<String, Object> params) {
        List<PostRow> rows = jdbc.query(sql, params, (rs, row) -> {
            Timestamp published = rs.getTimestamp("published_at");
            return new PostRow(
                    rs.getObject("id", UUID.class),
                    rs.getString("slug"),
                    rs.getString("title"),
                    rs.getString("excerpt"),
                    rs.getString("content"),
                    published == null ? null : published.toInstant(),
                    rs.getString("category_name"),
                    rs.getString("category_slug"),
                    rs.getString("series_title"),
                    rs.getString("series_slug"),
                    rs.getObject("author_id", UUID.class),
                    rs.getString("display_name"),
                    rs.getString("public_slug"),
                    List.of(),
                    rs.getString("language"));
        });
        if (rows.isEmpty()) {
            return List.of();
        }
        Map<UUID, List<TagRef>> tags = new HashMap<>();
        RowCallbackHandler tagRow =
                rs -> tags.computeIfAbsent(rs.getObject("post_id", UUID.class), id -> new ArrayList<>())
                        .add(new TagRef(rs.getString("name"), rs.getString("slug")));
        jdbc.query(TAGS_OF_POSTS, Map.of("ids", rows.stream().map(PostRow::id).toList()), tagRow);
        return rows.stream()
                .map(row -> {
                    PostRow withTags = new PostRow(
                            row.id(),
                            row.slug(),
                            row.title(),
                            row.excerpt(),
                            row.content(),
                            row.publishedAt(),
                            row.categoryName(),
                            row.categorySlug(),
                            row.seriesTitle(),
                            row.seriesSlug(),
                            row.authorId(),
                            row.authorName(),
                            row.authorSlug(),
                            tags.getOrDefault(row.id(), List.of()),
                            row.language());
                    return new Keyed(row.id(), SearchDocuments.post(withTags, staticContent.owner()));
                })
                .toList();
    }
}
