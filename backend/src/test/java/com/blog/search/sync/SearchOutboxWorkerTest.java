package com.blog.search.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.search.config.SearchProperties;
import com.blog.search.index.DocType;
import com.blog.search.index.SearchDocument;
import com.blog.search.index.SearchDocumentSource;
import com.blog.search.index.SearchDocuments;
import com.blog.search.index.SearchIndexer;
import com.blog.search.meili.MeiliException;
import com.blog.search.service.SearchMetrics;
import com.blog.search.service.StaticSearchContent;
import com.blog.search.sync.SearchOutboxRepository.Claimed;
import com.blog.search.sync.SearchOutboxWorker.RunSummary;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * A document rejected by Meilisearch fails the task of the whole batch: the worker resends document by document, so
 * only that document's row fails (retry, then FAILED) and the other rows finish. No DB, no engine: every collaborator
 * is a fake.
 */
class SearchOutboxWorkerTest {

    private static final String INDEX = "content_v1";

    private final SearchOutboxRepository repository = mock(SearchOutboxRepository.class);
    private final StaticSearchContent staticContent = mock(StaticSearchContent.class);
    private final SearchIndexer indexer = mock(SearchIndexer.class);
    private final Clock clock = Clock.fixed(Instant.parse("2026-10-11T08:00:00Z"), ZoneOffset.UTC);
    private final SearchOutboxWorker worker = new SearchOutboxWorker(
            repository,
            mock(SearchDocumentSource.class),
            staticContent,
            indexer,
            new SearchProperties(
                    SearchProperties.Engine.POSTGRES,
                    new SearchProperties.Meili(
                            "http://meilisearch:7700",
                            "k".repeat(40),
                            INDEX,
                            Duration.ofMillis(500),
                            Duration.ofMillis(800),
                            Duration.ofSeconds(10))),
            new SearchMetrics(clock),
            mock(PlatformTransactionManager.class),
            clock);

    @Test
    void failed_batch_task_resends_document_by_document_and_only_broken_documents_row_fails() {
        List<StaticSearchContent.Page> pages = List.of(page("a"), page("b"), page("c"));
        when(staticContent.pages()).thenReturn(pages);
        List<SearchDocument> documents =
                pages.stream().map(SearchDocuments::page).toList();
        when(repository.claim(any(), any(), anyInt()))
                .thenReturn(List.of(
                        new Claimed(1, DocType.PAGE, "a", 0, null),
                        new Claimed(2, DocType.PAGE, "b", 0, null),
                        new Claimed(3, DocType.PAGE, "c", 0, null)));
        when(indexer.indexExists(INDEX)).thenReturn(true);
        when(indexer.submitUpsert(INDEX, documents)).thenReturn(10L);
        when(indexer.submitUpsert(INDEX, List.of(documents.get(0)))).thenReturn(11L);
        when(indexer.submitUpsert(INDEX, List.of(documents.get(1)))).thenReturn(12L);
        when(indexer.submitUpsert(INDEX, List.of(documents.get(2)))).thenReturn(13L);
        doThrow(new MeiliException(MeiliException.Code.TASK_FAILED, "invalid_document_fields"))
                .when(indexer)
                .await(eq(10L), any());
        doThrow(new MeiliException(MeiliException.Code.TASK_FAILED, "invalid_document_fields"))
                .when(indexer)
                .await(eq(12L), any());

        assertThat(worker.runOnce()).isEqualTo(new RunSummary(2, 1));

        // Each row's task is recorded before waiting, like the batch; rows a and c finish, only b fails with a safe
        // code.
        verify(repository).recordTask(eq(List.of(1L, 2L, 3L)), any(), eq(10L), any());
        verify(repository).recordTask(eq(List.of(2L)), any(), eq(12L), any());
        verify(repository).delete(eq(List.of(1L)), any());
        verify(repository).delete(eq(List.of(3L)), any());
        verify(repository).fail(eq(List.of(2L)), any(), eq("TASK_FAILED"), any(), any(), any(), anyInt());
        verify(repository, never()).fail(eq(List.of(1L, 2L, 3L)), any(), anyString(), any(), any(), any(), anyInt());
    }

    @Test
    void failed_delete_batch_is_not_resent_document_by_document() {
        when(staticContent.pages()).thenReturn(List.of());
        when(repository.claim(any(), any(), anyInt()))
                .thenReturn(List.of(
                        new Claimed(1, DocType.PAGE, "gone-a", 0, null),
                        new Claimed(2, DocType.PAGE, "gone-b", 0, null)));
        when(indexer.indexExists(INDEX)).thenReturn(true);
        when(indexer.submitDelete(eq(INDEX), any())).thenReturn(20L);
        doThrow(new MeiliException(MeiliException.Code.TASK_FAILED))
                .when(indexer)
                .await(eq(20L), any());

        assertThat(worker.runOnce()).isEqualTo(new RunSummary(0, 2));
        verify(indexer, never()).submitUpsert(anyString(), anyList());
        verify(repository).fail(eq(List.of(1L, 2L)), any(), eq("TASK_FAILED"), any(), any(), any(), anyInt());
    }

    private static StaticSearchContent.Page page(String slug) {
        return new StaticSearchContent.Page(slug, "/" + slug, "Trang " + slug, null);
    }
}
