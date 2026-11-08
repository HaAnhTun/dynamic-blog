package com.blog.siteimport.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.media.repository.MediaRepository;
import com.blog.media.service.MediaService;
import com.blog.sitecontent.repository.SiteContentRepository;
import com.blog.sitecontent.schema.SiteContentSchemas;
import com.blog.siteimport.format.TemplateGenerator;
import com.blog.siteimport.repository.SiteImportRepository;
import java.util.List;
import java.util.UUID;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.json.JsonMapper;

/** Preview, apply and undo take a token of the per-admin site content write bucket first; a refused call touches nothing. */
class SiteImportServiceRateLimitTest {

    private final UUID admin = UUID.randomUUID();
    private final SiteContentRepository contentRepository = mock(SiteContentRepository.class);
    private final SiteImportRepository importRepository = mock(SiteImportRepository.class);
    private final SiteContentSchemas schemas = mock(SiteContentSchemas.class);
    private final Languages languages = mock(Languages.class);
    private final RateLimiter rateLimiter = mock(RateLimiter.class);
    private final TemplateGenerator templateGenerator = mock(TemplateGenerator.class);
    private final MultipartFile file = mock(MultipartFile.class);

    private SiteImportService service;

    @BeforeEach
    void setUp() {
        service = new SiteImportService(
                contentRepository,
                importRepository,
                schemas,
                languages,
                rateLimiter,
                templateGenerator,
                JsonMapper.builder().build(),
                mock(MediaService.class),
                mock(MediaRepository.class),
                mock(PlatformTransactionManager.class));
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "Too many requests"))
                .when(rateLimiter)
                .check(eq(RateLimiter.SITE_CONTENT_WRITE), eq(admin));
    }

    private void assertRefused(ThrowingCallable call) {
        assertThatThrownBy(call)
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED));
        verify(rateLimiter).check(RateLimiter.SITE_CONTENT_WRITE, admin);
        verifyNoInteractions(contentRepository, importRepository, schemas, languages, templateGenerator, file);
    }

    @Test
    void preview_is_limited() {
        assertRefused(() -> service.preview(file, admin));
    }

    @Test
    void apply_is_limited() {
        assertRefused(() -> service.apply(file, "0".repeat(64), "update", List.of("site"), admin));
    }

    @Test
    void undo_is_limited() {
        assertRefused(() -> service.undo(1L, admin));
    }
}
