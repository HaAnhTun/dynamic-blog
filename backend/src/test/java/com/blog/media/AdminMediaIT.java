package com.blog.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.media.config.MediaProperties;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.io.InputStream;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Used image storage: {@code GET /api/v1/admin/media/usage}, ADMIN only.
 *
 * The number must be exactly the quota figure checked at upload time (the total {@code byte_size} of every image: cover, gallery, post body) and
 * the cap must be exactly the configured {@code app.media.max-total-size}. The shared DB is never cleaned, so every comparison
 * is a difference before and after one upload or delete, checked against the media table itself.
 */
@AutoConfigureMockMvc
class AdminMediaIT extends AbstractIntegrationTest {

    private static final String USAGE = "/api/v1/admin/media/usage";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MediaProperties mediaProperties;

    @Test
    void usage_equals_media_table_total_rising_on_upload_and_falling_on_delete() throws Exception {
        String admin = auth.bearerForAdmin();
        JsonNode before = usage(admin);
        assertThat(before.propertyNames()).containsExactlyInAnyOrder("usedBytes", "maxBytes", "count");
        assertThat(before.path("usedBytes").asLong()).isEqualTo(storedBytes());
        assertThat(before.path("count").asLong()).isEqualTo(storedCount());
        assertThat(before.path("maxBytes").asLong())
                .isEqualTo(mediaProperties.maxTotalSize().toBytes());

        // An image in a post body: the same pool as cover and gallery images.
        UUID postId = createPost(admin);
        JsonNode image = data(mockMvc.perform(multipart("/api/v1/admin/posts/" + postId + "/images")
                        .file(new MockMultipartFile("file", "opaque.png", "image/png", fixture("opaque.png")))
                        .header("Authorization", admin))
                .andExpect(status().isOk()));
        long imageSize = jdbcTemplate.queryForObject(
                "SELECT byte_size FROM media WHERE id = ?",
                Long.class,
                UUID.fromString(image.path("id").asString()));

        JsonNode afterUpload = usage(admin);
        assertThat(afterUpload.path("usedBytes").asLong())
                .isEqualTo(before.path("usedBytes").asLong() + imageSize);
        assertThat(afterUpload.path("count").asLong())
                .isEqualTo(before.path("count").asLong() + 1);
        assertThat(afterUpload.path("maxBytes").asLong())
                .isEqualTo(before.path("maxBytes").asLong());

        mockMvc.perform(delete("/api/v1/admin/posts/" + postId + "/images/"
                                + image.path("id").asString())
                        .header("Authorization", admin))
                .andExpect(status().isOk());

        JsonNode afterDelete = usage(admin);
        assertThat(afterDelete.path("usedBytes").asLong())
                .isEqualTo(before.path("usedBytes").asLong());
        assertThat(afterDelete.path("count").asLong())
                .isEqualTo(before.path("count").asLong());
        assertThat(afterDelete.path("usedBytes").asLong()).isEqualTo(storedBytes());
    }

    @Test
    void only_admin_can_view_author_and_reader_get_403_anonymous_gets_401() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String author = auth.bearerFor(auth.createAuthor("media-usage-" + suffix + "@blog.local"));
        String reader = auth.bearerFor(auth.createReader(auth.nextGithubId(), "media-usage-" + suffix));

        assertError(mockMvc.perform(get(USAGE).header("Authorization", author)), 403, "FORBIDDEN");
        assertError(mockMvc.perform(get(USAGE).header("Authorization", reader)), 403, "FORBIDDEN");
        assertError(mockMvc.perform(get(USAGE)), 401, "UNAUTHENTICATED");
        // The /api/v1/admin/media tree has only this path: another method or another ADMIN path is 404/405, not open.
        assertError(mockMvc.perform(get("/api/v1/admin/media").header("Authorization", author)), 403, "FORBIDDEN");
        assertError(
                mockMvc.perform(post(USAGE).header("Authorization", auth.bearerForAdmin())), 405, "VALIDATION_ERROR");
    }

    // --- Helpers -------------------------------------------------------------------------------------

    private JsonNode usage(String token) throws Exception {
        return data(mockMvc.perform(get(USAGE).header("Authorization", token)).andExpect(status().isOk()));
    }

    private long storedBytes() {
        return jdbcTemplate.queryForObject("SELECT coalesce(sum(byte_size), 0) FROM media", Long.class);
    }

    private long storedCount() {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM media", Long.class);
    }

    private UUID createPost(String admin) throws Exception {
        String payload = objectMapper.writeValueAsString(
                Map.of("title", "Post measuring image size " + UUID.randomUUID(), "content", "Content measuring size"));
        return UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/posts")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content(payload))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        MockHttpServletResponse response = result.andReturn().getResponse();
        String body = response.getContentAsString();
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .as(body)
                .isEqualTo(code);
    }

    private static byte[] fixture(String name) throws Exception {
        try (InputStream in = AdminMediaIT.class.getResourceAsStream("/media/" + name)) {
            assertThat(in).as("fixture %s", name).isNotNull();
            return in.readAllBytes();
        }
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }
}
