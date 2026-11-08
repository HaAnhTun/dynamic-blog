package com.blog.search.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.search.config.SearchProperties;
import com.blog.search.config.SearchProperties.Engine;
import com.blog.search.dto.SearchGroup;
import com.blog.search.dto.SearchItem;
import com.blog.search.dto.SearchResponse;
import com.blog.search.dto.Segment;
import com.blog.search.meili.MeiliException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.springframework.http.HttpStatus;

/**
 * Engine selection and falling back to Postgres: a broken engine gives {@code degraded: true} with Postgres results,
 * counted again; bad parameters are 400 without calling any engine; "no results" is never degraded; a deep page
 * answered by Postgres is not degraded; the postgres configuration never calls Meilisearch. Fake (mock) engine.
 */
class SearchServiceTest {

    private static final Instant NOW = Instant.parse("2026-10-11T03:00:00Z");
    private static final ClientAddress CLIENT =
            ClientAddress.parse("203.0.113.9").orElseThrow();

    private final RateLimiter rateLimiter = mock(RateLimiter.class);
    private final PostgresSearchProvider postgres = mock(PostgresSearchProvider.class);
    private final MeiliSearchProvider meili = mock(MeiliSearchProvider.class);
    private final SearchMetrics metrics = new SearchMetrics(Clock.fixed(NOW, ZoneOffset.UTC));

    private static final List<SearchGroup> PG_GROUPS = List.of(new SearchGroup(
            SearchType.POST,
            1,
            List.of(new SearchItem(
                    "post:tu-postgres",
                    List.of(new Segment("From Postgres", false)),
                    null,
                    "/posts/tu-postgres",
                    null,
                    null))));
    private static final List<SearchGroup> MEILI_GROUPS = List.of(new SearchGroup(
            SearchType.POST,
            1,
            List.of(new SearchItem(
                    "post:tu-meili", List.of(new Segment("From Meili", true)), null, "/posts/tu-meili", null, null))));

    private SearchService service(Engine engine) {
        SearchProperties properties = new SearchProperties(
                engine,
                new SearchProperties.Meili(
                        "http://meili.test",
                        "k".repeat(32),
                        "content_v1",
                        Duration.ofMillis(500),
                        Duration.ofMillis(800),
                        Duration.ofSeconds(10)));
        return new SearchService(properties, rateLimiter, postgres, meili, metrics);
    }

    @Test
    void meilisearch_answering_means_engine_is_meilisearch_not_degraded() {
        when(meili.search(any())).thenReturn(MEILI_GROUPS);

        SearchResponse response =
                service(Engine.MEILISEARCH).search("spring", "all", null, 0, 10, null, null, null, CLIENT);

        assertThat(response.engine()).isEqualTo(Engine.MEILISEARCH);
        assertThat(response.degraded()).isFalse();
        assertThat(response.groups()).isEqualTo(MEILI_GROUPS);
        verifyNoInteractions(postgres);
    }

    @Test
    void broken_engine_gives_postgres_results_degraded_and_counted() {
        for (MeiliException.Code code : List.of(
                MeiliException.Code.CONNECTION_FAILED,
                MeiliException.Code.TIMEOUT,
                MeiliException.Code.SERVER_ERROR,
                MeiliException.Code.UNAVAILABLE,
                MeiliException.Code.INDEX_NOT_FOUND,
                MeiliException.Code.INVALID_API_KEY,
                MeiliException.Code.NOT_CONFIGURED)) {
            doThrow(new MeiliException(code)).when(meili).search(any());
            when(postgres.search(any())).thenReturn(PG_GROUPS);

            SearchResponse response =
                    service(Engine.MEILISEARCH).search("spring", "all", null, 0, 10, null, null, null, CLIENT);

            assertThat(response.engine()).as(code.name()).isEqualTo(Engine.POSTGRES);
            assertThat(response.degraded()).isTrue();
            assertThat(response.groups()).isEqualTo(PG_GROUPS);
            assertThat(metrics.snapshot().lastFailure()).isEqualTo(code);
        }
        assertThat(metrics.snapshot().degradedRequests()).isEqualTo(7);
        assertThat(metrics.snapshot().lastDegradedAt()).isEqualTo(NOW);
    }

    @Test
    void no_results_is_never_degraded() {
        when(meili.search(any())).thenReturn(List.of());

        SearchResponse response =
                service(Engine.MEILISEARCH).search("khongcogi", "post", null, 0, 10, null, null, null, CLIENT);

        assertThat(response.degraded()).isFalse();
        assertThat(response.engine()).isEqualTo(Engine.MEILISEARCH);
        assertThat(response.groups()).isEmpty();
        verifyNoInteractions(postgres);
        assertThat(metrics.snapshot().degradedRequests()).isZero();
    }

    @Test
    void bad_parameters_are_400_before_any_engine() {
        SearchService service = service(Engine.MEILISEARCH);
        String tooLong = "a".repeat(201);
        assertThatThrownBy(() -> service.search(tooLong, "all", null, 0, 10, null, null, null, CLIENT))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> service.search("spring", "bai-viet", null, 0, 10, null, null, null, CLIENT))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> service.search("spring", "topic", null, 0, 10, "java", null, null, CLIENT))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> service.search(
                        "spring", "post", null, 0, 10, null, List.of("a", "b", "c", "d", "e", "f"), null, CLIENT))
                .isInstanceOf(ApiException.class);
        verifyNoInteractions(meili, postgres, rateLimiter);
        assertThat(metrics.snapshot().degradedRequests()).isZero();
    }

    @Test
    void a_search_is_counted_against_its_client_address_before_the_shared_ceiling() {
        when(postgres.search(any())).thenReturn(PG_GROUPS);

        service(Engine.POSTGRES).search("spring", "all", null, 0, 10, null, null, null, CLIENT);

        InOrder order = inOrder(rateLimiter);
        order.verify(rateLimiter).check(RateLimiter.SEARCH_CLIENT, CLIENT.key());
        order.verify(rateLimiter).check(RateLimiter.SEARCH, RateLimiter.SEARCH_GLOBAL_KEY);
    }

    @Test
    void a_client_address_over_its_own_quota_is_429_and_does_not_spend_a_turn_of_the_shared_ceiling() {
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "slow down"))
                .when(rateLimiter)
                .check(RateLimiter.SEARCH_CLIENT, CLIENT.key());

        assertThatThrownBy(
                        () -> service(Engine.POSTGRES).search("spring", "all", null, 0, 10, null, null, null, CLIENT))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED));
        verify(rateLimiter, never()).check(RateLimiter.SEARCH, RateLimiter.SEARCH_GLOBAL_KEY);
        verifyNoInteractions(meili, postgres);
    }

    @Test
    void blank_q_without_filters_calls_no_engine() {
        SearchResponse response =
                service(Engine.MEILISEARCH).search("  ", "all", null, 0, 10, null, null, null, CLIENT);
        assertThat(response.groups()).isEmpty();
        assertThat(response.degraded()).isFalse();
        verifyNoInteractions(meili, postgres, rateLimiter);
    }

    @Test
    void postgres_configuration_never_calls_meilisearch() {
        when(postgres.search(any())).thenReturn(PG_GROUPS);

        SearchResponse response =
                service(Engine.POSTGRES).search("spring", "all", null, 0, 10, null, null, null, CLIENT);

        assertThat(response.engine()).isEqualTo(Engine.POSTGRES);
        assertThat(response.degraded()).isFalse();
        verifyNoInteractions(meili);
    }

    @Test
    void page_deeper_than_meilisearch_cap_is_answered_by_postgres_not_degraded() {
        when(postgres.search(any())).thenReturn(PG_GROUPS);
        when(meili.search(any())).thenReturn(MEILI_GROUPS);
        SearchService service = service(Engine.MEILISEARCH);

        // (99 + 1) × 10 = 1000: still within the cap.
        assertThat(service.search("spring", "post", null, 99, 10, null, null, null, CLIENT)
                        .engine())
                .isEqualTo(Engine.MEILISEARCH);
        SearchResponse deep = service.search("spring", "post", null, 100, 10, null, null, null, CLIENT);

        assertThat(deep.engine()).isEqualTo(Engine.POSTGRES);
        assertThat(deep.degraded()).isFalse();
        ArgumentCaptor<SearchRequest> request = ArgumentCaptor.forClass(SearchRequest.class);
        verify(postgres).search(request.capture());
        assertThat(request.getValue().page()).isEqualTo(100);
        assertThat(metrics.snapshot().deepPageFallbacks()).isEqualTo(1);
        assertThat(metrics.snapshot().degradedRequests()).isZero();
    }

    @Test
    void non_engine_error_is_not_swallowed_as_degraded() {
        doThrow(new IllegalStateException("bug")).when(meili).search(any());
        SearchService service = service(Engine.MEILISEARCH);
        assertThatThrownBy(() -> service.search("spring", "all", null, 0, 10, null, null, null, CLIENT))
                .isInstanceOf(IllegalStateException.class);
        verify(postgres, never()).search(any());
    }
}
