package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.media.config.MediaProperties;
import com.blog.media.dto.MediaResponse;
import com.blog.media.repository.MediaContentRepository;
import com.blog.media.repository.MediaRepository;
import com.blog.media.service.ImageProcessor;
import com.blog.media.service.MediaService;
import com.blog.post.repository.PostRepository;
import com.blog.post.service.PostImageService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.util.unit.DataSize;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Images inside the post body: {@code POST/GET /api/v1/admin/posts/{id}/images} and
 * {@code DELETE /api/v1/admin/posts/{id}/images/{mediaId}}.
 *
 * An image belongs to the post it was uploaded to ({@code media.post_id}): listed per post, deletable through the post, and it
 * goes with the post when the post is deleted, bytes included. Cover and gallery images are never a post's "body image", so the
 * delete endpoint here cannot touch them. The quota is one shared pot with cover and gallery images.
 *
 * Like PostCoverIT: every request goes through the real filter chain with a real token (permission is the post's {@code CAN_MANAGE}),
 * and every case checks both sides, the API's answer AND whether the image is really still served at its public URL.
 *
 * The DB is shared and never cleaned: each test has its own category, post name and file name (random suffix). Table-wide
 * counts (quota) compare only differences before and after, never absolute numbers.
 */
@AutoConfigureMockMvc
class PostImageIT extends AbstractIntegrationTest {

    private static final String IMAGES_URL = "/api/v1/admin/posts/%s/images";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private MediaService mediaService;

    @Autowired
    private ImageProcessor imageProcessor;

    @Autowired
    private MediaProperties mediaProperties;

    @Autowired
    private com.blog.common.ratelimit.RateLimiter rateLimiter;

    @Autowired
    private com.blog.common.quota.AuthorQuotaProperties authorQuota;

    @Autowired
    private MediaRepository mediaRepository;

    @Autowired
    private MediaContentRepository mediaContentRepository;

    @Autowired
    private PostRepository postRepository;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private String admin;
    private String suffix;
    private UUID categoryId;

    @BeforeEach
    void setUp() throws Exception {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
        categoryId = UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/categories")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(
                                        Map.of("name", "Category body images " + suffix))))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
    }

    // --- Upload, list, delete -----------------------------------------------------------------------

    @Test
    void upload_returns_processed_image_served_and_owned_by_the_post_without_becoming_its_cover() throws Exception {
        UUID postId = createPost(admin, "Post with an image in the body");
        String altText = "Screenshot " + suffix;

        JsonNode image =
                data(upload(admin, postId, "orient6.jpg", "  " + altText + "  ").andExpect(status().isOk()));

        // Same shape as the cover (MediaResponse): enough for the editor to insert ![alt](/media/<fileName>) without
        // re-reading.
        assertThat(image.propertyNames())
                .containsExactlyInAnyOrder("id", "fileName", "width", "height", "altText", "dominantColor");
        UUID mediaId = UUID.fromString(image.path("id").asString());
        assertThat(image.path("fileName").asString()).isEqualTo(mediaId + ".jpg");
        // orient6.jpg is stored 30×20 with EXIF Orientation=6: the image is upright, 20×30, like the cover.
        assertThat(image.path("width").asInt()).isEqualTo(20);
        assertThat(image.path("height").asInt()).isEqualTo(30);
        assertThat(image.path("altText").asString()).isEqualTo(altText);
        assertThat(image.path("dominantColor").asString()).matches("^#[0-9a-f]{6}$");
        assertServed(image.path("fileName").asString(), "image/jpeg");

        // Belongs to the post, the uploader is the token's owner; the post does not get a cover because of it.
        assertThat(jdbcTemplate.queryForObject("SELECT post_id FROM media WHERE id = ?", UUID.class, mediaId))
                .isEqualTo(postId);
        assertThat(jdbcTemplate.queryForObject("SELECT uploaded_by FROM media WHERE id = ?", UUID.class, mediaId))
                .isEqualTo(adminId());
        JsonNode detail = adminDetail(postId);
        assertThat(detail.path("cover").isNull()).isTrue();
        // Nothing is inserted into the post body: that is the editor's job.
        assertThat(detail.path("content").asString()).doesNotContain(mediaId.toString());
    }

    @Test
    void list_is_newest_first_with_only_that_posts_images_and_delete_returns_200_with_remaining_images()
            throws Exception {
        UUID postId = createPost(admin, "Post listing images");
        UUID other = createPost(admin, "Other post with its own image");
        JsonNode first = data(upload(admin, postId, "orient6.jpg", null).andExpect(status().isOk()));
        JsonNode second = data(
                upload(admin, postId, "opaque.png", "Second image " + suffix).andExpect(status().isOk()));
        JsonNode elsewhere = data(upload(admin, other, "opaque.png", null).andExpect(status().isOk()));
        // Control: a cover on the same post is not a body image.
        uploadCover(admin, postId, "opaque.png");

        JsonNode listed = data(list(admin, postId).andExpect(status().isOk()));
        assertThat(ids(listed)).containsExactly(id(second), id(first));
        // Same shape as at upload time, including the empty description (null, not an empty string).
        assertThat(listed.get(0)).isEqualTo(second);
        assertThat(listed.get(1).path("altText").isNull()).isTrue();

        JsonNode remaining = data(remove(admin, postId, id(second)).andExpect(status().isOk()));

        // 200 with the remaining list rather than 204: admin-api cannot read a 204.
        assertThat(ids(remaining)).containsExactly(id(first));
        assertGone(second.path("fileName").asString());
        assertThat(mediaRows(id(second))).isZero();
        // Bytes follow the metadata (ON DELETE CASCADE of media_content): no few MB left that nothing points to.
        assertThat(contentRows(id(second))).isZero();
        assertServed(first.path("fileName").asString(), "image/jpeg");
        assertServed(elsewhere.path("fileName").asString(), "image/png");
        assertThat(ids(data(list(admin, postId).andExpect(status().isOk())))).containsExactly(id(first));

        // Deleting again: the image is no longer a body image of this post.
        assertError(remove(admin, postId, id(second)), 404, "MEDIA_NOT_FOUND");
    }

    @Test
    void two_overlapping_deletes_of_same_image_make_the_second_wait_then_return_404_not_500() throws Exception {
        UUID postId = createPost(admin, "Post deleting an image twice concurrently");
        UUID image = id(data(upload(admin, postId, "opaque.png", null).andExpect(status().isOk())));

        ExecutorService pool = Executors.newSingleThreadExecutor();
        // The first delete (repeated click, two tabs) is half done: holds the post's row lock like every image
        // operation of the post, has deleted the image, not yet
        // committed.
        try (HeldTransaction first = new HeldTransaction(transactionManager, jdbcTemplate, jdbc -> {
            jdbc.queryForObject("SELECT id FROM posts WHERE id = ? FOR NO KEY UPDATE", UUID.class, postId);
            jdbc.update("DELETE FROM media WHERE id = ?", image);
        })) {
            Future<MockHttpServletResponse> second =
                    pool.submit(() -> remove(admin, postId, image).andReturn().getResponse());
            // Control that the two deletes really overlap: the second is waiting, not finished.
            assertThatThrownBy(() -> second.get(500, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            first.commit();

            // Without locking the post the second reads the image (the first has not committed), then its DELETE
            // statement touches 0 rows: Hibernate
            // treats that as a write conflict, and the request becomes a 500.
            MockHttpServletResponse response = second.get(30, TimeUnit.SECONDS);
            assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(404);
            assertThat(objectMapper
                            .readTree(response.getContentAsString())
                            .path("error")
                            .path("code")
                            .asString())
                    .isEqualTo("MEDIA_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }
        assertThat(mediaRows(image)).isZero();
    }

    @Test
    void post_without_images_returns_empty_list() throws Exception {
        UUID postId = createPost(admin, "Post without body images");

        JsonNode listed = data(list(admin, postId).andExpect(status().isOk()));

        assertThat(listed.isArray()).isTrue();
        assertThat(listed).isEmpty();
    }

    // --- The delete path does not touch the cover, gallery images or another post's images ----------

    @Test
    void cover_gallery_and_other_posts_images_cannot_be_deleted_through_the_body_image_endpoint() throws Exception {
        UUID postId = createPost(admin, "Post trying to delete the wrong image");
        UUID other = createPost(admin, "Post keeping its own image");
        JsonNode cover = uploadCover(admin, postId, "opaque.png");
        JsonNode gallery = uploadGallery("orient6.jpg");
        JsonNode othersImage = data(upload(admin, other, "opaque.png", null).andExpect(status().isOk()));
        // Control: this post has a real body image, so the 404 below is not because the post has no images at all.
        JsonNode own = data(upload(admin, postId, "orient6.jpg", null).andExpect(status().isOk()));

        assertError(remove(admin, postId, id(cover)), 404, "MEDIA_NOT_FOUND");
        assertError(remove(admin, postId, id(gallery)), 404, "MEDIA_NOT_FOUND");
        assertError(remove(admin, postId, id(othersImage)), 404, "MEDIA_NOT_FOUND");
        assertError(remove(admin, postId, UUID.randomUUID()), 404, "MEDIA_NOT_FOUND");

        // All three are intact, in their own places.
        assertServed(cover.path("fileName").asString(), "image/png");
        assertThat(adminDetail(postId).path("cover").path("id").asString())
                .isEqualTo(id(cover).toString());
        assertServed(gallery.path("fileName").asString(), "image/jpeg");
        assertServed(othersImage.path("fileName").asString(), "image/png");
        assertThat(ids(data(list(admin, other).andExpect(status().isOk())))).containsExactly(id(othersImage));
        // Cover and gallery images never show up in the body-image list either.
        assertThat(ids(data(list(admin, postId).andExpect(status().isOk())))).containsExactly(id(own));
    }

    // --- Deleting a post takes its images with it --------------------------------------------------

    @Test
    void deleting_post_deletes_all_its_body_images_and_their_bytes_and_only_those() throws Exception {
        UUID doomed = createPost(admin, "Post deleted with its body images");
        UUID survivor = createPost(admin, "Remaining post keeping its body images");
        List<JsonNode> doomedImages = List.of(
                data(upload(admin, doomed, "orient6.jpg", null).andExpect(status().isOk())),
                data(upload(admin, doomed, "opaque.png", "Image that follows the post " + suffix)
                        .andExpect(status().isOk())));
        JsonNode doomedCover = uploadCover(admin, doomed, "opaque.png");
        JsonNode kept = data(upload(admin, survivor, "opaque.png", null).andExpect(status().isOk()));

        mockMvc.perform(delete("/api/v1/admin/posts/" + doomed).header("Authorization", admin))
                .andExpect(status().isNoContent());

        for (JsonNode image : doomedImages) {
            assertGone(image.path("fileName").asString());
            assertThat(mediaRows(id(image))).isZero();
            assertThat(contentRows(id(image))).isZero();
        }
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM media WHERE post_id = ?", Long.class, doomed))
                .isZero();
        // The cover still goes with the post as before.
        assertGone(doomedCover.path("fileName").asString());
        // Control: another post's image is not dragged along.
        assertServed(kept.path("fileName").asString(), "image/png");
        assertThat(contentRows(id(kept))).isEqualTo(1);
        // A deleted post has no image list left to read.
        assertError(list(admin, doomed), 404, "POST_NOT_FOUND");
    }

    // --- Quota shared with cover and gallery ------------------------------------------------------

    @Test
    void body_images_share_quota_with_cover_and_gallery_images() throws Exception {
        UUID postId = createPost(admin, "Post testing the body image quota");
        long coverSize = storedByteSize(id(uploadCover(admin, postId, "orient6.jpg")));
        long gallerySize = storedByteSize(id(uploadGallery("opaque.png")));
        // The size of the new image AFTER the pipeline; the pipeline is deterministic, so the upload below stores
        // exactly this many bytes.
        long nextSize = mediaService
                .prepare(fixtureFile("opaque.png", "image/png"))
                .image()
                .bytes()
                .length;
        long storedBefore = totalStoredBytes();

        // Would fit if the cover and gallery image just uploaded were not counted: still 422, because the quota is one
        // pot for all images.
        PostImageService tight = imagesWithQuota(storedBefore - coverSize - gallerySize + nextSize);
        assertThatThrownBy(() -> tight.upload(postId, fixtureFile("opaque.png", "image/png"), null, adminId()))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.MEDIA_QUOTA_EXCEEDED);
                    assertThat(e.getStatus().value()).isEqualTo(422);
                });
        // A rejection stores nothing.
        assertThat(totalStoredBytes()).isEqualTo(storedBefore);
        assertThat(data(list(admin, postId).andExpect(status().isOk()))).isEmpty();

        // Short by exactly one byte: 422; exact fit: accepted, and exactly that many bytes are added.
        assertThatThrownBy(() -> imagesWithQuota(storedBefore + nextSize - 1)
                        .upload(postId, fixtureFile("opaque.png", "image/png"), null, adminId()))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.MEDIA_QUOTA_EXCEEDED));
        MediaResponse stored = imagesWithQuota(storedBefore + nextSize)
                .upload(postId, fixtureFile("opaque.png", "image/png"), null, adminId());
        assertThat(totalStoredBytes() - storedBefore).isEqualTo(nextSize);
        assertThat(ids(data(list(admin, postId).andExpect(status().isOk())))).containsExactly(stored.id());
        assertServed(stored.fileName(), "image/png");
    }

    // --- Permissions: permission on body images is permission on the post ------------------------

    @Test
    void author_manages_images_of_own_post_cannot_touch_other_authors_images_and_anonymous_gets_401() throws Exception {
        User alice = auth.createAuthor("alice-images-" + UUID.randomUUID() + "@blog.local");
        User bob = auth.createAuthor("bob-images-" + UUID.randomUUID() + "@blog.local");
        String aliceToken = auth.bearerFor(alice);
        String bobToken = auth.bearerFor(bob);
        UUID alicePost = createPost(aliceToken, "Alice post with an image");
        UUID bobPost = createPost(bobToken, "Bob post with an image");
        JsonNode bobImage = data(
                upload(bobToken, bobPost, "opaque.png", "Bob image " + suffix).andExpect(status().isOk()));

        // Own post: upload, list, delete all allowed; the image records Alice as the uploader.
        JsonNode aliceImage =
                data(upload(aliceToken, alicePost, "orient6.jpg", null).andExpect(status().isOk()));
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT uploaded_by FROM media WHERE id = ?", UUID.class, id(aliceImage)))
                .isEqualTo(alice.getId());
        assertThat(ids(data(list(aliceToken, alicePost).andExpect(status().isOk()))))
                .containsExactly(id(aliceImage));
        assertThat(data(remove(aliceToken, alicePost, id(aliceImage)).andExpect(status().isOk())))
                .isEmpty();

        // Bob's post: all three are 403, even when the path names Bob's own image.
        assertError(
                upload(aliceToken, bobPost, "orient6.jpg", "Alice inserts an image into the Bob post"),
                403,
                "FORBIDDEN");
        assertError(list(aliceToken, bobPost), 403, "FORBIDDEN");
        assertError(remove(aliceToken, bobPost, id(bobImage)), 403, "FORBIDDEN");
        // Naming own post with Bob's image: that image is not this post's, 404, revealing nothing about the other post.
        assertError(remove(aliceToken, alicePost, id(bobImage)), 404, "MEDIA_NOT_FOUND");
        // A missing post: 403 for an AUTHOR, like every /{id} route, so no real post id can be probed.
        assertError(list(aliceToken, UUID.randomUUID()), 403, "FORBIDDEN");

        // Anonymous: 401 on all three endpoints.
        assertError(
                mockMvc.perform(multipart(imagesUrl(bobPost)).file(fixtureFile("orient6.jpg", "image/jpeg"))),
                401,
                "UNAUTHENTICATED");
        assertError(mockMvc.perform(get(imagesUrl(bobPost))), 401, "UNAUTHENTICATED");
        assertError(mockMvc.perform(delete(imagesUrl(bobPost) + "/" + id(bobImage))), 401, "UNAUTHENTICATED");

        // With only the status, a bug that rejects EVERY request would pass too: Bob's image must be intact, and Bob
        // still has only that one.
        assertServed(bobImage.path("fileName").asString(), "image/png");
        assertThat(ids(data(list(bobToken, bobPost).andExpect(status().isOk()))))
                .containsExactly(id(bobImage));
    }

    // --- Missing post, broken requests -------------------------------------------------------------

    @Test
    void missing_post_is_404_post_not_found_for_admin_before_any_image_processing() throws Exception {
        UUID ghost = UUID.randomUUID();

        // GIF bytes: if the image were processed before looking up the post, the answer would be 415.
        assertError(
                mockMvc.perform(multipart(imagesUrl(ghost)).file(gifFile()).header("Authorization", admin)),
                404,
                "POST_NOT_FOUND");
        assertError(list(admin, ghost), 404, "POST_NOT_FOUND");
        assertError(remove(admin, ghost, UUID.randomUUID()), 404, "POST_NOT_FOUND");
        assertError(
                mockMvc.perform(delete(imagesUrl(ghost) + "/khong-phai-uuid").header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
    }

    @Test
    void empty_missing_unaccepted_file_or_too_long_description_is_rejected_and_stores_nothing() throws Exception {
        UUID postId = createPost(admin, "Post receiving a broken image");
        long storedBefore = totalStoredBytes();

        assertError(
                mockMvc.perform(multipart(imagesUrl(postId))
                        .file(new MockMultipartFile("file", "rong.png", "image/png", new byte[0]))
                        .header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
        assertError(
                mockMvc.perform(multipart(imagesUrl(postId))
                        .param("altText", "Description only")
                        .header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
        assertError(
                mockMvc.perform(multipart(imagesUrl(postId)).file(gifFile()).header("Authorization", admin)),
                415,
                "MEDIA_UNSUPPORTED_TYPE");
        // A 301-character description is rejected BEFORE image processing: with GIF bytes, processing first would
        // answer 415.
        assertError(
                mockMvc.perform(multipart(imagesUrl(postId))
                        .file(gifFile())
                        .param("altText", "a".repeat(301))
                        .header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
        // JSON instead of multipart: 415 by content type.
        assertError(
                mockMvc.perform(post(imagesUrl(postId))
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"file\":\"aGVsbG8=\"}")),
                415,
                "VALIDATION_ERROR");

        assertThat(totalStoredBytes()).isEqualTo(storedBefore);
        assertThat(data(list(admin, postId).andExpect(status().isOk()))).isEmpty();
        // Control: the same post with a correct request works.
        upload(admin, postId, "opaque.png", "a".repeat(300))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.altText").value("a".repeat(300)));
    }

    // --- Helpers ------------------------------------------------------------------------------------

    private ResultActions upload(String token, UUID postId, String fixture, String altText) throws Exception {
        MockMultipartHttpServletRequestBuilder request =
                multipart(imagesUrl(postId)).file(fixtureFile(fixture, contentTypeOf(fixture)));
        if (altText != null) {
            request.param("altText", altText);
        }
        return mockMvc.perform(request.header("Authorization", token));
    }

    private ResultActions list(String token, UUID postId) throws Exception {
        return mockMvc.perform(get(imagesUrl(postId)).header("Authorization", token));
    }

    private ResultActions remove(String token, UUID postId, UUID mediaId) throws Exception {
        return mockMvc.perform(delete(imagesUrl(postId) + "/" + mediaId).header("Authorization", token));
    }

    /** The post's cover; returns the cover's MediaResponse. */
    private JsonNode uploadCover(String token, UUID postId, String fixture) throws Exception {
        return data(mockMvc.perform(multipart("/api/v1/admin/posts/" + postId + "/cover")
                                .file(fixtureFile(fixture, contentTypeOf(fixture)))
                                .header("Authorization", token))
                        .andExpect(status().isOk()))
                .path("cover");
    }

    /** A gallery image (hidden, so it does not leak onto the /gallery page of other ITs); returns the image's MediaResponse. */
    private JsonNode uploadGallery(String fixture) throws Exception {
        return data(mockMvc.perform(multipart("/api/v1/admin/gallery")
                                .file(fixtureFile(fixture, contentTypeOf(fixture)))
                                .param("published", "false")
                                .header("Authorization", admin))
                        .andExpect(status().isCreated()))
                .path("image");
    }

    private UUID createPost(String token, String title) throws Exception {
        String payload = objectMapper.writeValueAsString(Map.of(
                "title", title + " " + suffix,
                "excerpt", "Summary " + suffix,
                "content", "Body image test content " + suffix,
                "categoryId", categoryId.toString()));
        return UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/posts")
                                .header("Authorization", token)
                                .contentType(APPLICATION_JSON)
                                .content(payload))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
    }

    private JsonNode adminDetail(UUID postId) throws Exception {
        return data(mockMvc.perform(get("/api/v1/admin/posts/" + postId).header("Authorization", admin))
                .andExpect(status().isOk()));
    }

    private void assertServed(String fileName, String contentType) throws Exception {
        MockHttpServletResponse response = mockMvc.perform(get("/api/v1/media/" + fileName))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse();
        assertThat(response.getContentType()).isEqualTo(contentType);
        assertThat(response.getContentAsByteArray()).isNotEmpty();
    }

    private void assertGone(String fileName) throws Exception {
        assertError(mockMvc.perform(get("/api/v1/media/" + fileName)), 404, "MEDIA_NOT_FOUND");
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        MockHttpServletResponse response = result.andReturn().getResponse();
        String body = response.getContentAsString();
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .as(body)
                .isEqualTo(code);
    }

    /**
     * The real PostImageService on a real DB, differing only in the quota, like PostCoverIT: a small quota via
     * {@code @TestPropertySource} would mean one more Spring context. The transaction comes from PostImageService
     * (TransactionTemplate), so a hand-built MediaService still saves within the upload's own transaction.
     */
    private PostImageService imagesWithQuota(long quotaBytes) {
        MediaProperties tight = new MediaProperties(
                mediaProperties.maxUploadSize(),
                mediaProperties.maxStoredSize(),
                mediaProperties.maxPixels(),
                mediaProperties.maxEdge(),
                mediaProperties.jpegQuality(),
                DataSize.ofBytes(quotaBytes),
                mediaProperties.processingPermits(),
                mediaProperties.processingWait());
        MediaService media = new MediaService(
                imageProcessor, tight, mediaRepository, mediaContentRepository, rateLimiter, authorQuota);
        return new PostImageService(media, mediaRepository, postRepository, transactionManager);
    }

    private UUID adminId() {
        return userRepository.findByEmail("admin@blog.local").orElseThrow().getId();
    }

    private long mediaRows(UUID mediaId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM media WHERE id = ?", Long.class, mediaId);
    }

    private long contentRows(UUID mediaId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM media_content WHERE media_id = ?", Long.class, mediaId);
    }

    private long storedByteSize(UUID mediaId) {
        return jdbcTemplate.queryForObject("SELECT byte_size FROM media WHERE id = ?", Long.class, mediaId);
    }

    private long totalStoredBytes() {
        return jdbcTemplate.queryForObject("SELECT coalesce(sum(byte_size), 0) FROM media", Long.class);
    }

    private static String imagesUrl(UUID postId) {
        return IMAGES_URL.formatted(postId);
    }

    private static UUID id(JsonNode media) {
        return UUID.fromString(media.path("id").asString());
    }

    private static List<UUID> ids(JsonNode array) {
        List<UUID> ids = new ArrayList<>();
        array.forEach(node -> ids.add(id(node)));
        return ids;
    }

    private static String contentTypeOf(String fixture) {
        return fixture.endsWith(".png") ? "image/png" : "image/jpeg";
    }

    private static MockMultipartFile fixtureFile(String name, String contentType) throws IOException {
        return new MockMultipartFile("file", name, contentType, fixture(name));
    }

    /** GIF magic bytes: the image pipeline rejects with 415 right at the sniff step. */
    private static MockMultipartFile gifFile() {
        byte[] gif = {'G', 'I', 'F', '8', '9', 'a', 1, 0, 1, 0, 0, 0, 0, ';'};
        return new MockMultipartFile("file", "anh.gif", "image/gif", gif);
    }

    private static byte[] fixture(String name) throws IOException {
        try (InputStream in = PostImageIT.class.getResourceAsStream("/media/" + name)) {
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
