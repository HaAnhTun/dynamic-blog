package com.blog.post.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.post.dto.PostTranslationCreateRequest;
import com.blog.post.entity.Post;
import com.blog.post.repository.PostRepository;
import com.blog.search.sync.SearchOutbox;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;

/**
 * What {@code createDraft} asks before it writes. The state it writes is proved against a real database in
 * PostTranslationIT, and the limits end to end in AuthorQuotaIT; here only who is asked, and when.
 */
@ExtendWith(MockitoExtension.class)
class PostTranslationServiceTest {

    private static final UUID SOURCE = UUID.randomUUID();
    private static final UUID CALLER = UUID.randomUUID();

    @Mock
    private PostRepository postRepository;

    @Mock
    private PostService postService;

    @Mock
    private SearchOutbox searchOutbox;

    @Mock
    private Languages languages;

    @InjectMocks
    private PostTranslationService service;

    @Test
    void an_author_is_asked_for_the_create_limits_before_the_global_lock_and_over_a_limit_nothing_is_written() {
        when(languages.require("en")).thenReturn("en");
        doThrow(new ApiException(ErrorCode.AUTHOR_QUOTA_EXCEEDED, HttpStatus.TOO_MANY_REQUESTS, "At most 30 posts"))
                .when(postService)
                .requireAuthorMayCreatePost(CALLER);

        assertThatThrownBy(
                        () -> service.createDraft(SOURCE, new PostTranslationCreateRequest("en", null), CALLER, false))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.AUTHOR_QUOTA_EXCEEDED));

        verify(postRepository, never()).lockTranslationWrites();
        verify(postRepository, never()).save(any(Post.class));
        verifyNoInteractions(searchOutbox);
    }

    @Test
    void an_admin_is_exempt_from_the_create_limits() {
        when(languages.require("en")).thenReturn("en");
        Post source = new Post();
        source.setId(SOURCE);
        source.setLanguage("en");
        source.setSlug("source");
        when(postRepository.findByIdForUpdate(SOURCE)).thenReturn(Optional.of(source));

        assertThatThrownBy(
                        () -> service.createDraft(SOURCE, new PostTranslationCreateRequest("en", null), CALLER, true))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.TRANSLATION_CONFLICT));

        verify(postService, never()).requireAuthorMayCreatePost(any());
    }
}
