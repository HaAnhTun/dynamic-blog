package com.blog.post.controller;

import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.category.entity.Category;
import com.blog.category.repository.CategoryRepository;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostStatus;
import com.blog.post.repository.PostRepository;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.tag.entity.Tag;
import com.blog.tag.repository.TagRepository;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.RequestBuilder;
import tools.jackson.databind.ObjectMapper;

@AutoConfigureMockMvc
class PostControllerIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private PostRepository postRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private CategoryRepository categoryRepository;

    @Autowired
    private TagRepository tagRepository;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthTestSupport auth;

    private User author;

    @BeforeEach
    void setUp() {
        author = userRepository.findByEmail("admin@blog.local").orElseThrow();
    }

    private Post persistPost(String title, String slug, PostStatus status, Instant publishedAt) {
        Post post = new Post();
        post.setTitle(title);
        post.setSlug(slug);
        post.setContent("Content");
        post.setStatus(status);
        post.setLanguage("vi");
        post.setAuthor(author);
        post.setPublishedAt(publishedAt);
        return postRepository.save(post);
    }

    @Test
    void publicListOnlyReturnsPublishedPosts() throws Exception {
        persistPost("Published Post", "published-post", PostStatus.PUBLISHED, Instant.now());
        persistPost("Draft Post", "draft-post", PostStatus.DRAFT, null);
        persistPost("Archived Post", "archived-post", PostStatus.ARCHIVED, Instant.now());

        mockMvc.perform(get("/api/v1/posts").param("size", "100"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.slug == 'published-post')]").exists())
                .andExpect(jsonPath("$.data[?(@.slug == 'draft-post')]").doesNotExist())
                .andExpect(jsonPath("$.data[?(@.slug == 'archived-post')]").doesNotExist());
    }

    @Test
    void draftPostIsNotReachableViaPublicDetailEndpoint() throws Exception {
        persistPost("Draft Post", "unreachable-draft", PostStatus.DRAFT, null);

        mockMvc.perform(get("/api/v1/posts/unreachable-draft"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));
    }

    @Test
    void archivedPostIsNotReachableViaPublicDetailEndpoint() throws Exception {
        persistPost("Archived Post", "unreachable-archived", PostStatus.ARCHIVED, Instant.now());

        mockMvc.perform(get("/api/v1/posts/unreachable-archived"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));
    }

    @Test
    void listBeyondLastPageReturnsEmptyDataNotError() throws Exception {
        persistPost("Only Post", "only-post", PostStatus.PUBLISHED, Instant.now());

        // "Beyond the last page" is read from the API, not assumed. This suite shares one
        // non-rolled-back database with every other integration test class, and a fixed page
        // number stopped being beyond the end once those classes had published more than 50
        // posts between them (the comment, like and moderation suites were added later).
        String first = mockMvc.perform(get("/api/v1/posts").param("size", "10"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        int beyond = objectMapper.readTree(first).at("/pagination/totalPages").asInt();

        mockMvc.perform(get("/api/v1/posts")
                        .param("page", String.valueOf(beyond))
                        .param("size", "10"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(0))
                .andExpect(jsonPath("$.pagination.page").value(beyond));
    }

    /**
     * A page's start offset is page x size, and JPA takes it as an int: page=2147483647&size=100 used to be a 500,
     * on all three public lists that paginate by offset. Now page is clamped to the largest page that still fits,
     * {@code Integer.MAX_VALUE / 100} = 21474836, like the admin lists: an empty page, and pagination reports the page
     * that was returned.
     */
    @Test
    void aPageTooLargeForAnOffsetIsClampedToAnEmptyPageNotA500() throws Exception {
        persistPost("Clamp Post", "clamp-post-" + UUID.randomUUID(), PostStatus.PUBLISHED, Instant.now());

        for (String page : new String[] {"2147483647", "21474837"}) {
            for (RequestBuilder request : List.of(
                    get("/api/v1/posts").param("page", page).param("size", "100"),
                    get("/api/v1/posts")
                            .param("sort", "popular")
                            .param("page", page)
                            .param("size", "100"),
                    get("/api/v1/posts/search")
                            .param("q", "clamp")
                            .param("page", page)
                            .param("size", "100"))) {
                mockMvc.perform(request)
                        .andExpect(status().isOk())
                        .andExpect(jsonPath("$.data.length()").value(0))
                        .andExpect(jsonPath("$.pagination.page").value(21474836))
                        .andExpect(jsonPath("$.pagination.size").value(100));
            }
        }
        // Control: the largest page that still fits passes through intact, as before.
        mockMvc.perform(get("/api/v1/posts").param("page", "21474836").param("size", "100"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.pagination.page").value(21474836));
    }

    @Test
    void listReturnsPaginationMetadata() throws Exception {
        persistPost("Pagination Post", "pagination-post", PostStatus.PUBLISHED, Instant.now());

        String response = mockMvc.perform(
                        get("/api/v1/posts").param("page", "0").param("size", "5"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.pagination.size").value(5))
                .andReturn()
                .getResponse()
                .getContentAsString();

        var pagination = objectMapper.readTree(response).at("/pagination");
        // Exact counts aren't assertable: this suite shares one non-rolled-back database
        // with every other integration test class, so at least one is all we can pin.
        org.assertj.core.api.Assertions.assertThat(
                        pagination.at("/totalElements").asLong())
                .isGreaterThanOrEqualTo(1);
        org.assertj.core.api.Assertions.assertThat(pagination.at("/totalPages").asInt())
                .isGreaterThanOrEqualTo(1);
    }

    @Test
    void postsWithCollidingTitlesAreBothReachableAtDistinctSlugs() throws Exception {
        // A distinct title from every other title used across the integration suite
        // (see AdminPostControllerIT.createUpdateAndDeletePost, which pins the exact
        // slug "spring-boot-basics") so this test's slug assertions stay order-independent.
        Category category = new Category();
        category.setName("Slug Collision Category " + UUID.randomUUID());
        category.setSlug("slug-collision-category-" + UUID.randomUUID());
        categoryRepository.save(category);

        String title = "Collision Clash Title " + UUID.randomUUID();
        String payload = objectMapper.writeValueAsString(
                new PostPayload(title, "Excerpt", "Noi dung", category.getId(), Set.of()));

        String firstResponse = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String secondResponse = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();

        String firstSlug = objectMapper.readTree(firstResponse).at("/data/slug").asText();
        String secondSlug =
                objectMapper.readTree(secondResponse).at("/data/slug").asText();
        String firstId = objectMapper.readTree(firstResponse).at("/data/id").asText();
        String secondId = objectMapper.readTree(secondResponse).at("/data/id").asText();

        org.assertj.core.api.Assertions.assertThat(firstSlug).isNotEqualTo(secondSlug);

        // Both posts start as DRAFT, so publish them before asserting they are reachable
        // through the public slug endpoint.
        mockMvc.perform(post("/api/v1/admin/posts/" + firstId + "/publish")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/admin/posts/" + secondId + "/publish")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/posts/" + firstSlug))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.slug").value(firstSlug));
        mockMvc.perform(get("/api/v1/posts/" + secondSlug))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.slug").value(secondSlug));
    }

    @Test
    void listFiltersByCategorySlug() throws Exception {
        Category category = new Category();
        category.setName("Filter Category");
        category.setSlug("filter-category");
        categoryRepository.save(category);

        Post inCategory = persistPost("In Category", "in-category", PostStatus.PUBLISHED, Instant.now());
        inCategory.setCategory(category);
        postRepository.save(inCategory);

        persistPost("Outside Category", "outside-category", PostStatus.PUBLISHED, Instant.now());

        mockMvc.perform(get("/api/v1/posts")
                        .param("category", "filter-category")
                        .param("size", "100"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.slug == 'in-category')]").exists())
                .andExpect(jsonPath("$.data[?(@.slug == 'outside-category')]").doesNotExist());
    }

    @Test
    void listFiltersByTagSlug() throws Exception {
        Tag tag = new Tag();
        tag.setName("Filter Tag");
        tag.setSlug("filter-tag");
        tagRepository.save(tag);

        Post tagged = persistPost("Tagged", "tagged-post", PostStatus.PUBLISHED, Instant.now());
        tagged.setTags(Set.of(tag));
        postRepository.save(tagged);

        persistPost("Untagged", "untagged-post", PostStatus.PUBLISHED, Instant.now());

        mockMvc.perform(get("/api/v1/posts").param("tag", "filter-tag").param("size", "100"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.slug == 'tagged-post')]").exists())
                .andExpect(jsonPath("$.data[?(@.slug == 'untagged-post')]").doesNotExist());
    }

    private record PostPayload(String title, String excerpt, String content, UUID categoryId, Set<UUID> tagIds) {}
}
