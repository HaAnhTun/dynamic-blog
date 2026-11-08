package com.blog.post.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import com.blog.category.entity.Category;
import com.blog.category.repository.CategoryRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.I18nProperties;
import com.blog.common.i18n.Languages;
import com.blog.common.quota.AuthorQuotaProperties;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.media.entity.Media;
import com.blog.media.service.MediaService;
import com.blog.newsletter.service.NewsletterOutbox;
import com.blog.post.dto.PostCreateRequest;
import com.blog.post.dto.PostSummaryResponse;
import com.blog.post.dto.PostUpdateRequest;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostCard;
import com.blog.post.entity.PostHead;
import com.blog.post.entity.PostStatus;
import com.blog.post.entity.PostView;
import com.blog.post.repository.PartNumberRow;
import com.blog.post.repository.PostCardRepository;
import com.blog.post.repository.PostRepository;
import com.blog.post.repository.PostViewRepository;
import com.blog.search.sync.SearchOutbox;
import com.blog.series.entity.Series;
import com.blog.tag.entity.Tag;
import com.blog.tag.repository.TagRepository;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;

@ExtendWith(MockitoExtension.class)
class PostServiceTest {

    @Mock
    private PostRepository postRepository;

    // The lists read cards (the row without the body): the admin list below is stubbed here.
    @Mock
    private PostCardRepository postCardRepository;

    @Mock
    private CategoryRepository categoryRepository;

    @Mock
    private TagRepository tagRepository;

    @Mock
    private UserRepository userRepository;
    // Without this mock, @InjectMocks passes null to the constructor and every path that returns a post DTO throws NPE.
    // Unstubbed
    // it returns an empty list: every post has 0 views, so the older tests below do not need to know about it.
    @Mock
    private PostViewRepository postViewRepository;
    // Deleting a post also deletes its cover image. Only the delete path touches this mock.
    @Mock
    private MediaService mediaService;
    // Text edits record a revision through this service. The mock records nothing: the slug tests below do not need to
    // know about it; the revision-recording rules are tested against a real DB in PostRevisionIT.
    @Mock
    private PostRevisionService postRevisionService;
    // The first publish records a newsletter issue through here; the "first time only" rule is tested against a real DB
    // in
    // NewsletterIT.
    @Mock
    private NewsletterOutbox newsletterOutbox;
    // Changes write the search outbox; without this mock @InjectMocks passes null. The write rules are tested against a
    // real DB and
    // a real Meilisearch in SearchOutboxIT.
    @Mock
    private SearchOutbox searchOutbox;

    // The burst limit of an AUTHOR's writes: the counting is proved in RateLimiterTest, here only who it is asked for.
    @Mock
    private RateLimiter rateLimiter;

    // Small limits so that the tests need few tags and posts: 2 tags per post, 3 posts per day, 5 old addresses kept.
    @Mock
    private AuthorQuotaProperties authorQuota;

    @org.junit.jupiter.api.BeforeEach
    void smallAuthorLimits() {
        lenient().when(authorQuota.maxTagsPerPost()).thenReturn(2);
        lenient().when(authorQuota.maxPostsPerDay()).thenReturn(3);
        lenient().when(authorQuota.maxSlugHistoryPerPost()).thenReturn(5);
    }

    // A real instance with the default configuration (vi, en; default vi): the language rules are plain logic.
    @Spy
    private Languages languages = new Languages(new I18nProperties(List.of("vi", "en"), "vi"));

    @InjectMocks
    private PostService postService;

    /** The user saving the post in the edits here: only forwarded to the revision. */
    private static final UUID EDITOR = UUID.randomUUID();

    private static User author() {
        User user = new User();
        user.setId(UUID.randomUUID());
        user.setEmail("admin@blog.local");
        user.setDisplayName("Admin");
        user.setRole(UserRole.ADMIN);
        return user;
    }

    @Test
    void createGeneratesUniqueSlugWhenTitleCollides() {
        User author = author();
        when(userRepository.findById(author.getId())).thenReturn(Optional.of(author));
        when(postRepository.existsBySlug("spring-boot-basics")).thenReturn(true);
        when(postRepository.existsBySlug("spring-boot-basics-2")).thenReturn(false);
        when(postRepository.save(any(Post.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = postService.create(
                author.getId(),
                new PostCreateRequest("Spring Boot Basics", null, "Post content", null, Set.of(), null));

        assertThat(response.slug()).isEqualTo("spring-boot-basics-2");
    }

    @Test
    void createRejectsUnknownCategory() {
        User author = author();
        UUID categoryId = UUID.randomUUID();
        when(userRepository.findById(author.getId())).thenReturn(Optional.of(author));
        when(categoryRepository.findById(categoryId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> postService.create(
                        author.getId(), new PostCreateRequest("Title", null, "Content", categoryId, Set.of(), null)))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Category not found");
    }

    @Test
    void createRejectsUnknownTag() {
        User author = author();
        UUID knownTagId = UUID.randomUUID();
        UUID unknownTagId = UUID.randomUUID();
        Tag knownTag = new Tag();
        knownTag.setId(knownTagId);
        knownTag.setName("Known");
        knownTag.setSlug("known");

        when(userRepository.findById(author.getId())).thenReturn(Optional.of(author));
        when(tagRepository.findAllByIdIn(Set.of(knownTagId, unknownTagId))).thenReturn(List.of(knownTag));

        assertThatThrownBy(() -> postService.create(
                        author.getId(),
                        new PostCreateRequest("Title", null, "Content", null, Set.of(knownTagId, unknownTagId), null)))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("tag");
    }

    @Test
    void createRejectsUnknownAuthor() {
        UUID authorId = UUID.randomUUID();
        when(userRepository.findById(authorId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> postService.create(
                        authorId, new PostCreateRequest("Title", null, "Content", null, Set.of(), null)))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Author not found");
    }

    @Test
    void getByIdRejectsUnknownPost() {
        UUID postId = UUID.randomUUID();
        when(postRepository.findById(postId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> postService.getById(postId))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Post not found");
    }

    @Test
    void updateRejectsUnknownPost() {
        UUID postId = UUID.randomUUID();
        when(postRepository.findById(postId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> postService.update(
                        postId, new PostUpdateRequest("Title", null, "Content", null, Set.of(), null), EDITOR))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Post not found");
    }

    @Test
    void deleteRejectsUnknownPost() {
        UUID postId = UUID.randomUUID();
        // Delete reads the post under a row lock (so the cover image deleted with the post is the current one), not via
        // findById.
        when(postRepository.findByIdForUpdate(postId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> postService.delete(postId))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Post not found");
    }

    @Test
    void delete_post_with_cover_deletes_image_and_post_without_cover_deletes_none() {
        Post withCover = post("co-anh-bia", PostStatus.DRAFT);
        Media cover = new Media();
        cover.setId(UUID.randomUUID());
        // The cover image is written only by dedicated SQL, the entity has no setter: the test assigns the field
        // directly.
        ReflectionTestUtils.setField(withCover, "cover", cover);
        Post without = post("khong-anh-bia", PostStatus.DRAFT);
        when(postRepository.findByIdForUpdate(withCover.getId())).thenReturn(Optional.of(withCover));
        when(postRepository.findByIdForUpdate(without.getId())).thenReturn(Optional.of(without));

        postService.delete(withCover.getId());
        postService.delete(without.getId());

        verify(postRepository).delete(withCover);
        verify(postRepository).delete(without);
        verify(mediaService).delete(cover.getId());
        verifyNoMoreInteractions(mediaService);
    }

    // --- Deleting: an AUTHOR hides, an ADMIN deletes for good ------------------------------------------

    @Test
    void an_authors_delete_hides_the_post_as_archived_and_deletes_no_row() {
        Post post = published("de-an");
        UUID author = UUID.randomUUID();
        when(postRepository.findByIdForUpdate(post.getId())).thenReturn(Optional.of(post));

        postService.delete(post.getId(), author, false);

        assertThat(post.getStatus()).isEqualTo(PostStatus.ARCHIVED);
        assertThat(post.getDeletedAt()).isNotNull();
        assertThat(post.getDeletedBy()).isEqualTo(author);
        verify(postRepository, never()).delete(any(Post.class));
        verify(searchOutbox).postAndRelated(post.getId());
        verifyNoMoreInteractions(mediaService);
    }

    @Test
    void hiding_a_post_that_is_already_hidden_changes_nothing() {
        Post post = published("da-an");
        UUID first = UUID.randomUUID();
        when(postRepository.findByIdForUpdate(post.getId())).thenReturn(Optional.of(post));
        postService.delete(post.getId(), first, false);
        Instant when = post.getDeletedAt();

        postService.delete(post.getId(), UUID.randomUUID(), false);

        assertThat(post.getDeletedAt()).isEqualTo(when);
        assertThat(post.getDeletedBy()).isEqualTo(first);
        verify(searchOutbox, times(1)).postAndRelated(post.getId());
    }

    @Test
    void an_admins_delete_removes_the_post_for_good() {
        Post post = published("xoa-han");
        when(postRepository.findByIdForUpdate(post.getId())).thenReturn(Optional.of(post));

        postService.delete(post.getId(), UUID.randomUUID(), true);

        verify(postRepository).delete(post);
        assertThat(post.getDeletedAt()).isNull();
    }

    @Test
    void deleting_a_post_that_does_not_exist_is_404_for_both() {
        UUID missing = UUID.randomUUID();
        when(postRepository.findByIdForUpdate(missing)).thenReturn(Optional.empty());

        for (boolean admin : new boolean[] {false, true}) {
            assertThatThrownBy(() -> postService.delete(missing, UUID.randomUUID(), admin))
                    .isInstanceOfSatisfying(
                            ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.POST_NOT_FOUND));
        }
    }

    @Test
    void publishing_a_hidden_post_brings_it_back() {
        Post post = published("tro-lai");
        post.setStatus(PostStatus.ARCHIVED);
        post.setCategory(new Category());
        post.setDeletedAt(Instant.parse("2026-02-02T00:00:00Z"));
        post.setDeletedBy(UUID.randomUUID());
        when(postRepository.findByIdForUpdate(post.getId())).thenReturn(Optional.of(post));
        when(postRepository.saveAndFlush(any(Post.class))).thenAnswer(invocation -> invocation.getArgument(0));

        postService.publish(post.getId(), true);

        assertThat(post.getStatus()).isEqualTo(PostStatus.PUBLISHED);
        assertThat(post.getDeletedAt()).isNull();
        assertThat(post.getDeletedBy()).isNull();
    }

    @Test
    void publishRequiresNonBlankContent() {
        Post post = new Post();
        post.setId(UUID.randomUUID());
        post.setContent("   ");
        post.setStatus(PostStatus.DRAFT);
        // Publish reads the post under a row lock, not via findById.
        when(postRepository.findByIdForUpdate(post.getId())).thenReturn(Optional.of(post));

        assertThatThrownBy(() -> postService.publish(post.getId(), true))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("content must not be blank");
    }

    @Test
    void publishRequiresCategory() {
        Post post = new Post();
        post.setId(UUID.randomUUID());
        post.setContent("Valid content");
        post.setCategory(null);
        post.setStatus(PostStatus.DRAFT);
        when(postRepository.findByIdForUpdate(post.getId())).thenReturn(Optional.of(post));

        assertThatThrownBy(() -> postService.publish(post.getId(), true))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("category");
    }

    @Test
    void republishingDoesNotOverwriteOriginalPublishedAt() {
        Instant originalPublishedAt = Instant.parse("2026-01-01T00:00:00Z");
        Post post = new Post();
        post.setId(UUID.randomUUID());
        post.setContent("Content");
        post.setCategory(new Category());
        post.setStatus(PostStatus.PUBLISHED);
        post.setPublishedAt(originalPublishedAt);
        post.setAuthor(author());
        when(postRepository.findByIdForUpdate(post.getId())).thenReturn(Optional.of(post));
        // Every post edit saves then flushes before mapping (PostService.saved): the response carries the persisted
        // updatedAt.
        when(postRepository.saveAndFlush(any(Post.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = postService.publish(post.getId(), true);

        assertThat(response.publishedAt()).isEqualTo(originalPublishedAt);
    }

    // --- Slug history ------------------------------------------------------------------------

    @Test
    void create_post_with_old_slug_of_renamed_post_gets_suffix() {
        User author = author();
        when(userRepository.findById(author.getId())).thenReturn(Optional.of(author));
        when(postRepository.existsBySlug("bai-cu")).thenReturn(false);
        when(postRepository.existsInSlugHistory("bai-cu")).thenReturn(true);
        when(postRepository.existsBySlug("bai-cu-2")).thenReturn(false);
        when(postRepository.existsInSlugHistory("bai-cu-2")).thenReturn(false);
        when(postRepository.save(any(Post.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = postService.create(
                author.getId(), new PostCreateRequest("New post", null, "Content", null, Set.of(), "bai-cu"));

        assertThat(response.slug()).isEqualTo("bai-cu-2");
        // A new post has no slug to record yet.
        verify(postRepository, never()).recordOldSlug(any(), any());
    }

    @Test
    void change_slug_of_published_post_checks_posts_before_history_then_drops_new_slug_row_and_records_old() {
        Post post = published("slug-cu");
        stubLoadAndSave(post);

        var response = postService.update(post.getId(), rename("slug-moi"), EDITOR);

        assertThat(response.slug()).isEqualTo("slug-moi");
        InOrder order = inOrder(postRepository);
        // posts first, history second: that order keeps a concurrent slug change from slipping through the gap (see
        // create).
        order.verify(postRepository).existsBySlugAndIdNot("slug-moi", post.getId());
        order.verify(postRepository).existsInSlugHistoryOfOtherPost("slug-moi", post.getId());
        order.verify(postRepository).forgetOldSlug("slug-moi", post.getId());
        order.verify(postRepository).recordOldSlug("slug-cu", post.getId());
    }

    @Test
    void a_rename_is_refused_when_the_current_address_is_the_old_address_of_another_post() {
        Post post = published("dia-chi-a");
        // The edit is refused before anything is saved.
        when(postRepository.findById(post.getId())).thenReturn(Optional.of(post));
        // Only hand-written data gets here: the history already has this slug, and it is another post's.
        when(postRepository.recordOldSlug("dia-chi-a", post.getId())).thenReturn(0);
        when(postRepository.existsInSlugHistoryOfOtherPost(anyString(), eq(post.getId())))
                .thenAnswer(invocation -> "dia-chi-a".equals(invocation.getArgument(0)));

        assertThatThrownBy(() -> postService.update(post.getId(), rename("dia-chi-b"), EDITOR))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.RESOURCE_CONFLICT);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                });
    }

    @Test
    void renaming_back_and_forth_is_not_a_conflict_when_the_row_is_this_posts_own() {
        Post post = published("dia-chi-c");
        stubLoadAndSave(post);
        when(postRepository.recordOldSlug("dia-chi-c", post.getId())).thenReturn(0);
        when(postRepository.existsInSlugHistoryOfOtherPost(anyString(), eq(post.getId())))
                .thenReturn(false);

        assertThat(postService.update(post.getId(), rename("dia-chi-d"), EDITOR).slug())
                .isEqualTo("dia-chi-d");
    }

    @Test
    void the_post_of_an_author_keeps_only_its_newest_old_addresses_and_the_post_of_an_admin_keeps_all() {
        Post byAuthor = published("cua-tac-gia");
        byAuthor.getAuthor().setRole(UserRole.AUTHOR);
        stubLoadAndSave(byAuthor);
        Post byAdmin = published("cua-quan-tri");
        // The save is already stubbed for any post by the line above.
        when(postRepository.findById(byAdmin.getId())).thenReturn(Optional.of(byAdmin));

        postService.update(byAuthor.getId(), rename("tac-gia-moi"), EDITOR);
        postService.update(byAdmin.getId(), rename("quan-tri-moi"), EDITOR);

        verify(postRepository).trimSlugHistory(byAuthor.getId(), 5);
        verify(postRepository, never()).trimSlugHistory(eq(byAdmin.getId()), anyInt());
    }

    @Test
    void releasing_an_old_address_deletes_its_row_and_an_unknown_one_is_404() {
        when(postRepository.releaseOldSlug("dia-chi-cu")).thenReturn(1);
        when(postRepository.releaseOldSlug("chua-tung-co")).thenReturn(0);

        postService.releaseOldSlug("dia-chi-cu");
        assertThatThrownBy(() -> postService.releaseOldSlug("chua-tung-co"))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.SLUG_HISTORY_NOT_FOUND);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.NOT_FOUND);
                });
    }

    @Test
    void change_slug_of_unpublished_post_still_records_old_slug_because_it_was_public() {
        Post post = published("dang-go");
        post.setStatus(PostStatus.DRAFT);
        stubLoadAndSave(post);

        postService.update(post.getId(), rename("dang-go-moi"), EDITOR);

        verify(postRepository).recordOldSlug("dang-go", post.getId());
    }

    @Test
    void change_slug_of_never_published_draft_does_not_record_old_slug() {
        Post draft = post("nhap-cu", PostStatus.DRAFT);
        stubLoadAndSave(draft);

        var response = postService.update(draft.getId(), rename("nhap-moi"), EDITOR);

        assertThat(response.slug()).isEqualTo("nhap-moi");
        verify(postRepository, never()).recordOldSlug(any(), any());
    }

    @Test
    void old_slug_of_other_post_gets_suffix_on_update() {
        Post post = published("cua-minh");
        stubLoadAndSave(post);
        when(postRepository.existsInSlugHistoryOfOtherPost("cua-bai-khac", post.getId()))
                .thenReturn(true);
        when(postRepository.existsInSlugHistoryOfOtherPost("cua-bai-khac-2", post.getId()))
                .thenReturn(false);

        var response = postService.update(post.getId(), rename("cua-bai-khac"), EDITOR);

        assertThat(response.slug()).isEqualTo("cua-bai-khac-2");
        verify(postRepository).recordOldSlug("cua-minh", post.getId());
    }

    @Test
    void suffix_resolving_to_current_slug_is_not_a_slug_change_and_records_nothing() {
        Post post = published("bai-2");
        stubLoadAndSave(post);
        // "bai" belongs to another post; "bai-2" belongs to this post itself.
        when(postRepository.existsBySlugAndIdNot("bai", post.getId())).thenReturn(true);
        when(postRepository.existsBySlugAndIdNot("bai-2", post.getId())).thenReturn(false);

        var response = postService.update(post.getId(), rename("bai"), EDITOR);

        assertThat(response.slug()).isEqualTo("bai-2");
        verify(postRepository, never()).recordOldSlug(any(), any());
        verify(postRepository, never()).forgetOldSlug(any(), any());
    }

    @Test
    void resubmitting_current_slug_or_leaving_blank_does_not_touch_history() {
        Post post = published("giu-nguyen");
        stubLoadAndSave(post);

        postService.update(post.getId(), rename("giu-nguyen"), EDITOR);
        postService.update(post.getId(), rename("   "), EDITOR);
        postService.update(post.getId(), rename(null), EDITOR);

        assertThat(post.getSlug()).isEqualTo("giu-nguyen");
        verify(postRepository, never()).existsInSlugHistoryOfOtherPost(any(), any());
        verify(postRepository, never()).recordOldSlug(any(), any());
        verify(postRepository, never()).forgetOldSlug(any(), any());
    }

    // --- Revisions ---------------------------------------------------------------------------

    @Test
    void update_post_hands_revision_service_the_old_text_still_intact_plus_new_text_and_saver() {
        Post post = published("co-ban-sua-doi");
        post.setTitle("Old title");
        post.setExcerpt("Old summary");
        post.setContent("Old content");
        stubLoadAndSave(post);
        List<String> seen = new ArrayList<>();
        doAnswer(invocation -> {
                    Post atCall = invocation.getArgument(0);
                    seen.addAll(List.of(atCall.getTitle(), atCall.getExcerpt(), atCall.getContent()));
                    return null;
                })
                .when(postRevisionService)
                .recordBeforeEdit(any(), any(), any(), any(), any());

        postService.update(
                post.getId(),
                new PostUpdateRequest("New title", "New summary", "New content", null, Set.of(), null),
                EDITOR);

        // Called BEFORE overwriting: the revision keeps the old state.
        assertThat(seen).containsExactly("Old title", "Old summary", "Old content");
        verify(postRevisionService).recordBeforeEdit(post, "New title", "New summary", "New content", EDITOR);
        assertThat(post.getContent()).isEqualTo("New content");
    }

    // --- The newsletter of the first publish ---------------------------------------------------

    @Test
    void the_first_publish_tells_the_outbox_whether_an_admin_published_and_a_later_publish_tells_it_nothing() {
        Post byAuthor = post("bai-cua-tac-gia", PostStatus.DRAFT);
        byAuthor.setContent("Content");
        byAuthor.setCategory(new Category());
        Post byAdmin = post("bai-cua-quan-tri", PostStatus.DRAFT);
        byAdmin.setContent("Content");
        byAdmin.setCategory(new Category());
        when(postRepository.findByIdForUpdate(byAuthor.getId())).thenReturn(Optional.of(byAuthor));
        when(postRepository.findByIdForUpdate(byAdmin.getId())).thenReturn(Optional.of(byAdmin));
        when(postRepository.saveAndFlush(any(Post.class))).thenAnswer(invocation -> invocation.getArgument(0));

        postService.publish(byAuthor.getId(), false);
        postService.publish(byAdmin.getId(), true);
        // The post already has its publishedAt: nothing new is recorded, whoever publishes again.
        postService.publish(byAuthor.getId(), true);

        verify(newsletterOutbox).firstPublished(byAuthor.getId(), false);
        verify(newsletterOutbox).firstPublished(byAdmin.getId(), true);
        verifyNoMoreInteractions(newsletterOutbox);
    }

    // --- What an AUTHOR may write, and what an ADMIN is exempt from -----------------------------

    private static User authorWithRole(UserRole role) {
        User user = author();
        user.setRole(role);
        return user;
    }

    private static Set<UUID> tagIds(int count) {
        Set<UUID> ids = new java.util.HashSet<>();
        for (int i = 0; i < count; i++) {
            ids.add(UUID.randomUUID());
        }
        return ids;
    }

    @Test
    void an_author_create_counts_one_write_and_refuses_more_tags_than_the_limit_before_anything_is_saved() {
        User author = authorWithRole(UserRole.AUTHOR);
        when(userRepository.findById(author.getId())).thenReturn(Optional.of(author));

        assertThatThrownBy(() -> postService.create(
                        author.getId(), new PostCreateRequest("Title", null, "Content", null, tagIds(3), null)))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(e.getMessage()).contains("at most 2 tags");
                });
        verify(rateLimiter).check(RateLimiter.POST_WRITE, author.getId());
        verify(postRepository, never()).save(any(Post.class));
    }

    @Test
    void an_author_who_created_the_daily_number_of_posts_is_refused_with_429_AUTHOR_QUOTA_EXCEEDED() {
        User author = authorWithRole(UserRole.AUTHOR);
        when(userRepository.findById(author.getId())).thenReturn(Optional.of(author));
        when(postRepository.countByAuthorIdAndCreatedAtAfter(eq(author.getId()), any(Instant.class)))
                .thenReturn(3L);

        assertThatThrownBy(() -> postService.create(
                        author.getId(), new PostCreateRequest("Title", null, "Content", null, Set.of(), null)))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.AUTHOR_QUOTA_EXCEEDED);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                });
        verify(postRepository, never()).save(any(Post.class));
    }

    @Test
    void an_author_below_the_limits_creates_the_post() {
        User author = authorWithRole(UserRole.AUTHOR);
        when(userRepository.findById(author.getId())).thenReturn(Optional.of(author));
        when(postRepository.countByAuthorIdAndCreatedAtAfter(eq(author.getId()), any(Instant.class)))
                .thenReturn(2L);
        when(postRepository.save(any(Post.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = postService.create(
                author.getId(), new PostCreateRequest("Below the limits", null, "Content", null, Set.of(), null));

        assertThat(response.title()).isEqualTo("Below the limits");
    }

    @Test
    void an_admin_is_exempt_from_the_write_limit_the_tag_limit_and_the_daily_number() {
        User admin = authorWithRole(UserRole.ADMIN);
        Set<UUID> five = tagIds(5);
        when(userRepository.findById(admin.getId())).thenReturn(Optional.of(admin));
        when(tagRepository.findAllByIdIn(five)).thenReturn(tags(five));
        when(postRepository.save(any(Post.class))).thenAnswer(invocation -> invocation.getArgument(0));

        postService.create(admin.getId(), new PostCreateRequest("Title", null, "Content", null, five, null));

        verify(rateLimiter, never()).check(any(String.class), any(UUID.class));
        verify(postRepository, never()).countByAuthorIdAndCreatedAtAfter(any(), any());
    }

    private static List<Tag> tags(Set<UUID> ids) {
        return ids.stream()
                .map(id -> {
                    Tag tag = new Tag();
                    tag.setId(id);
                    tag.setName("T" + id);
                    tag.setSlug("t-" + id);
                    return tag;
                })
                .toList();
    }

    @Test
    void saving_counts_a_write_and_the_tag_limit_for_an_author_but_not_for_an_admin() {
        Post post = published("saved-by-author");
        stubLoadAndSave(post);
        when(userRepository.findRoleById(EDITOR)).thenReturn(Optional.of(UserRole.AUTHOR));

        assertThatThrownBy(() -> postService.update(
                        post.getId(), new PostUpdateRequest("Title", null, "Content", null, tagIds(3), null), EDITOR))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST));
        verify(rateLimiter).check(RateLimiter.POST_WRITE, EDITOR);

        UUID admin = UUID.randomUUID();
        when(userRepository.findRoleById(admin)).thenReturn(Optional.of(UserRole.ADMIN));
        Set<UUID> five = tagIds(5);
        when(tagRepository.findAllByIdIn(five)).thenReturn(tags(five));
        postService.update(post.getId(), new PostUpdateRequest("Title", null, "Content", null, five, null), admin);
        verify(rateLimiter, never()).check(RateLimiter.POST_WRITE, admin);
    }

    @Test
    void an_author_can_save_a_post_that_is_already_over_the_tag_limit_as_long_as_the_save_adds_no_tag() {
        Post post = published("already-over-the-limit");
        Set<UUID> three = tagIds(3);
        post.setTags(new HashSet<>(tags(three)));
        stubLoadAndSave(post);
        when(userRepository.findRoleById(EDITOR)).thenReturn(Optional.of(UserRole.AUTHOR));
        when(tagRepository.findAllByIdIn(any())).thenAnswer(invocation -> tags(invocation.getArgument(0)));

        // Unchanged tags, then fewer of them: nothing is added, so the post is not locked by a limit it was written
        // under.
        postService.update(post.getId(), new PostUpdateRequest("Title", null, "Content", null, three, null), EDITOR);
        Set<UUID> two = three.stream().limit(2).collect(Collectors.toSet());
        postService.update(post.getId(), new PostUpdateRequest("Title", null, "Content", null, two, null), EDITOR);

        // Adding one is refused, also when a tag is swapped and the count stays over the limit.
        Set<UUID> swapped = new HashSet<>(two);
        swapped.add(UUID.randomUUID());
        assertThatThrownBy(() -> postService.update(
                        post.getId(), new PostUpdateRequest("Title", null, "Content", null, swapped, null), EDITOR))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
                    assertThat(e.getMessage()).contains("at most 2 tags");
                });
    }

    // --- Display text of an author ---------------------------------------------------------

    /** U+202E reverses the rest of the line; U+200B is a zero-width space. */
    private static String hidden(String left, int codePoint, String right) {
        return left + new String(Character.toChars(codePoint)) + right;
    }

    @Test
    void create_removes_text_direction_and_invisible_characters_from_title_and_excerpt_before_the_slug() {
        User author = author();
        when(userRepository.findById(author.getId())).thenReturn(Optional.of(author));
        when(postRepository.save(any(Post.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = postService.create(
                author.getId(),
                new PostCreateRequest(
                        hidden("Fast", 0x202E, " title"),
                        hidden("A short", 0x200B, " summary"),
                        "Post content",
                        null,
                        Set.of(),
                        null));

        assertThat(response.title()).isEqualTo("Fast title");
        assertThat(response.excerpt()).isEqualTo("A short summary");
        assertThat(response.slug()).isEqualTo("fast-title");
    }

    @Test
    void create_refuses_a_title_with_nothing_visible_and_saves_nothing() {
        User author = author();
        when(userRepository.findById(author.getId())).thenReturn(Optional.of(author));

        assertThatThrownBy(() -> postService.create(
                        author.getId(),
                        new PostCreateRequest(hidden("", 0x202E, ""), null, "Post content", null, Set.of(), null)))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                });
        verify(postRepository, never()).save(any(Post.class));
    }

    @Test
    void update_stores_and_records_the_cleaned_title_and_excerpt() {
        Post post = published("co-ban-sua-doi");
        post.setTitle("Old title");
        post.setContent("Old content");
        stubLoadAndSave(post);

        postService.update(
                post.getId(),
                new PostUpdateRequest(
                        hidden("New", 0x202E, " title"),
                        hidden("S", 0x200B, "ummary"),
                        "Old content",
                        null,
                        Set.of(),
                        null),
                EDITOR);

        assertThat(post.getTitle()).isEqualTo("New title");
        assertThat(post.getExcerpt()).isEqualTo("Summary");
        verify(postRevisionService).recordBeforeEdit(post, "New title", "Summary", "Old content", EDITOR);
    }

    @Test
    void resolve_old_slug_returns_current_slug_or_404_POST_NOT_FOUND() {
        when(postRepository.findPublishedSlugByOldSlug("cu")).thenReturn(Optional.of("moi"));
        when(postRepository.findPublishedSlugByOldSlug("la")).thenReturn(Optional.empty());

        assertThat(postService.findRedirect("cu").slug()).isEqualTo("moi");
        assertThatThrownBy(() -> postService.findRedirect("la")).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.POST_NOT_FOUND);
            assertThat(e.getStatus()).isEqualTo(HttpStatus.NOT_FOUND);
        });
    }

    /** A post that was published at some point: it has a publish date (kept even when the post is moved back to DRAFT). */
    private static Post published(String slug) {
        Post post = post(slug, PostStatus.PUBLISHED);
        post.setPublishedAt(Instant.parse("2026-01-01T00:00:00Z"));
        return post;
    }

    /** A post edit saves then flushes before mapping (PostService.saved), so stub saveAndFlush rather than save. */
    private void stubLoadAndSave(Post post) {
        when(postRepository.findById(post.getId())).thenReturn(Optional.of(post));
        when(postRepository.saveAndFlush(any(Post.class))).thenAnswer(invocation -> invocation.getArgument(0));
    }

    /** A PUT body that differs only in the slug field; null means the slug field is not sent. */
    private static PostUpdateRequest rename(String slug) {
        return new PostUpdateRequest("Title", null, "Content", null, Set.of(), slug);
    }

    // --- Language of a series member ---------------------------------------------------------

    private static Post memberAtPart(Series series, int part, String language) {
        Post member = post("phan-" + part, PostStatus.DRAFT);
        member.setLanguage(language);
        inSeries(member, series, part);
        ReflectionTestUtils.setField(member, "seriesPart", part);
        return member;
    }

    private static PostUpdateRequest inLanguage(String language) {
        return new PostUpdateRequest("Title", null, "Content", null, Set.of(), null, language);
    }

    @Test
    void changing_the_language_of_a_series_member_to_one_where_its_part_is_free_keeps_the_part() {
        Series series = series();
        Post member = memberAtPart(series, 3, "vi");
        stubLoadAndSave(member);
        when(postRepository.findSeriesPartHolders(series.getId(), "en", 3)).thenReturn(List.of());

        postService.update(member.getId(), inLanguage("en"), EDITOR);

        assertThat(member.getLanguage()).isEqualTo("en");
        assertThat(member.getSeriesPart()).isEqualTo(3);
    }

    @Test
    void changing_the_language_of_a_series_member_to_one_where_another_post_has_its_part_is_a_clean_409() {
        Series series = series();
        Post member = memberAtPart(series, 3, "vi");
        when(postRepository.findById(member.getId())).thenReturn(Optional.of(member));
        when(postRepository.findSeriesPartHolders(series.getId(), "en", 3)).thenReturn(List.of(UUID.randomUUID()));

        assertThatThrownBy(() -> postService.update(member.getId(), inLanguage("en"), EDITOR))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.SERIES_PART_CONFLICT);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(e.getMessage())
                            .isEqualTo("Another post of this series already has this part in that language");
                });

        assertThat(member.getLanguage()).isEqualTo("vi");
        verify(postRepository, never()).saveAndFlush(any(Post.class));
    }

    @Test
    void a_post_with_no_series_or_no_declared_part_does_not_look_for_part_holders() {
        Post loose = post("bai-le", PostStatus.DRAFT);
        loose.setLanguage("vi");
        stubLoadAndSave(loose);
        Post handPlaced = post("tay", PostStatus.DRAFT);
        handPlaced.setLanguage("vi");
        inSeries(handPlaced, series(), 2);
        when(postRepository.findById(handPlaced.getId())).thenReturn(Optional.of(handPlaced));

        postService.update(loose.getId(), inLanguage("en"), EDITOR);
        postService.update(handPlaced.getId(), inLanguage("en"), EDITOR);

        assertThat(loose.getLanguage()).isEqualTo("en");
        assertThat(handPlaced.getLanguage()).isEqualTo("en");
        verify(postRepository, never()).findSeriesPartHolders(any(), any(), anyInt());
    }

    // --- Batched read model ------------------------------------------------------------------

    @Test
    void page_of_posts_looks_up_views_and_part_counts_exactly_once_for_the_whole_page() {
        Series series = series();
        PostCard part3 = card("phan-ba", PostStatus.PUBLISHED);
        PostCard draft = card("phan-hai", PostStatus.DRAFT);
        PostCard part1 = card("phan-mot", PostStatus.PUBLISHED);
        PostCard loose = card("bai-le", PostStatus.PUBLISHED);
        inSeries(part3, series, 3);
        inSeries(draft, series, 2);
        inSeries(part1, series, 1);
        when(postCardRepository.findAll(any(Pageable.class)))
                .thenReturn(new PageImpl<>(List.of(part3, draft, part1, loose)));
        when(postViewRepository.findAllByPostIdIn(any())).thenReturn(List.of(new PostView(part1.getId(), 12)));
        when(postRepository.findPartNumbers(any())).thenReturn(List.of(row(part1, 1, 2), row(part3, 2, 2)));

        List<PostSummaryResponse> page = postService.listAll(0, 20, null).getContent();

        // One views query for all posts of the page and one part-count query for the page's series: the number of
        // queries
        // does not grow with the number of posts (verify defaults to exactly once).
        verify(postViewRepository)
                .findAllByPostIdIn(argThat(ids ->
                        Set.copyOf(ids).equals(Set.of(part3.getId(), draft.getId(), part1.getId(), loose.getId()))));
        verify(postRepository).findPartNumbers(argThat(ids -> Set.copyOf(ids).equals(Set.of(series.getId()))));
        assertThat(page).extracting(PostSummaryResponse::viewCount).containsExactly(0L, 0L, 12L, 0L);
        assertThat(page.get(0).series().partNumber()).isEqualTo(2);
        assertThat(page.get(0).series().partCount()).isEqualTo(2);
        assertThat(page.get(2).series().partNumber()).isEqualTo(1);
        // An unpublished version still knows which series it belongs to but has no part number; a standalone post has
        // no series.
        assertThat(page.get(1).series().position()).isEqualTo(2);
        assertThat(page.get(1).series().partNumber()).isNull();
        assertThat(page.get(1).series().partCount()).isNull();
        assertThat(page.get(3).series()).isNull();
    }

    @Test
    void page_without_published_post_in_a_series_does_not_look_up_part_counts() {
        PostCard draft = card("ban-chua-xong", PostStatus.DRAFT);
        inSeries(draft, series(), 1);
        PostCard loose = card("bai-le", PostStatus.PUBLISHED);
        when(postCardRepository.findAll(any(Pageable.class))).thenReturn(new PageImpl<>(List.of(draft, loose)));

        List<PostSummaryResponse> page = postService.listAll(0, 20, null).getContent();

        // Part numbers count only published parts: a page with only unpublished versions in a series need not ask the
        // DB.
        verify(postRepository, never()).findPartNumbers(any());
        assertThat(page.get(0).series()).isNotNull();
        assertThat(page.get(0).series().partNumber()).isNull();
        assertThat(page.get(1).series()).isNull();
    }

    private static Post post(String slug, PostStatus status) {
        Post post = new Post();
        post.setId(UUID.randomUUID());
        post.setTitle(slug);
        post.setSlug(slug);
        post.setContent("Content");
        post.setStatus(status);
        post.setAuthor(author());
        return post;
    }

    /** A row of a list: the same fields as {@link #post}, without a body. */
    private static PostCard card(String slug, PostStatus status) {
        PostCard card = new PostCard();
        card.setId(UUID.randomUUID());
        card.setTitle(slug);
        card.setSlug(slug);
        card.setStatus(status);
        card.setAuthor(author());
        return card;
    }

    private static Series series() {
        Series series = new Series();
        series.setId(UUID.randomUUID());
        series.setTitle("Series A");
        series.setSlug("series-a");
        return series;
    }

    /** Series members are written only by dedicated SQL, the entity has no setter: the test assigns the field directly. */
    private static void inSeries(PostHead post, Series series, int position) {
        ReflectionTestUtils.setField(post, "series", series);
        ReflectionTestUtils.setField(post, "seriesPosition", position);
    }

    private static PartNumberRow row(PostHead post, int partNumber, int partCount) {
        return new PartNumberRow() {
            @Override
            public UUID getPostId() {
                return post.getId();
            }

            @Override
            public int getPartNumber() {
                return partNumber;
            }

            @Override
            public int getPartCount() {
                return partCount;
            }
        };
    }
}
