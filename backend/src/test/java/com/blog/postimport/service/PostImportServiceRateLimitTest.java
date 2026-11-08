package com.blog.postimport.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import com.blog.category.service.CategoryService;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.quota.AuthorQuotaProperties;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.media.repository.MediaRepository;
import com.blog.media.service.MediaService;
import com.blog.post.repository.PostRepository;
import com.blog.post.service.PostCoverService;
import com.blog.post.service.PostRevisionService;
import com.blog.post.service.PostService;
import com.blog.postimport.format.PostTemplateGenerator;
import com.blog.postimport.repository.PostImportRepository;
import com.blog.series.repository.SeriesRepository;
import com.blog.series.service.SeriesService;
import com.blog.tag.service.TagService;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.util.unit.DataSize;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.json.JsonMapper;

/** A preview and an apply take a token of the post import bucket first; a refused call reads no file and no post. */
class PostImportServiceRateLimitTest {

    private final UUID person = UUID.randomUUID();
    private final PostRepository postRepository = mock(PostRepository.class);
    private final CategoryService categoryService = mock(CategoryService.class);
    private final TagService tagService = mock(TagService.class);
    private final Languages languages = mock(Languages.class);
    private final RateLimiter rateLimiter = mock(RateLimiter.class);
    private final PostTemplateGenerator templateGenerator = mock(PostTemplateGenerator.class);
    private final PostService postService = mock(PostService.class);
    private final PostRevisionService postRevisionService = mock(PostRevisionService.class);
    private final PostImportRepository importRepository = mock(PostImportRepository.class);
    private final MultipartFile file = mock(MultipartFile.class);

    private PostImportService service;

    @BeforeEach
    void setUp() {
        service = new PostImportService(
                postRepository,
                categoryService,
                tagService,
                languages,
                rateLimiter,
                templateGenerator,
                postService,
                postRevisionService,
                importRepository,
                JsonMapper.builder().build(),
                mock(MediaService.class),
                mock(MediaRepository.class),
                mock(PlatformTransactionManager.class),
                mock(SeriesRepository.class),
                mock(SeriesService.class),
                mock(PostCoverService.class),
                new AuthorQuotaProperties(10, 30, 30, 1000, 100, DataSize.ofMegabytes(100), 50, 5));
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "Too many requests"))
                .when(rateLimiter)
                .check(eq(RateLimiter.POST_IMPORT_WRITE), eq(person));
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "Too many requests"))
                .when(rateLimiter)
                .check(eq(RateLimiter.ARTICLE_PREVIEW), eq(person));
    }

    @Test
    void preview_is_limited_by_the_post_import_bucket_and_touches_nothing_else() {
        assertThatThrownBy(() -> service.preview(List.of(file), person, false))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED));

        verify(rateLimiter).check(RateLimiter.POST_IMPORT_WRITE, person);
        verifyNoInteractions(postRepository, categoryService, tagService, languages, templateGenerator, file);
    }

    @Test
    void apply_is_limited_by_the_post_import_bucket_and_touches_nothing_else() {
        assertThatThrownBy(() -> service.apply(List.of(file), "[]", person, false))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED));

        verify(rateLimiter).check(RateLimiter.POST_IMPORT_WRITE, person);
        verifyNoInteractions(
                postRepository,
                categoryService,
                tagService,
                languages,
                templateGenerator,
                postService,
                postRevisionService,
                importRepository,
                file);
    }

    @Test
    void the_article_preview_is_limited_by_its_own_bucket_and_touches_nothing_else() {
        assertThatThrownBy(() -> service.articlePreview(file, person))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED));

        verify(rateLimiter).check(RateLimiter.ARTICLE_PREVIEW, person);
        verify(rateLimiter, never()).check(RateLimiter.POST_IMPORT_WRITE, person);
        verifyNoInteractions(postRepository, categoryService, tagService, languages, templateGenerator, file);
    }

    @Test
    void the_template_download_is_not_rate_limited() {
        service.template(null);

        verifyNoInteractions(rateLimiter);
    }
}
