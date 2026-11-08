package com.blog.search.index;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.search.meili.MeiliException;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.meili.MeiliKeys;
import com.blog.search.meili.MeiliTask;
import com.blog.search.service.StaticSearchContent;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * {@link SearchIndexer#upsertIsolating}: Meilisearch rejecting one document fails the whole batch task, so the build
 * and reconcile passes resend documents one by one; only the broken document is left out. A whole-engine error stops,
 * without resending.
 */
class SearchIndexerTest {

    private static final String INDEX = "content_v1";

    private final MeiliHttpClient client = mock(MeiliHttpClient.class);
    private final SearchIndexer indexer =
            new SearchIndexer(client, mock(MeiliKeys.class), mock(SearchDocumentSource.class));

    private final SearchDocument a = page("a");
    private final SearchDocument b = page("b");
    private final SearchDocument c = page("c");

    @Test
    void rejected_batch_is_resent_document_by_document_and_only_broken_documents_are_returned() {
        when(client.addOrReplaceDocuments(INDEX, List.of(a, b, c))).thenReturn(1L);
        when(client.addOrReplaceDocuments(INDEX, List.of(a))).thenReturn(2L);
        when(client.addOrReplaceDocuments(INDEX, List.of(b))).thenReturn(3L);
        when(client.addOrReplaceDocuments(INDEX, List.of(c))).thenReturn(4L);
        when(client.waitForTask(anyLong(), any())).thenReturn(new MeiliTask(0, "succeeded", null));
        when(client.waitForTask(eq(1L), any()))
                .thenThrow(new MeiliException(MeiliException.Code.TASK_FAILED, "invalid_document_fields"));
        when(client.waitForTask(eq(3L), any()))
                .thenThrow(new MeiliException(MeiliException.Code.TASK_FAILED, "invalid_document_fields"));

        assertThat(indexer.upsertIsolating(INDEX, List.of(a, b, c))).containsExactly(b);
        verify(client).addOrReplaceDocuments(INDEX, List.of(a));
        verify(client).addOrReplaceDocuments(INDEX, List.of(c));
    }

    @Test
    void whole_batch_accepted_means_no_resend_and_single_broken_document_returns_itself() {
        when(client.addOrReplaceDocuments(eq(INDEX), anyList())).thenReturn(1L);
        when(client.waitForTask(eq(1L), any())).thenReturn(new MeiliTask(1, "succeeded", null));
        assertThat(indexer.upsertIsolating(INDEX, List.of(a, b))).isEmpty();
        verify(client, times(1)).addOrReplaceDocuments(eq(INDEX), anyList());

        when(client.addOrReplaceDocuments(INDEX, List.of(c))).thenReturn(5L);
        when(client.waitForTask(eq(5L), any())).thenThrow(new MeiliException(MeiliException.Code.TASK_FAILED));
        assertThat(indexer.upsertIsolating(INDEX, List.of(c))).containsExactly(c);
    }

    @Test
    void broken_engine_throws_without_resending_document_by_document() {
        when(client.addOrReplaceDocuments(INDEX, List.of(a, b))).thenReturn(1L);
        when(client.waitForTask(eq(1L), any())).thenThrow(new MeiliException(MeiliException.Code.CONNECTION_FAILED));

        assertThatThrownBy(() -> indexer.upsertIsolating(INDEX, List.of(a, b)))
                .isInstanceOfSatisfying(
                        MeiliException.class,
                        e -> assertThat(e.code()).isEqualTo(MeiliException.Code.CONNECTION_FAILED));
        verify(client, never()).addOrReplaceDocuments(INDEX, List.of(a));
    }

    private static SearchDocument page(String slug) {
        return SearchDocuments.page(new StaticSearchContent.Page(slug, "/" + slug, "Trang " + slug, null));
    }
}
