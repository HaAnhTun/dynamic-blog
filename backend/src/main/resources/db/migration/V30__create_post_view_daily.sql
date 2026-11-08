-- V7c: views per (post, day, source group) for the statistics page. It changes the "do not store individual views" decision of V16 while still keeping
-- privacy: only running totals, no row for a single view, no IP, user agent, session or referrer URL. Days follow
-- ANALYTICS_TIME_ZONE; post_views is still the all-time total. Kept indefinitely (D8): at most 6 rows per post per day.
CREATE TABLE post_view_daily (
    post_id UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    day     DATE        NOT NULL,
    source  VARCHAR(16) NOT NULL,
    views   BIGINT      NOT NULL,
    PRIMARY KEY (post_id, day, source),
    CONSTRAINT chk_post_view_daily_source
        CHECK (source IN ('direct', 'search', 'social', 'github', 'internal', 'other')),
    CONSTRAINT chk_post_view_daily_views CHECK (views >= 0)
);
-- The site-wide report filters by a date range while the primary key starts with post_id. EXPLAIN on 1.1 million synthetic rows: 30 days
-- from 7166 down to 168 buffers, the first day with data from 41 ms (full table scan) down to 0.03 ms.
CREATE INDEX idx_post_view_daily_day ON post_view_daily (day);
