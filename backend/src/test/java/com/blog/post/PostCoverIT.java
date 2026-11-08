package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.fail;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.media.config.MediaProperties;
import com.blog.media.entity.Media;
import com.blog.media.repository.MediaContentRepository;
import com.blog.media.repository.MediaRepository;
import com.blog.media.service.ImageProcessor;
import com.blog.media.service.MediaService;
import com.blog.post.dto.PostResponse;
import com.blog.post.repository.PostRepository;
import com.blog.post.service.PostCoverService;
import com.blog.post.service.PostService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
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
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.unit.DataSize;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Cover image: {@code POST/PUT/DELETE /api/v1/admin/posts/{id}/cover}.
 *
 * A cover image is uploaded and attached to the post in one call, and belongs to that post alone: replacing or removing
 * the cover, or deleting the post, deletes the image too. So most cases below check both sides: which image the post carries,
 * AND that the old image's public URL really stops being served (images are "unlisted, not private": while the row is in the DB, anyone with the URL can view it).
 *
 * Every request goes through the real filter chain with a real token, like PostOwnershipIT: permission on the cover is permission
 * on the post ({@code CAN_MANAGE}), and a test that pre-sets a SecurityContext would pass even if {@code @PreAuthorize} were removed.
 *
 * The DB is shared and never cleaned: each test has its own category, post name and file name (random suffix),
 * and counts nothing globally. Fixture text avoids every word that PostSearchAndFeaturedIT searches for.
 */
@AutoConfigureMockMvc
class PostCoverIT extends AbstractIntegrationTest {

    private static final String COVER_URL = "/api/v1/admin/posts/%s/cover";

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
    private PlatformTransactionManager transactionManager;

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
    private PostService postService;

    private String admin;
    private String suffix;
    private UUID categoryId;
    private String categorySlug;

    @BeforeEach
    void setUp() throws Exception {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
        JsonNode category = data(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"Category cover image " + UUID.randomUUID() + "\"}"))
                .andExpect(status().isCreated()));
        categoryId = UUID.fromString(category.path("id").asString());
        categorySlug = category.path("slug").asString();
    }

    // --- Upload and attach --------------------------------------------------------------------------

    @Test
    void admin_uploading_cover_makes_post_carry_image_in_admin_detail_and_in_public_list_after_publish()
            throws Exception {
        UUID postId = createPost(admin, "Post with a cover image");
        String altText = "Test cover image " + suffix;

        JsonNode uploaded = data(
                uploadCover(admin, postId, "orient6.jpg", "  " + altText + "  ").andExpect(status().isOk()));

        // The response is the post itself (PostResponse), already carrying the new cover: the editor need not re-read
        // it.
        assertThat(uploaded.path("id").asString()).isEqualTo(postId.toString());
        JsonNode cover = uploaded.path("cover");
        UUID mediaId = UUID.fromString(cover.path("id").asString());
        assertThat(cover.path("fileName").asString()).isEqualTo(mediaId + ".jpg");
        // orient6.jpg is stored 30×20 with EXIF Orientation=6: the cover is upright, 20×30.
        assertThat(cover.path("width").asInt()).isEqualTo(20);
        assertThat(cover.path("height").asInt()).isEqualTo(30);
        assertThat(cover.path("altText").asString()).isEqualTo(altText);
        assertThat(cover.path("dominantColor").asString()).matches("^#[0-9a-f]{6}$");
        // The file name on the uploader's machine is visible to admins only, and does not travel in the post DTO (which
        // is also the public DTO).
        assertThat(cover.has("originalFilename")).isFalse();
        assertServed(cover.path("fileName").asString(), "image/jpeg");
        // The uploader is the caller, taken from the token and not from the request.
        assertThat(uploadedBy(mediaId)).isEqualTo(adminId());

        assertThat(adminDetail(postId).path("cover").path("id").asString()).isEqualTo(mediaId.toString());

        publish(postId);

        JsonNode listed = findInPublicList(postId);
        assertThat(listed.path("cover").path("id").asString()).isEqualTo(mediaId.toString());
        assertThat(listed.path("cover").path("fileName").asString()).isEqualTo(mediaId + ".jpg");
        assertThat(listed.path("cover").path("altText").asString()).isEqualTo(altText);
    }

    @Test
    void replacing_cover_deletes_old_image_and_old_url_becomes_404() throws Exception {
        UUID postId = createPost(admin, "Post changing its cover image");
        JsonNode first = data(uploadCover(admin, postId, "orient6.jpg", null).andExpect(status().isOk()))
                .path("cover");
        String firstFile = first.path("fileName").asString();
        // Control: the first image is being served, so the 404 below is caused by the replacement and not by a wrong
        // URL.
        assertServed(firstFile, "image/jpeg");

        JsonNode second = data(uploadCover(admin, postId, "opaque.png", null).andExpect(status().isOk()))
                .path("cover");

        String secondFile = second.path("fileName").asString();
        assertThat(secondFile).isEqualTo(second.path("id").asString() + ".png").isNotEqualTo(firstFile);
        assertServed(secondFile, "image/png");
        assertGone(firstFile);
        // Bytes follow the metadata (ON DELETE CASCADE): no orphan image is left that nothing points to.
        assertThat(mediaRows(UUID.fromString(first.path("id").asString()))).isZero();
        assertThat(contentRows(UUID.fromString(first.path("id").asString()))).isZero();
        assertThat(adminDetail(postId).path("cover").path("fileName").asString())
                .isEqualTo(secondFile);
    }

    @Test
    void two_overlapping_replacements_delete_the_image_just_attached_by_the_other_leaving_no_orphan() throws Exception {
        UUID postId = createPost(admin, "Post with two overlapping cover replacements");
        UUID first = UUID.fromString(
                data(uploadCover(admin, postId, "orient6.jpg", null).andExpect(status().isOk()))
                        .path("cover")
                        .path("id")
                        .asString());
        // The image of "the other replacement", stored but not yet attached.
        Media other = mediaService.persist(mediaService.prepare(fixtureFile("opaque.png", "image/png")), null, null);

        CountDownLatch otherHoldsRow = new CountDownLatch(1);
        CountDownLatch releaseOther = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            // The other replacement is half done: it has attached its image and deleted the first image, holds the
            // post's row lock, not yet committed.
            Future<?> otherWrite =
                    pool.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                        jdbcTemplate.update("UPDATE posts SET cover_media_id = ? WHERE id = ?", other.getId(), postId);
                        jdbcTemplate.update("DELETE FROM media WHERE id = ?", first);
                        otherHoldsRow.countDown();
                        awaitQuietly(releaseOther);
                    }));
            assertThat(otherHoldsRow.await(10, TimeUnit.SECONDS)).isTrue();

            Future<MvcResult> upload = pool.submit(
                    () -> uploadCover(admin, postId, "orient6.jpg", null).andReturn());
            // Control that the two writes really overlap: the upload must be waiting, not finished.
            assertThatThrownBy(() -> upload.get(500, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            releaseOther.countDown();
            otherWrite.get(10, TimeUnit.SECONDS);
            MvcResult result = upload.get(30, TimeUnit.SECONDS);

            assertThat(result.getResponse().getStatus()).isEqualTo(200);
            JsonNode cover = objectMapper
                    .readTree(result.getResponse().getContentAsString())
                    .path("data")
                    .path("cover");
            assertThat(cover.path("id").asString())
                    .isNotIn(first.toString(), other.getId().toString());
            assertServed(cover.path("fileName").asString(), "image/jpeg");
            // The image replaced is the one the other replacement just attached, not the first image the upload sees if
            // it reads before the other
            // commits. With an unlocked read the other's image stays here: no post points to it, and the URL is still
            // served.
            assertThat(mediaRows(other.getId())).isZero();
            assertGone(other.fileName());
        } finally {
            releaseOther.countDown();
            pool.shutdownNow();
        }
    }

    // --- Quota: replacing a cover counts only the increase ------------------------------------------

    @Test
    void replacing_cover_near_quota_is_accepted_when_new_image_fits_once_old_one_is_gone() throws Exception {
        UUID postId = createPost(admin, "Post replacing its cover near the quota");
        JsonNode first = data(uploadCover(admin, postId, "orient6.jpg", "Image in use " + suffix)
                        .andExpect(status().isOk()))
                .path("cover");
        UUID firstId = UUID.fromString(first.path("id").asString());
        long firstSize = storedByteSize(firstId);
        // The size of the new image AFTER the pipeline. The pipeline is deterministic, so the replacement below stores
        // exactly this many bytes (the
        // assert at the end holds that true).
        long nextSize = mediaService
                .prepare(fixtureFile("opaque.png", "image/png"))
                .image()
                .bytes()
                .length;
        // The quota is set relative to the total of the shared DB right now, not as an absolute number.
        long storedBefore = totalStoredBytes();
        long fitsExactly = storedBefore - firstSize + nextSize;

        // Short by exactly one byte: still 422. Replacing an image is not a way around the quota, and the image in use
        // stays intact.
        PostCoverService oneByteShort = coversWithQuota(fitsExactly - 1);
        assertThatThrownBy(() -> oneByteShort.upload(postId, fixtureFile("opaque.png", "image/png"), null, adminId()))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.MEDIA_QUOTA_EXCEEDED));
        assertThat(adminDetail(postId).path("cover").path("id").asString()).isEqualTo(firstId.toString());
        assertServed(first.path("fileName").asString(), "image/jpeg");
        assertThat(totalStoredBytes()).isEqualTo(storedBefore);

        // Exact fit when counted as if the old image were already gone: accepted. Counting the old image too (total +
        // new image) makes this 422,
        // even though after the replacement the site uses exactly the quota and no more.
        PostResponse replaced =
                coversWithQuota(fitsExactly).upload(postId, fixtureFile("opaque.png", "image/png"), null, adminId());

        assertThat(replaced.cover().id()).isNotEqualTo(firstId);
        assertThat(storedByteSize(replaced.cover().id())).isEqualTo(nextSize);
        assertServed(replaced.cover().fileName(), "image/png");
        assertGone(first.path("fileName").asString());
        assertThat(totalStoredBytes() - storedBefore).isEqualTo(nextSize - firstSize);
    }

    // --- Permissions: permission on the cover is permission on the post ------------------------------

    @Test
    void author_manages_own_post_cover_but_cannot_touch_other_authors_cover() throws Exception {
        User alice = auth.createAuthor("alice-cover-" + UUID.randomUUID() + "@blog.local");
        User bob = auth.createAuthor("bob-cover-" + UUID.randomUUID() + "@blog.local");
        String aliceToken = auth.bearerFor(alice);
        String bobToken = auth.bearerFor(bob);
        UUID alicePost = createPost(aliceToken, "Alice post");
        UUID bobPost = createPost(bobToken, "Bob post");
        JsonNode bobCover = data(uploadCover(bobToken, bobPost, "opaque.png", "Bob image " + suffix)
                        .andExpect(status().isOk()))
                .path("cover");

        // Own post: upload, edit the description, remove, all allowed; the image records Alice as the uploader.
        JsonNode aliceCover = data(uploadCover(aliceToken, alicePost, "orient6.jpg", null)
                        .andExpect(status().isOk()))
                .path("cover");
        assertThat(uploadedBy(UUID.fromString(aliceCover.path("id").asString())))
                .isEqualTo(alice.getId());
        putAltText(aliceToken, alicePost, "{\"altText\":\"Alice edits own " + suffix + "\"}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.cover.altText").value("Alice edits own " + suffix));
        assertNullCover(data(mockMvc.perform(delete(coverUrl(alicePost)).header("Authorization", aliceToken))
                .andExpect(status().isOk())));

        // Bob's post: all three are 403, in the same envelope as every other permission denial.
        uploadCover(aliceToken, bobPost, "orient6.jpg", "Alice claims the cover image")
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        putAltText(aliceToken, bobPost, "{\"altText\":\"Alice edits the Bob image\"}")
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        mockMvc.perform(delete(coverUrl(bobPost)).header("Authorization", aliceToken))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));

        // With only the status, a bug that rejects EVERY request would pass too: re-read Bob's cover, it must be
        // intact.
        JsonNode bobAfter = adminDetail(bobPost).path("cover");
        assertThat(bobAfter.path("id").asString()).isEqualTo(bobCover.path("id").asString());
        assertThat(bobAfter.path("altText").asString()).isEqualTo("Bob image " + suffix);
        assertServed(bobCover.path("fileName").asString(), "image/png");
    }

    @Test
    void anonymous_gets_401_on_all_three_endpoints() throws Exception {
        UUID postId = createPost(admin, "Post an anonymous caller cannot touch");

        mockMvc.perform(multipart(coverUrl(postId)).file(fixtureFile("orient6.jpg", "image/jpeg")))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"));
        mockMvc.perform(put(coverUrl(postId)).contentType(APPLICATION_JSON).content("{\"altText\":\"x\"}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(delete(coverUrl(postId))).andExpect(status().isUnauthorized());

        assertThat(adminDetail(postId).path("cover").isNull()).isTrue();
    }

    @Test
    void missing_post_is_404_post_not_found_for_admin_and_403_for_author() throws Exception {
        UUID ghost = UUID.randomUUID();
        String author = auth.bearerFor(auth.createAuthor("ghost-cover-" + UUID.randomUUID() + "@blog.local"));

        // GIF bytes: if the image were processed before looking up the post, the answer would be 415. A missing post
        // has
        // nothing to attach an image to, and the answer must be about the post, before spending effort decoding the
        // image.
        mockMvc.perform(multipart(coverUrl(ghost)).file(gifFile()).header("Authorization", admin))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));
        putAltText(admin, ghost, "{\"altText\":\"x\"}")
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));
        mockMvc.perform(delete(coverUrl(ghost)).header("Authorization", admin))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));

        // An AUTHOR cannot probe which post ids exist through the status code (like every other /{id} route).
        mockMvc.perform(multipart(coverUrl(ghost))
                        .file(fixtureFile("orient6.jpg", "image/jpeg"))
                        .header("Authorization", author))
                .andExpect(status().isForbidden());
    }

    // --- Image description --------------------------------------------------------------------------

    @Test
    void editing_description_replaces_whole_description_and_keeps_image() throws Exception {
        UUID postId = createPost(admin, "Post editing the cover image description");
        JsonNode cover = data(uploadCover(admin, postId, "orient6.jpg", "First description " + suffix)
                        .andExpect(status().isOk()))
                .path("cover");

        JsonNode edited = data(putAltText(admin, postId, "{\"altText\":\"  New description " + suffix + "  \"}")
                        .andExpect(status().isOk()))
                .path("cover");

        assertThat(edited.path("altText").asString()).isEqualTo("New description " + suffix);
        assertThat(edited.path("id").asString()).isEqualTo(cover.path("id").asString());
        assertThat(adminDetail(postId).path("cover").path("altText").asString()).isEqualTo("New description " + suffix);

        // Full replacement: null, a blank string or a missing key all clear the description; the image stays the same.
        for (String body : List.of("{\"altText\":null}", "{\"altText\":\"   \"}", "{}")) {
            putAltText(admin, postId, "{\"altText\":\"Has description\"}").andExpect(status().isOk());
            JsonNode cleared = data(putAltText(admin, postId, body).andExpect(status().isOk()))
                    .path("cover");
            assertThat(cleared.path("altText").isNull())
                    .as("altText sau %s", body)
                    .isTrue();
            assertThat(cleared.path("id").asString())
                    .as("image after %s", body)
                    .isEqualTo(cover.path("id").asString());
        }
    }

    @Test
    void long_description_counts_characters_after_trim_like_the_upload_path() throws Exception {
        UUID postId = createPost(admin, "Post with a long description");
        data(uploadCover(admin, postId, "orient6.jpg", null).andExpect(status().isOk()));
        // 300 characters, 150 of them outside the BMP (two UTF-16 units each), wrapped in spaces: the VARCHAR(300)
        // column
        // accepts it, and so does the multipart upload path. PUT uses exactly that rule, not an @Size counting UTF-16
        // before trim.
        String longest = ("a" + Character.toString(0x1F304)).repeat(150);
        assertThat(longest.codePointCount(0, longest.length())).isEqualTo(300);
        assertThat(longest.length()).isEqualTo(450);

        JsonNode accepted = data(putAltText(
                                admin,
                                postId,
                                objectMapper.writeValueAsString(Map.of("altText", "  " + longest + "  ")))
                        .andExpect(status().isOk()))
                .path("cover");
        assertThat(accepted.path("altText").asString()).isEqualTo(longest);

        putAltText(admin, postId, objectMapper.writeValueAsString(Map.of("altText", longest + "x")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        // A rejection writes nothing: the old description stays intact.
        assertThat(adminDetail(postId).path("cover").path("altText").asString()).isEqualTo(longest);
    }

    @Test
    void editing_description_of_post_without_cover_is_404_media_not_found() throws Exception {
        UUID without = createPost(admin, "Post without a cover image");
        UUID with = createPost(admin, "Post with a cover image already");
        data(uploadCover(admin, with, "opaque.png", null).andExpect(status().isOk()));

        putAltText(admin, without, "{\"altText\":\"Description for a missing image\"}")
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("MEDIA_NOT_FOUND"));
        // Control: the same request on a post with a cover works.
        putAltText(admin, with, "{\"altText\":\"Description for a real image\"}")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.cover.altText").value("Description for a real image"));
    }

    // --- Removing the cover and deleting the post ---------------------------------------------------

    @Test
    void removing_cover_deletes_image_and_calling_again_is_still_200() throws Exception {
        UUID postId = createPost(admin, "Post removing its cover image");
        JsonNode cover = data(uploadCover(admin, postId, "orient6.jpg", null).andExpect(status().isOk()))
                .path("cover");
        assertServed(cover.path("fileName").asString(), "image/jpeg");

        JsonNode removed = data(mockMvc.perform(delete(coverUrl(postId)).header("Authorization", admin))
                .andExpect(status().isOk()));

        // 200 with the post rather than 204: admin-api cannot read a 204, and every other post state change returns the
        // post.
        assertThat(removed.path("id").asString()).isEqualTo(postId.toString());
        assertNullCover(removed);
        assertNullCover(adminDetail(postId));
        assertGone(cover.path("fileName").asString());
        assertThat(mediaRows(UUID.fromString(cover.path("id").asString()))).isZero();

        // Idempotent: removing again (two admin tabs, repeated clicks) is still a post without a cover, not an error.
        assertNullCover(data(mockMvc.perform(delete(coverUrl(postId)).header("Authorization", admin))
                .andExpect(status().isOk())));
    }

    @Test
    void deleting_post_deletes_its_own_cover_and_only_that() throws Exception {
        UUID doomed = createPost(admin, "Post deleted with its cover image");
        UUID survivor = createPost(admin, "Remaining post keeping its cover image");
        String doomedFile = data(uploadCover(admin, doomed, "orient6.jpg", null).andExpect(status().isOk()))
                .path("cover")
                .path("fileName")
                .asString();
        String survivorFile = data(uploadCover(admin, survivor, "opaque.png", null)
                        .andExpect(status().isOk()))
                .path("cover")
                .path("fileName")
                .asString();

        mockMvc.perform(delete("/api/v1/admin/posts/" + doomed).header("Authorization", admin))
                .andExpect(status().isNoContent());

        assertGone(doomedFile);
        assertThat(mediaRows(idOf(doomedFile))).isZero();
        assertThat(contentRows(idOf(doomedFile))).isZero();
        // Control: another post's cover is not dragged along.
        assertServed(survivorFile, "image/png");
    }

    // --- A broken request does not change the existing cover ----------------------------------------

    @Test
    void empty_or_missing_file_is_400_and_non_multipart_request_is_415() throws Exception {
        UUID postId = createPost(admin, "Post receiving a broken request");

        mockMvc.perform(multipart(coverUrl(postId))
                        .file(new MockMultipartFile("file", "rong.jpg", "image/jpeg", new byte[0]))
                        .header("Authorization", admin))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        // There is a description part but no file part.
        mockMvc.perform(multipart(coverUrl(postId))
                        .param("altText", "Description only")
                        .header("Authorization", admin))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        // JSON instead of multipart: there is no way to carry the image bytes, so it is rejected by content type.
        mockMvc.perform(post(coverUrl(postId))
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"file\":\"aGVsbG8=\",\"altText\":\"x\"}"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));

        assertNullCover(adminDetail(postId));
        // Control: the same post with a correct request works, so the errors above come from the request and not the
        // post.
        uploadCover(admin, postId, "orient6.jpg", null).andExpect(status().isOk());
    }

    @Test
    void rejected_image_or_too_long_description_keeps_old_cover_and_leaves_no_orphan_image() throws Exception {
        UUID postId = createPost(admin, "Post keeping its cover image when the upload fails");
        JsonNode cover = data(uploadCover(admin, postId, "orient6.jpg", "Image in use " + suffix)
                        .andExpect(status().isOk()))
                .path("cover");

        mockMvc.perform(multipart(coverUrl(postId)).file(gifFile()).header("Authorization", admin))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.error.code").value("MEDIA_UNSUPPORTED_TYPE"));

        // A 301-character description is rejected BEFORE image processing. GIF bytes prove the order: if the image were
        // processed
        // first, the answer would be 415, after taking the server's only image-processing slot for a request that fails
        // anyway.
        mockMvc.perform(multipart(coverUrl(postId))
                        .file(gifFile())
                        .param("altText", "a".repeat(301))
                        .header("Authorization", admin))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        // A valid image with a 301-character description: also 400. A separate file name for this call proves that
        // image was not stored.
        String rejectedName = "bia-bi-tu-choi-" + suffix + ".png";
        mockMvc.perform(multipart(coverUrl(postId))
                        .file(new MockMultipartFile("file", rejectedName, "image/png", fixture("opaque.png")))
                        .param("altText", "a".repeat(301))
                        .header("Authorization", admin))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM media WHERE original_filename = ?", Long.class, rejectedName))
                .isZero();

        JsonNode after = adminDetail(postId).path("cover");
        assertThat(after.path("id").asString()).isEqualTo(cover.path("id").asString());
        assertThat(after.path("altText").asString()).isEqualTo("Image in use " + suffix);
        assertServed(cover.path("fileName").asString(), "image/jpeg");
    }

    // --- PUT of the post does not touch the cover ---------------------------------------------------

    @Test
    void full_post_put_does_not_touch_cover() throws Exception {
        UUID postId = createPost(admin, "Post editing content and keeping its cover image");
        JsonNode cover = data(uploadCover(admin, postId, "orient6.jpg", "Image kept " + suffix)
                        .andExpect(status().isOk()))
                .path("cover");
        JsonNode before = adminDetail(postId);

        // A full PUT body as the editor sends it: it has no key for the cover, and a post PUT is a full replacement.
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", before.path("title").asString() + " (edited)");
        body.put("excerpt", before.path("excerpt").asString());
        body.put("content", before.path("content").asString() + " one more sentence");
        body.put("categoryId", categoryId.toString());
        body.put("tagIds", List.of());
        body.put("slug", before.path("slug").asString());
        JsonNode updated = data(mockMvc.perform(put("/api/v1/admin/posts/" + postId)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk()));

        // Control: the PUT took effect...
        assertThat(updated.path("title").asString()).endsWith("(edited)");
        // ...yet the cover, its description and its public URL are intact, both in the response and when re-read.
        for (JsonNode post : List.of(updated, adminDetail(postId))) {
            assertThat(post.path("cover").path("id").asString())
                    .isEqualTo(cover.path("id").asString());
            assertThat(post.path("cover").path("altText").asString()).isEqualTo("Image kept " + suffix);
        }
        assertServed(cover.path("fileName").asString(), "image/jpeg");
    }

    // --- Helpers ------------------------------------------------------------------------------------

    private ResultActions uploadCover(String token, UUID postId, String fixture, String altText) throws Exception {
        String contentType = fixture.endsWith(".png") ? "image/png" : "image/jpeg";
        MockMultipartHttpServletRequestBuilder request =
                multipart(coverUrl(postId)).file(fixtureFile(fixture, contentType));
        if (altText != null) {
            request.param("altText", altText);
        }
        return mockMvc.perform(request.header("Authorization", token));
    }

    private ResultActions putAltText(String token, UUID postId, String json) throws Exception {
        return mockMvc.perform(put(coverUrl(postId))
                .header("Authorization", token)
                .contentType(APPLICATION_JSON)
                .content(json));
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
        mockMvc.perform(get("/api/v1/media/" + fileName))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("MEDIA_NOT_FOUND"));
    }

    /** The key is present with a JSON null value: "no cover" is a value, not a missing field. */
    private static void assertNullCover(JsonNode post) {
        assertThat(post.has("cover")).as("must have a cover key").isTrue();
        assertThat(post.get("cover").isNull()).as("cover must be null").isTrue();
    }

    private UUID createPost(String token, String title) throws Exception {
        String payload = objectMapper.writeValueAsString(Map.of(
                "title", title + " " + suffix,
                "excerpt", "Summary " + suffix,
                "content", "Cover image test content " + suffix,
                "categoryId", categoryId.toString()));
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", token)
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated()));
        return UUID.fromString(created.path("id").asString());
    }

    private void publish(UUID postId) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + postId + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
    }

    private JsonNode adminDetail(UUID postId) throws Exception {
        return data(mockMvc.perform(get("/api/v1/admin/posts/" + postId).header("Authorization", admin))
                .andExpect(status().isOk()));
    }

    /** The public list filtered by this test's own category: the post must be present, absent is an error. */
    private JsonNode findInPublicList(UUID postId) throws Exception {
        for (JsonNode node : data(mockMvc.perform(
                        get("/api/v1/posts").param("category", categorySlug).param("size", "100"))
                .andExpect(status().isOk()))) {
            if (postId.toString().equals(node.path("id").asString())) {
                return node;
            }
        }
        return fail("Post not found: %s in the public list", postId);
    }

    private static String coverUrl(UUID postId) {
        return COVER_URL.formatted(postId);
    }

    private UUID adminId() {
        return userRepository.findByEmail("admin@blog.local").orElseThrow().getId();
    }

    private UUID uploadedBy(UUID mediaId) {
        return jdbcTemplate.queryForObject("SELECT uploaded_by FROM media WHERE id = ?", UUID.class, mediaId);
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

    /**
     * The real PostCoverService on a real DB, differing only in the quota: assembled by hand around this context's beans. A small quota via
     * {@code @TestPropertySource} would mean one more Spring context. The transaction comes from PostCoverService itself
     * (TransactionTemplate), so a hand-built MediaService, without the {@code @Transactional} proxy, still saves and deletes
     * within the replacement's own transaction.
     */
    private PostCoverService coversWithQuota(long quotaBytes) {
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
        return new PostCoverService(media, postRepository, postService, transactionManager);
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            if (!latch.await(30, TimeUnit.SECONDS)) {
                throw new IllegalStateException("Not released after 30 seconds");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    private static UUID idOf(String fileName) {
        return UUID.fromString(fileName.substring(0, fileName.indexOf('.')));
    }

    private static MockMultipartFile fixtureFile(String name, String contentType) throws IOException {
        return new MockMultipartFile("file", name, contentType, fixture(name));
    }

    /** GIF magic bytes: the image pipeline rejects with 415 right at the sniff step. */
    private static MockMultipartFile gifFile() {
        return new MockMultipartFile(
                "file",
                "anh.gif",
                "image/gif",
                "GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;".getBytes(StandardCharsets.ISO_8859_1));
    }

    private static byte[] fixture(String name) throws IOException {
        try (InputStream in = PostCoverIT.class.getResourceAsStream("/media/" + name)) {
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
