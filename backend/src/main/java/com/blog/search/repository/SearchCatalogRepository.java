package com.blog.search.repository;

import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Small lists that Postgres search filters in place: categories, tags, series and authors that have a published post, each
 * one a grouped query with the post count, loading no post body. Public columns only, plus the id (to recognize the site
 * owner and to re-validate Meilisearch results by id; never part of the JSON).
 *
 * The post count of a topic and of a series counts every published post, like {@code /topics}, {@code /series} and the
 * landing page of that row; only the posts and the authors follow the search rule "the author is still ACTIVE".
 *
 * With a {@code language}: only posts in that language count (so a row needs a published post in it, and the post count is
 * per language) and the name and description come from the {@code translations} column, falling back to the base text.
 *
 * The by-id variants: the same query, the same rules, plus {@code id IN (...)}: one query for a whole batch of
 * Meilisearch results, and an id that no longer qualifies is simply absent from the result.
 */
@Repository
public class SearchCatalogRepository {

    private static final String CATEGORIES = """
            select c.id, @NAME@ as name, c.slug, @DESC@ as description, count(*) as posts
            from categories c
            join posts p on p.category_id = c.id
            where p.status = 'PUBLISHED'%s
            group by c.id, c.name, c.slug, c.description
            order by c.name, c.slug""";
    private static final String TAGS = """
            select t.id, @NAME@ as name, t.slug, count(*) as posts
            from tags t
            join post_tags pt on pt.tag_id = t.id
            join posts p on p.id = pt.post_id
            where p.status = 'PUBLISHED'%s
            group by t.id, t.name, t.slug
            order by posts desc, t.name, t.slug""";
    private static final String SERIES = """
            select s.id, @NAME@ as title, s.slug, @DESC@ as description, count(*) as parts
            from series s
            join posts p on p.series_id = s.id
            where p.status = 'PUBLISHED'%s
            group by s.id, s.title, s.slug, s.description
            order by max(p.published_at) desc nulls last, s.title, s.slug""";
    private static final String AUTHORS = """
            select u.id, u.display_name, u.avatar_url, u.public_slug
            from users u
            join posts p on p.author_id = u.id
            where p.status = 'PUBLISHED' and u.status = 'ACTIVE'%s
            group by u.id, u.display_name, u.avatar_url, u.public_slug
            order by max(p.published_at) desc nulls last, u.public_slug""";

    private static final RowMapper<TopicRow> CATEGORY_ROW = (rs, row) -> new TopicRow(
            rs.getObject("id", UUID.class),
            rs.getString("name"),
            rs.getString("slug"),
            rs.getString("description"),
            rs.getInt("posts"));
    private static final RowMapper<TopicRow> TAG_ROW = (rs, row) -> new TopicRow(
            rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("slug"), null, rs.getInt("posts"));
    private static final RowMapper<SeriesRow> SERIES_ROW = (rs, row) -> new SeriesRow(
            rs.getObject("id", UUID.class),
            rs.getString("title"),
            rs.getString("slug"),
            rs.getString("description"),
            rs.getInt("parts"));
    private static final RowMapper<AuthorRow> AUTHOR_ROW = (rs, row) -> new AuthorRow(
            rs.getObject("id", UUID.class),
            rs.getString("display_name"),
            rs.getString("avatar_url"),
            rs.getString("public_slug"));

    private final NamedParameterJdbcTemplate jdbc;

    public SearchCatalogRepository(JdbcTemplate jdbcTemplate) {
        this.jdbc = new NamedParameterJdbcTemplate(jdbcTemplate);
    }

    /** Categories with a published post, by name (the order of {@code GET /api/v1/categories}); {@code language} may be null. */
    public List<TopicRow> categoriesWithPublishedPosts(String language) {
        return query(localized(CATEGORIES, "c", "name", language, true), language, null, null, CATEGORY_ROW);
    }

    public List<TopicRow> categoriesWithPublishedPosts(Collection<UUID> ids, String language) {
        return query(localized(CATEGORIES, "c", "name", language, true), language, "c.id", ids, CATEGORY_ROW);
    }

    /** Tags with a published post, most posts first then by name (like {@code countTags} of the frontend). */
    public List<TopicRow> tagsWithPublishedPosts(String language) {
        return query(localized(TAGS, "t", "name", language, false), language, null, null, TAG_ROW);
    }

    public List<TopicRow> tagsWithPublishedPosts(Collection<UUID> ids, String language) {
        return query(localized(TAGS, "t", "name", language, false), language, "t.id", ids, TAG_ROW);
    }

    /** Series with a published part, most recently published part first then by name (the order of {@code GET /api/v1/series}). */
    public List<SeriesRow> seriesWithPublishedParts(String language) {
        return query(localized(SERIES, "s", "title", language, true), language, null, null, SERIES_ROW);
    }

    public List<SeriesRow> seriesWithPublishedParts(Collection<UUID> ids, String language) {
        return query(localized(SERIES, "s", "title", language, true), language, "s.id", ids, SERIES_ROW);
    }

    /**
     * ACTIVE authors with a published post, most recent post first. Readers (no published post) and suspended users are
     * never present.
     */
    public List<AuthorRow> activeAuthorsWithPublishedPosts(String language) {
        return query(AUTHORS, language, null, null, AUTHOR_ROW);
    }

    public List<AuthorRow> activeAuthorsWithPublishedPosts(Collection<UUID> ids, String language) {
        return query(AUTHORS, language, "u.id", ids, AUTHOR_ROW);
    }

    /** The text of a row in {@code language}, falling back to the base column; the base column when there is no language. */
    private static String localized(String sql, String alias, String nameColumn, String language, boolean description) {
        String withName = sql.replace("@NAME@", text(alias, nameColumn, "name", language));
        return description ? withName.replace("@DESC@", text(alias, "description", "description", language)) : withName;
    }

    private static String text(String alias, String column, String key, String language) {
        String base = alias + "." + column;
        return language == null
                ? base
                : "coalesce(nullif(btrim(" + alias + ".translations -> cast(:lang as text) ->> '" + key + "'), ''), "
                        + base + ")";
    }

    /** Adds the language condition and, when {@code idColumn} is given, the id list; never runs an empty {@code IN ()}. */
    private <T> List<T> query(String sql, String language, String idColumn, Collection<UUID> ids, RowMapper<T> mapper) {
        if (idColumn != null && ids.isEmpty()) {
            return List.of();
        }
        Map<String, Object> params = new HashMap<>();
        StringBuilder extra = new StringBuilder();
        if (language != null) {
            extra.append(" and p.language = :lang");
            params.put("lang", language);
        }
        if (idColumn != null) {
            extra.append(" and ").append(idColumn).append(" in (:ids)");
            params.put("ids", ids);
        }
        return jdbc.query(sql.formatted(extra), params, mapper);
    }

    /** @param description null for a tag */
    public record TopicRow(UUID id, String name, String slug, String description, int posts) {}

    public record SeriesRow(UUID id, String title, String slug, String description, int parts) {}

    public record AuthorRow(UUID id, String displayName, String avatarUrl, String publicSlug) {}
}
