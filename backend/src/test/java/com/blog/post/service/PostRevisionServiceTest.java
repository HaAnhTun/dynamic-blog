package com.blog.post.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostRevision;
import com.blog.post.repository.PostRepository;
import com.blog.post.repository.PostRevisionRepository;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

/** The one revision method that returns the id of what it recorded, for the post import. */
@ExtendWith(MockitoExtension.class)
class PostRevisionServiceTest {

    @Mock
    private PostRevisionRepository revisionRepository;

    @Mock
    private PostRepository postRepository;

    @InjectMocks
    private PostRevisionService service;

    @Test
    void recordCurrent_records_the_stored_text_without_coalescing_and_returns_the_revision_id() {
        UUID postId = UUID.randomUUID();
        UUID editor = UUID.randomUUID();
        UUID revisionId = UUID.randomUUID();
        Post post = new Post();
        post.setId(postId);
        post.setTitle("Stored title");
        post.setExcerpt("Stored excerpt");
        post.setContent("Stored content");
        when(postRepository.findById(postId)).thenReturn(Optional.of(post));
        when(revisionRepository.save(any(PostRevision.class))).thenAnswer(invocation -> {
            PostRevision saved = invocation.getArgument(0);
            ReflectionTestUtils.setField(saved, "id", revisionId);
            return saved;
        });

        UUID returned = service.recordCurrent(postId, editor);

        assertThat(returned).isEqualTo(revisionId);
        ArgumentCaptor<PostRevision> captor = ArgumentCaptor.forClass(PostRevision.class);
        verify(revisionRepository).save(captor.capture());
        assertThat(captor.getValue().getPostId()).isEqualTo(postId);
        assertThat(captor.getValue().getTitle()).isEqualTo("Stored title");
        assertThat(captor.getValue().getExcerpt()).isEqualTo("Stored excerpt");
        assertThat(captor.getValue().getContent()).isEqualTo("Stored content");
        assertThat(captor.getValue().getCreatedBy()).isEqualTo(editor);
        // Not subject to the ten-minute window: the window is never asked, and only the newest revisions are kept.
        verify(revisionRepository, never()).existsByPostIdAndCreatedAtAfter(any(), any());
        verify(revisionRepository).deleteAllButNewest(postId, PostRevisionService.KEPT_PER_POST);
    }

    @Test
    void recordCurrent_of_an_unknown_post_is_not_found_and_records_nothing() {
        UUID postId = UUID.randomUUID();
        when(postRepository.findById(postId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.recordCurrent(postId, UUID.randomUUID()))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.POST_NOT_FOUND));

        verify(revisionRepository, never()).save(any());
    }
}
