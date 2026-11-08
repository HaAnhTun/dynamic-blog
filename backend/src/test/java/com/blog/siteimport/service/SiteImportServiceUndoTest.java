package com.blog.siteimport.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.media.repository.MediaRepository;
import com.blog.media.service.MediaService;
import com.blog.sitecontent.repository.SiteContentRepository;
import com.blog.sitecontent.repository.SiteContentRepository.Row;
import com.blog.sitecontent.schema.SiteContentSchemas;
import com.blog.siteimport.format.TemplateGenerator;
import com.blog.siteimport.repository.SiteImportRepository;
import com.blog.siteimport.repository.SiteImportRepository.LogRow;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.json.JsonMapper;

/** Undo names the import it undoes; a missing id, a newer import or a pruned previous version refuses and writes nothing. */
class SiteImportServiceUndoTest {

    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    private static final String IMPORTED = "{\"name\":\"Imported Site\"}";

    private final UUID admin = UUID.randomUUID();
    private final SiteContentRepository contentRepository = mock(SiteContentRepository.class);
    private final SiteImportRepository importRepository = mock(SiteImportRepository.class);
    private final SiteContentSchemas schemas = mock(SiteContentSchemas.class);

    private SiteImportService service;

    @BeforeEach
    void setUp() {
        service = new SiteImportService(
                contentRepository,
                importRepository,
                schemas,
                mock(Languages.class),
                mock(RateLimiter.class),
                mock(TemplateGenerator.class),
                MAPPER,
                mock(MediaService.class),
                mock(MediaRepository.class),
                mock(PlatformTransactionManager.class));
    }

    private static LogRow updatedSite(long id, long previousRevisionId, String afterHash) {
        String sections = "[{\"key\":\"site\",\"status\":\"updated\",\"previousRevisionId\":" + previousRevisionId
                + ",\"afterHash\":\"" + afterHash + "\",\"added\":0,\"removed\":0,\"kept\":0}]";
        return new LogRow(id, Instant.now(), "en", "update", sections, null);
    }

    private static void assertRefused(ThrowingCallable call, ErrorCode code, HttpStatus status, String message) {
        assertThatThrownBy(call).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(code);
            assertThat(e.getStatus()).isEqualTo(status);
            assertThat(e.getMessage()).isEqualTo(message);
        });
    }

    private void assertNothingWritten() {
        verify(contentRepository, never()).snapshot(anyString(), anyString(), any());
        verify(contentRepository, never()).upsert(anyString(), anyString(), anyInt(), anyString(), any());
        verify(contentRepository, never()).delete(anyString(), anyString());
        verify(importRepository, never()).markUndone(anyLong(), any());
    }

    @Test
    void a_missing_import_id_is_a_validation_error_before_any_lock() {
        assertRefused(
                () -> service.undo(null, admin),
                ErrorCode.VALIDATION_ERROR,
                HttpStatus.BAD_REQUEST,
                "importId is required");
        verifyNoInteractions(importRepository, contentRepository);
    }

    @Test
    void an_import_id_that_is_not_the_newest_undoable_import_is_refused() {
        when(importRepository.findLatestUndoable()).thenReturn(Optional.of(updatedSite(7, 3, "any")));

        assertRefused(
                () -> service.undo(6L, admin),
                ErrorCode.SITE_IMPORT_UNDO_CONFLICT,
                HttpStatus.CONFLICT,
                "A newer import exists; reload the page");
        verify(importRepository).lockGlobal();
        verifyNoInteractions(contentRepository);
        assertNothingWritten();
    }

    @Test
    void a_pruned_previous_version_is_named_in_the_refusal() {
        String afterHash = service.hash(MAPPER.readTree(IMPORTED));
        when(importRepository.findLatestUndoable()).thenReturn(Optional.of(updatedSite(7, 3, afterHash)));
        when(contentRepository.find("site", "en"))
                .thenReturn(Optional.of(new Row("site", "en", 1, IMPORTED, Instant.now())));
        when(contentRepository.findRevision("site", "en", 3)).thenReturn(Optional.empty());

        assertRefused(
                () -> service.undo(7L, admin),
                ErrorCode.SITE_IMPORT_UNDO_CONFLICT,
                HttpStatus.CONFLICT,
                "The previous version of site is no longer kept");
        assertNothingWritten();
    }

    @Test
    void a_change_after_the_import_keeps_its_own_message() {
        when(importRepository.findLatestUndoable()).thenReturn(Optional.of(updatedSite(7, 3, "not-the-stored-hash")));
        when(contentRepository.find("site", "en"))
                .thenReturn(Optional.of(new Row("site", "en", 1, IMPORTED, Instant.now())));

        assertRefused(
                () -> service.undo(7L, admin),
                ErrorCode.SITE_IMPORT_UNDO_CONFLICT,
                HttpStatus.CONFLICT,
                "The site content was changed after the import; the import cannot be undone");
        assertNothingWritten();
    }
}
