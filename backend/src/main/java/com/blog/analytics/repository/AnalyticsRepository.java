package com.blog.analytics.repository;

import com.blog.analytics.dto.AnalyticsResponse.AnalyticsTopPost;
import com.blog.analytics.service.ViewSource;
import com.blog.post.entity.PostStatus;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Read queries of the view report. A null {@code authorId} means the whole site (ADMIN); otherwise only that author's
 * posts, filtered in the SQL itself. The query shape follows the V30 EXPLAIN: the whole site uses the {@code (day)} index,
 * one author uses the primary key {@code (post_id, day, source)} through each of their posts.
 */
@Repository
@RequiredArgsConstructor
public class AnalyticsRepository {

    private static final String SERIES = """
            select d.day, d.source, cast(sum(d.views) as bigint) as views
            from post_view_daily d
            where d.day between ? and ?%s
            group by d.day, d.source""";
    private static final String TOP_POSTS = """
            select p.id, p.slug, p.title, p.status, cast(sum(d.views) as bigint) as views
            from post_view_daily d join posts p on p.id = d.post_id
            where d.day between ? and ?%s
            group by p.id
            order by views desc, p.title, p.id
            limit ?""";
    private static final String DAILY_OF_AUTHOR =
            " and d.post_id in (select p.id from posts p where p.author_id = ? and p.deleted_at is null)";
    private static final String POST_OF_AUTHOR = " and p.author_id = ? and p.deleted_at is null";
    private static final String SINCE = "select min(d.day) from post_view_daily d";
    private static final String SINCE_OF_AUTHOR = """
            select min(f.first_day) from posts p
            cross join lateral (select min(d.day) as first_day from post_view_daily d where d.post_id = p.id) f
            where p.author_id = ? and p.deleted_at is null""";
    private static final String ALL_TIME = "select cast(coalesce(sum(v.view_count), 0) as bigint) from post_views v";
    private static final String ALL_TIME_OF_AUTHOR = """
            select cast(coalesce(sum(v.view_count), 0) as bigint)
            from post_views v join posts p on p.id = v.post_id
            where p.author_id = ? and p.deleted_at is null""";

    private final JdbcTemplate jdbcTemplate;

    /** One cell of the (day, source group) table; a cell with no views has no row. */
    public record DaySourceViews(LocalDate day, ViewSource source, long views) {}

    public List<DaySourceViews> viewsByDayAndSource(LocalDate from, LocalDate to, UUID authorId) {
        return jdbcTemplate.query(
                SERIES.formatted(authorId == null ? "" : DAILY_OF_AUTHOR),
                (rs, row) -> new DaySourceViews(
                        rs.getObject("day", LocalDate.class),
                        ViewSource.fromValue(rs.getString("source")),
                        rs.getLong("views")),
                args(authorId, from, to).toArray());
    }

    public List<AnalyticsTopPost> topPosts(LocalDate from, LocalDate to, UUID authorId, int limit) {
        List<Object> args = args(authorId, from, to);
        args.add(limit);
        return jdbcTemplate.query(
                TOP_POSTS.formatted(authorId == null ? "" : POST_OF_AUTHOR),
                (rs, row) -> new AnalyticsTopPost(
                        rs.getObject("id", UUID.class),
                        rs.getString("slug"),
                        rs.getString("title"),
                        PostStatus.valueOf(rs.getString("status")),
                        rs.getLong("views")),
                args.toArray());
    }

    /** First day with per-day data; null when there are no rows. */
    public LocalDate since(UUID authorId) {
        return authorId == null
                ? jdbcTemplate.queryForObject(SINCE, LocalDate.class)
                : jdbcTemplate.queryForObject(SINCE_OF_AUTHOR, LocalDate.class, authorId);
    }

    public long allTimeViews(UUID authorId) {
        Long total = authorId == null
                ? jdbcTemplate.queryForObject(ALL_TIME, Long.class)
                : jdbcTemplate.queryForObject(ALL_TIME_OF_AUTHOR, Long.class, authorId);
        return total == null ? 0 : total;
    }

    private static List<Object> args(UUID authorId, LocalDate from, LocalDate to) {
        List<Object> args = new ArrayList<>(List.of(from, to));
        if (authorId != null) {
            args.add(authorId);
        }
        return args;
    }
}
