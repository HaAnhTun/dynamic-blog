package com.blog.sitecontent.service;

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
import com.blog.media.service.MediaService;
import com.blog.sitecontent.dto.SiteContentDocument;
import com.blog.sitecontent.dto.SiteContentRequest;
import com.blog.sitecontent.repository.SiteContentRepository;
import com.blog.sitecontent.schema.SiteContentSchemas;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/** Every write of site content takes a token of the per-admin bucket first, and a refused write touches nothing. */
class SiteContentServiceRateLimitTest {

    private final UUID admin = UUID.randomUUID();
    private final SiteContentRepository repository = mock(SiteContentRepository.class);
    private final SiteContentSchemas schemas = mock(SiteContentSchemas.class);
    private final Languages languages = mock(Languages.class);
    private final RateLimiter rateLimiter = mock(RateLimiter.class);
    private final MediaService mediaService = mock(MediaService.class);
    private final ObjectMapper objectMapper = JsonMapper.builder().build();

    private SiteContentService service;

    @BeforeEach
    void setUp() {
        service = new SiteContentService(repository, schemas, languages, rateLimiter, mediaService, objectMapper);
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "Too many requests"))
                .when(rateLimiter)
                .check(eq(RateLimiter.SITE_CONTENT_WRITE), eq(admin));
    }

    private void assertRefused(org.assertj.core.api.ThrowableAssert.ThrowingCallable write) {
        assertThatThrownBy(write)
                .isInstanceOfSatisfying(
                        ApiException.class,
                        e -> org.assertj.core.api.Assertions.assertThat(e.getCode())
                                .isEqualTo(ErrorCode.RATE_LIMITED));
        verify(rateLimiter).check(RateLimiter.SITE_CONTENT_WRITE, admin);
        verifyNoInteractions(repository, schemas, mediaService);
    }

    @Test
    void put_is_limited() {
        assertRefused(() -> service.put("site", "vi", new SiteContentRequest(1, null), admin));
    }

    @Test
    void restore_is_limited() {
        assertRefused(() -> service.restore("site", "vi", 1L, admin));
    }

    @Test
    void import_is_limited() {
        assertRefused(() -> service.importDocument(new SiteContentDocument("site-content", 1, "vi", Map.of()), admin));
    }

    @Test
    void avatar_upload_is_limited() {
        assertRefused(() -> service.uploadAvatar(null, admin));
    }
}
