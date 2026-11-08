package com.blog.analytics.service;

import com.blog.analytics.config.AnalyticsProperties;
import com.blog.analytics.dto.AnalyticsResponse;
import com.blog.analytics.dto.AnalyticsResponse.AnalyticsDay;
import com.blog.analytics.dto.AnalyticsResponse.AnalyticsSource;
import com.blog.analytics.dto.AnalyticsResponse.AnalyticsTotals;
import com.blog.analytics.repository.AnalyticsRepository;
import com.blog.analytics.repository.AnalyticsRepository.DaySourceViews;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.time.Clock;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/**
 * View report over a date range. "Today" and the day boundary follow the analytics time zone, with the same rule as
 * when writing (PostViewService).
 *
 * Range: a missing {@code to} means today, a missing {@code from} means the 30 days ending at {@code to}. Rejected (400)
 * when {@code from} is after {@code to}, the range exceeds 366 days, or {@code to} is after today: a day that has not
 * come yet only has zeros, which would be drawn as if views had dropped.
 */
@Service
public class AnalyticsService {

    static final int DEFAULT_DAYS = 30;
    static final int MAX_DAYS = 366;
    static final int TOP_POSTS = 10;

    private final AnalyticsRepository repository;
    private final AnalyticsProperties properties;
    private final Clock clock;

    public AnalyticsService(AnalyticsRepository repository, AnalyticsProperties properties, Clock clock) {
        this.repository = repository;
        this.properties = properties;
        this.clock = clock;
    }

    /**
     * @param authorScope null means the whole site (ADMIN); otherwise only that author's posts, any status
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the date range is invalid
     */
    // One snapshot for all four queries: the numbers of a single report always agree with each other.
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public AnalyticsResponse report(LocalDate from, LocalDate to, UUID authorScope) {
        LocalDate today = properties.today(clock);
        LocalDate end = to == null ? today : to;
        LocalDate start = from == null ? end.minusDays(DEFAULT_DAYS - 1) : from;
        if (end.isAfter(today)) {
            throw invalid("to must not be after today (" + properties.timeZone() + ")");
        }
        if (start.isAfter(end)) {
            throw invalid("from must not be after to");
        }
        if (ChronoUnit.DAYS.between(start, end) >= MAX_DAYS) {
            throw invalid("The range may cover at most " + MAX_DAYS + " days");
        }

        Map<LocalDate, Long> byDay = new HashMap<>();
        Map<ViewSource, Long> bySource = new EnumMap<>(ViewSource.class);
        long total = 0;
        for (DaySourceViews cell : repository.viewsByDayAndSource(start, end, authorScope)) {
            byDay.merge(cell.day(), cell.views(), Long::sum);
            bySource.merge(cell.source(), cell.views(), Long::sum);
            total += cell.views();
        }
        List<AnalyticsDay> daily = start.datesUntil(end.plusDays(1))
                .map(day -> new AnalyticsDay(day, byDay.getOrDefault(day, 0L)))
                .toList();
        List<AnalyticsSource> sources = Arrays.stream(ViewSource.values())
                .map(source -> new AnalyticsSource(source.value(), bySource.getOrDefault(source, 0L)))
                .toList();

        return new AnalyticsResponse(
                start,
                end,
                properties.timeZone(),
                repository.since(authorScope),
                new AnalyticsTotals(total, repository.allTimeViews(authorScope)),
                daily,
                repository.topPosts(start, end, authorScope, TOP_POSTS),
                sources);
    }

    private static ApiException invalid(String message) {
        return new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, message);
    }
}
