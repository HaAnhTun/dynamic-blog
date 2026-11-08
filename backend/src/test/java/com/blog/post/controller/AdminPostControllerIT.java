package com.blog.post.controller;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

@AutoConfigureMockMvc
class AdminPostControllerIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthTestSupport auth;

    @Test
    void createUpdateAndDeletePost() throws Exception {
        String createPayload = objectMapper.writeValueAsString(
                new PostPayload("Spring Boot Basics", "Excerpt", "Post content", null, Set.of()));

        String createResponse = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createPayload))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.slug").value("spring-boot-basics"))
                .andExpect(jsonPath("$.data.status").value("DRAFT"))
                .andReturn()
                .getResponse()
                .getContentAsString();

        String id = objectMapper.readTree(createResponse).at("/data/id").asText();

        String updatePayload = objectMapper.writeValueAsString(
                new PostPayload("Spring Boot Basics v2", "Excerpt v2", "Updated content", null, Set.of()));

        mockMvc.perform(put("/api/v1/admin/posts/" + id)
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(updatePayload))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.title").value("Spring Boot Basics v2"));

        mockMvc.perform(delete("/api/v1/admin/posts/" + id).header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isNoContent());
    }

    @Test
    void getByIdReturnsPostAndUnknownIdReturns404() throws Exception {
        String createPayload =
                objectMapper.writeValueAsString(new PostPayload("Fetch Me", "Excerpt", "Content", null, Set.of()));

        String createResponse = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createPayload))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();

        String id = objectMapper.readTree(createResponse).at("/data/id").asText();

        mockMvc.perform(get("/api/v1/admin/posts/" + id).header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.title").value("Fetch Me"));

        mockMvc.perform(get("/api/v1/admin/posts/" + UUID.randomUUID()).header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));
    }

    @Test
    void publishTransitionsDraftToPublishedAndPreservesPublishedAtOnRepublish() throws Exception {
        // Unique per run: this suite shares one non-rolled-back database with every other
        // integration test class (e.g. CategoryControllerIT also creates a "Backend" category),
        // so a fixed name would collide and fail with 409 CATEGORY_ALREADY_EXISTS depending on
        // test execution order.
        String categoryPayload =
                objectMapper.writeValueAsString(new CategoryPayload("Publish Workflow " + UUID.randomUUID(), null));
        String categoryResponse = mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(categoryPayload))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String categoryId =
                objectMapper.readTree(categoryResponse).at("/data/id").asText();

        String createPayload = objectMapper.writeValueAsString(
                new PostPayload("Publishable Post", "Excerpt", "Full content", UUID.fromString(categoryId), Set.of()));
        String createResponse = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createPayload))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String postId = objectMapper.readTree(createResponse).at("/data/id").asText();

        String firstPublishResponse = mockMvc.perform(post("/api/v1/admin/posts/" + postId + "/publish")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("PUBLISHED"))
                .andReturn()
                .getResponse()
                .getContentAsString();
        String firstPublishedAt = objectMapper
                .readTree(firstPublishResponse)
                .at("/data/publishedAt")
                .asText();

        String secondPublishResponse = mockMvc.perform(post("/api/v1/admin/posts/" + postId + "/publish")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String secondPublishedAt = objectMapper
                .readTree(secondPublishResponse)
                .at("/data/publishedAt")
                .asText();

        org.assertj.core.api.Assertions.assertThat(secondPublishedAt).isEqualTo(firstPublishedAt);
    }

    @Test
    void publishingPostWithoutCategoryFails() throws Exception {
        String createPayload =
                objectMapper.writeValueAsString(new PostPayload("No Category Post", null, "Content", null, Set.of()));
        String createResponse = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createPayload))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String postId = objectMapper.readTree(createResponse).at("/data/id").asText();

        mockMvc.perform(post("/api/v1/admin/posts/" + postId + "/publish")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_PUBLISHABLE"));
    }

    @Test
    void createRejectsContentOverTheSizeLimitAndAcceptsContentAtIt() throws Exception {
        String tooLong = objectMapper.writeValueAsString(
                new PostPayload("Oversized Content Draft", "Excerpt", "c".repeat(500_001), null, Set.of()));
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(tooLong))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));

        String atTheLimit = objectMapper.writeValueAsString(
                new PostPayload("Largest Content Draft", "Excerpt", "c".repeat(500_000), null, Set.of()));
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(atTheLimit))
                .andExpect(status().isCreated());
    }

    @Test
    void updateRejectsAnExcerptOverTheSizeLimit() throws Exception {
        String createResponse = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                new PostPayload("Excerpt Limit Draft", "Excerpt", "Content", null, Set.of()))))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String id = objectMapper.readTree(createResponse).at("/data/id").asText();

        mockMvc.perform(put("/api/v1/admin/posts/" + id)
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                new PostPayload("Excerpt Limit Draft", "e".repeat(1_001), "Content", null, Set.of()))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void listAllReturnsDraftPostsThatThePublicListingHides() throws Exception {
        // A title/slug used nowhere else in the suite: the admin list is unfiltered, so a
        // colliding slug here would make this test's existence assertion ambiguous.
        String createPayload = objectMapper.writeValueAsString(
                new PostPayload("Admin Only Draft Listing", "Excerpt", "Noi dung", null, Set.of()));

        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createPayload))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.status").value("DRAFT"));

        mockMvc.perform(get("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .param("size", "100"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.slug == 'admin-only-draft-listing')]")
                        .exists())
                .andExpect(jsonPath("$.pagination.size").value(100));
    }

    @Test
    void listAllClampsAPageTooLargeForAnOffsetInsteadOfFailingWith500() throws Exception {
        // page × size is the offset, and JPA takes it as an int (V6 P3-13): page=2147483647&size=100 used to be a
        // 500. The page is now clamped to Integer.MAX_VALUE / 100 = 21474836, as on the users and comments lists.
        // Both branches of listAll: every author (ADMIN) and one author's own posts (AUTHOR).
        String author = auth.bearerFor(auth.createAuthor("clamp-author-" + UUID.randomUUID() + "@blog.local"));
        for (String bearer : new String[] {auth.bearerForAdmin(), author}) {
            mockMvc.perform(get("/api/v1/admin/posts")
                            .header("Authorization", bearer)
                            .param("page", "2147483647")
                            .param("size", "100"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.length()").value(0))
                    .andExpect(jsonPath("$.pagination.page").value(21474836))
                    .andExpect(jsonPath("$.pagination.size").value(100));
        }
    }

    private record PostPayload(String title, String excerpt, String content, UUID categoryId, Set<UUID> tagIds) {}

    private record CategoryPayload(String name, String description) {}
}
