package com.blog.gallery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.gallery.repository.GalleryPhotoRepository;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Photo gallery: the public list {@code GET /api/v1/gallery} and the admin (ADMIN only, URL rule)
 * {@code /api/v1/admin/gallery}: upload photos one by one, newest first, edit (full replacement), delete, reorder with one
 * full permutation of ALL photos.
 *
 * A "hidden" photo is hidden from the list, not private: the photo URL is still served. So the hide/show cases check both
 * sides: the public list has or lacks the photo, AND the photo URL still returns 200.
 *
 * Every request goes through the real filter chain with a real token: gallery admin access is a URL rule, and a test that
 * presets a SecurityContext would pass even if that rule were deleted.
 *
 * The shared DB is never cleaned: each test sets its own file name and caption (random suffix), counts by difference,
 * and never checks the length of any list. Reordering always reads the current list through the API and then sends a full
 * permutation of it, because that list includes the photos of other tests.
 */
@AutoConfigureMockMvc
class GalleryIT extends AbstractIntegrationTest {

    private static final String ADMIN_GALLERY = "/api/v1/admin/gallery";
    private static final String PUBLIC_GALLERY = "/api/v1/gallery";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private GalleryPhotoRepository galleryPhotoRepository;

    private String admin;
    private String suffix;

    @BeforeEach
    void setUp() {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
    }

    // --- Upload -----------------------------------------------------------------------------------------

    @Test
    void upload_returns_201_new_photo_heads_admin_list_and_taken_date_comes_from_exif_when_not_sent() throws Exception {
        String fileName = "anh-dau-" + suffix + ".jpg";

        JsonNode created = data(upload(
                        admin,
                        "orient6.jpg",
                        fileName,
                        Map.of("caption", "  Caption " + suffix + "  ", "altText", "  Description " + suffix + "  "))
                .andExpect(status().isCreated()));

        JsonNode image = created.path("image");
        UUID mediaId = UUID.fromString(image.path("id").asString());
        assertThat(image.path("fileName").asString()).isEqualTo(mediaId + ".jpg");
        // orient6.jpg is stored 30x20 with EXIF Orientation=6: the gallery photo ends up upright, 20x30.
        assertThat(image.path("width").asInt()).isEqualTo(20);
        assertThat(image.path("height").asInt()).isEqualTo(30);
        assertThat(image.path("altText").asString()).isEqualTo("Description " + suffix);
        assertThat(image.path("dominantColor").asString()).matches("^#[0-9a-f]{6}$");
        assertThat(created.path("caption").asString()).isEqualTo("Caption " + suffix);
        // takenOn not sent: take DateTimeOriginal from the EXIF of the original file (2020:01:01 12:00:00), as a date.
        assertThat(created.path("takenOn").asString()).isEqualTo("2020-01-01");
        // published defaults to true.
        assertThat(created.path("published").asBoolean()).isTrue();
        assertThat(created.path("originalFilename").asString()).isEqualTo(fileName);
        // The size is that of the STORED photo (after processing), exactly the number of bytes served.
        MockHttpServletResponse served = assertServed(image.path("fileName").asString(), "image/jpeg");
        assertThat(created.path("byteSize").asInt()).isEqualTo(served.getContentAsByteArray().length);
        assertThat(Instant.parse(created.path("createdAt").asString()))
                .isEqualTo(Instant.parse(created.path("updatedAt").asString()));

        // The new photo heads the admin list, and the list carries exactly what the response returned (including the
        // creation time:
        // the response must not carry an in-memory value that the DB rounds differently).
        JsonNode first = adminList().get(0);
        assertThat(first.path("id").asString()).isEqualTo(created.path("id").asString());
        for (String field :
                List.of("caption", "takenOn", "sortOrder", "originalFilename", "byteSize", "createdAt", "updatedAt")) {
            assertThat(first.path(field)).as(field).isEqualTo(created.path(field));
        }
        assertThat(first.path("image")).isEqualTo(image);

        // A later upload ends up above the previous photo: exactly the order the site owner sees in the upload queue.
        JsonNode second = data(upload(admin, "opaque.png", "anh-sau-" + suffix + ".png", Map.of())
                .andExpect(status().isCreated()));
        assertThat(second.path("sortOrder").asInt())
                .isLessThan(created.path("sortOrder").asInt());
        assertThat(idsOf(adminList()).subList(0, 2))
                .containsExactly(
                        second.path("id").asString(), created.path("id").asString());
    }

    @Test
    void sent_taken_date_beats_exif_photo_without_exif_is_null_and_empty_takenOn_counts_as_not_sent() throws Exception {
        JsonNode explicit =
                data(upload(admin, "orient6.jpg", "ngay-gui-" + suffix + ".jpg", Map.of("takenOn", "2026-01-02"))
                        .andExpect(status().isCreated()));
        assertThat(explicit.path("takenOn").asString()).isEqualTo("2026-01-02");

        // opaque.png has no EXIF: there is no date to guess.
        JsonNode withoutExif = data(upload(admin, "opaque.png", "khong-exif-" + suffix + ".png", Map.of())
                .andExpect(status().isCreated()));
        assertThat(withoutExif.has("takenOn")).as("must have keys takenOn").isTrue();
        assertThat(withoutExif.path("takenOn").isNull())
                .as("takenOn must be null")
                .isTrue();

        // An empty date field in an HTML form still sends "takenOn=": that means "not sent", not a broken date.
        JsonNode blank = data(upload(admin, "orient6.jpg", "ngay-rong-" + suffix + ".jpg", Map.of("takenOn", ""))
                .andExpect(status().isCreated()));
        assertThat(blank.path("takenOn").asString()).isEqualTo("2020-01-01");

        // A badly formatted date is 400 before anything is stored.
        String rejected = "ngay-hong-" + suffix + ".jpg";
        assertError(upload(admin, "orient6.jpg", rejected, Map.of("takenOn", "02/01/2026")), 400, "VALIDATION_ERROR");
        assertThat(mediaNamed(rejected)).isZero();
    }

    @Test
    void hidden_photo_is_absent_from_public_list_but_photo_url_is_still_served() throws Exception {
        long publishedBefore = galleryPhotoRepository.countByPublishedTrue();
        JsonNode hidden = data(upload(
                        admin,
                        "orient6.jpg",
                        "an-" + suffix + ".jpg",
                        Map.of("published", "false", "caption", "Hidden photo " + suffix))
                .andExpect(status().isCreated()));
        // The photo count in the stats (GET /api/v1/stats) only counts visible photos: a hidden photo does not raise
        // it, a shown one does.
        assertThat(galleryPhotoRepository.countByPublishedTrue()).isEqualTo(publishedBefore);
        JsonNode shown = data(
                upload(admin, "opaque.png", "hien-" + suffix + ".png", Map.of("caption", "Visible photo " + suffix))
                        .andExpect(status().isCreated()));
        assertThat(galleryPhotoRepository.countByPublishedTrue()).isEqualTo(publishedBefore + 1);
        assertThat(hidden.path("published").asBoolean()).isFalse();
        assertThat(shown.path("published").asBoolean()).isTrue();

        Map<String, JsonNode> publicPhotos = publicPhotos();
        // Control: the shown photo is present, so the hidden one's absence comes from the published flag, not from a
        // wrong list.
        assertThat(publicPhotos).containsKey(shown.path("id").asString());
        assertThat(publicPhotos).doesNotContainKey(hidden.path("id").asString());
        // Hidden from the list, not private: anyone with the URL can still view it.
        assertServed(hidden.path("image").path("fileName").asString(), "image/jpeg");
        // The admin sees both.
        assertThat(idsOf(adminList()))
                .contains(hidden.path("id").asString(), shown.path("id").asString());

        // The public DTO has only what the reader needs: it does not leak the original file name, stored size, order or
        // visibility flag.
        JsonNode item = publicPhotos.get(shown.path("id").asString());
        assertThat(item.path("caption").asString()).isEqualTo("Visible photo " + suffix);
        assertThat(item.path("image").path("fileName").asString())
                .isEqualTo(shown.path("image").path("fileName").asString());
        assertThat(item.has("takenOn")).isTrue();
        for (String adminOnly :
                List.of("published", "sortOrder", "originalFilename", "byteSize", "createdAt", "updatedAt")) {
            assertThat(item.has(adminOnly)).as(adminOnly).isFalse();
        }
    }

    @Test
    void public_list_needs_no_token_newest_first_and_size_is_clamped() throws Exception {
        JsonNode older = data(
                upload(admin, "orient6.jpg", "cu-" + suffix + ".jpg", Map.of()).andExpect(status().isCreated()));
        JsonNode newer = data(
                upload(admin, "opaque.png", "moi-" + suffix + ".png", Map.of()).andExpect(status().isCreated()));

        // No Authorization header: the filter chain's fallback is denyAll, so "public" must be asserted explicitly.
        JsonNode firstPage =
                body(mockMvc.perform(get(PUBLIC_GALLERY).param("size", "1")).andExpect(status().isOk()));
        JsonNode secondPage =
                body(mockMvc.perform(get(PUBLIC_GALLERY).param("size", "1").param("page", "1"))
                        .andExpect(status().isOk()));
        assertThat(firstPage.path("data").get(0).path("id").asString())
                .isEqualTo(newer.path("id").asString());
        assertThat(secondPage.path("data").get(0).path("id").asString())
                .isEqualTo(older.path("id").asString());

        JsonNode defaults = body(mockMvc.perform(get(PUBLIC_GALLERY)).andExpect(status().isOk()))
                .path("pagination");
        assertThat(defaults.path("page").asInt()).isZero();
        assertThat(defaults.path("size").asInt()).isEqualTo(24);
        assertThat(defaults.path("totalElements").asLong()).isGreaterThanOrEqualTo(2);
        assertThat(pagination("1000", "0").path("size").asInt()).isEqualTo(100);
        assertThat(pagination("0", "0").path("size").asInt()).isEqualTo(1);
        assertThat(pagination("24", "-3").path("page").asInt()).isZero();
    }

    @Test
    void page_too_large_for_start_offset_is_clamped_to_empty_page_not_500() throws Exception {
        // The start offset = page x size, which JPA receives as an int: page=2147483647&size=100 used to be a 500. Now
        // page is clamped to Integer.MAX_VALUE / 100 = 21474836, like the admin lists.
        for (String page : new String[] {"2147483647", "21474837"}) {
            JsonNode body = body(
                    mockMvc.perform(get(PUBLIC_GALLERY).param("size", "100").param("page", page))
                            .andExpect(status().isOk()));
            assertThat(body.path("data").isArray()).as(page).isTrue();
            assertThat(body.path("data").size()).as(page).isZero();
            assertThat(body.path("pagination").path("page").asInt()).as(page).isEqualTo(21474836);
            assertThat(body.path("pagination").path("size").asInt()).as(page).isEqualTo(100);
        }
    }

    // --- Edit -------------------------------------------------------------------------------------------

    @Test
    void edit_photo_replaces_caption_description_taken_date_and_visibility_flag() throws Exception {
        JsonNode created = data(upload(
                        admin,
                        "orient6.jpg",
                        "sua-" + suffix + ".jpg",
                        Map.of("caption", "Old caption " + suffix, "altText", "Old description " + suffix))
                .andExpect(status().isCreated()));
        String id = created.path("id").asString();

        JsonNode edited = data(updatePhoto(
                        id,
                        json(
                                "caption",
                                "  New caption " + suffix + "  ",
                                "altText",
                                "  New description " + suffix + "  ",
                                "takenOn",
                                "2025-12-31",
                                "published",
                                false))
                .andExpect(status().isOk()));

        assertThat(edited.path("caption").asString()).isEqualTo("New caption " + suffix);
        // The photo description lives in the media table but is edited in the same call as the gallery photo.
        assertThat(edited.path("image").path("altText").asString()).isEqualTo("New description " + suffix);
        assertThat(edited.path("takenOn").asString()).isEqualTo("2025-12-31");
        assertThat(edited.path("published").asBoolean()).isFalse();
        // Still the same photo, in the same place.
        assertThat(edited.path("image").path("id"))
                .isEqualTo(created.path("image").path("id"));
        assertThat(edited.path("sortOrder")).isEqualTo(created.path("sortOrder"));
        assertThat(Instant.parse(edited.path("updatedAt").asString()))
                .isAfter(Instant.parse(created.path("updatedAt").asString()));
        // Read back from the DB: exactly what the response said, including updatedAt.
        assertThat(findById(adminList(), id)).isEqualTo(edited);
        assertThat(publicPhotos()).doesNotContainKey(id);
        assertServed(created.path("image").path("fileName").asString(), "image/jpeg");

        // Full replacement: a blank or null field is cleared, the old value must not be kept.
        JsonNode cleared = data(updatePhoto(id, json("published", true)).andExpect(status().isOk()));
        for (JsonNode node : List.of(
                cleared.path("caption"),
                cleared.path("takenOn"),
                cleared.path("image").path("altText"))) {
            assertThat(node.isNull()).as("must be null: %s", node).isTrue();
        }
        assertThat(cleared.path("published").asBoolean()).isTrue();
        assertThat(publicPhotos()).containsKey(id);
    }

    @Test
    void edit_photo_missing_published_is_400_and_unknown_id_is_404_changing_nothing() throws Exception {
        JsonNode created =
                data(upload(admin, "orient6.jpg", "sua-loi-" + suffix + ".jpg", Map.of("caption", "Kept " + suffix))
                        .andExpect(status().isCreated()));
        String id = created.path("id").asString();

        // published is required: without it, a "full replacement" would have to guess hidden or shown.
        assertError(updatePhoto(id, json("caption", "Not recorded " + suffix)), 400, "VALIDATION_ERROR");
        assertThat(findById(adminList(), id).path("caption").asString()).isEqualTo("Kept " + suffix);

        String ghost = UUID.randomUUID().toString();
        assertError(updatePhoto(ghost, json("published", true)), 404, "GALLERY_PHOTO_NOT_FOUND");
        assertError(
                mockMvc.perform(delete(ADMIN_GALLERY + "/" + ghost).header("Authorization", admin)),
                404,
                "GALLERY_PHOTO_NOT_FOUND");
    }

    @Test
    void caption_and_description_counted_in_characters_after_trim_too_long_is_400_and_stores_nothing()
            throws Exception {
        // 1000 characters, 500 of them outside the BMP (two UTF-16 units each), wrapped in spaces: accepted on both
        // upload
        // and PUT, with the same rule, not a @Size that counts UTF-16 before trimming.
        String longest = ("a" + Character.toString(0x1F304)).repeat(500);
        assertThat(longest.codePointCount(0, longest.length())).isEqualTo(1000);
        assertThat(longest.length()).isEqualTo(1500);

        JsonNode created =
                data(upload(admin, "orient6.jpg", "dai-" + suffix + ".jpg", Map.of("caption", "  " + longest + "  "))
                        .andExpect(status().isCreated()));
        assertThat(created.path("caption").asString()).isEqualTo(longest);
        String id = created.path("id").asString();
        assertThat(data(updatePhoto(id, json("caption", "  " + longest + "  ", "published", true))
                                .andExpect(status().isOk()))
                        .path("caption")
                        .asString())
                .isEqualTo(longest);

        String tooLongName = "qua-dai-" + suffix + ".jpg";
        assertError(
                upload(admin, "orient6.jpg", tooLongName, Map.of("caption", longest + "x")), 400, "VALIDATION_ERROR");
        String tooLongAlt = "mo-ta-qua-dai-" + suffix + ".jpg";
        assertError(
                upload(admin, "orient6.jpg", tooLongAlt, Map.of("altText", "a".repeat(301))), 400, "VALIDATION_ERROR");
        assertThat(mediaNamed(tooLongName)).isZero();
        assertThat(mediaNamed(tooLongAlt)).isZero();
        // Both fields are rejected BEFORE image processing. The GIF bytes prove the order: if the image were processed
        // first the answer would be
        // 415 MEDIA_UNSUPPORTED_TYPE, after having taken the server's only image-processing slot for a request that
        // fails
        // anyway.
        assertError(
                mockMvc.perform(multipart(ADMIN_GALLERY)
                        .file(gifFile("mo-ta-gif-" + suffix + ".gif"))
                        .param("altText", "a".repeat(301))
                        .header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
        assertError(
                mockMvc.perform(multipart(ADMIN_GALLERY)
                        .file(gifFile("chu-thich-gif-" + suffix + ".gif"))
                        .param("caption", longest + "x")
                        .header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");

        assertError(updatePhoto(id, json("caption", longest + "x", "published", true)), 400, "VALIDATION_ERROR");
        assertError(
                updatePhoto(id, json("altText", "a".repeat(301), "caption", "Not recorded", "published", false)),
                400,
                "VALIDATION_ERROR");
        // A rejection writes no part of the edit, not even the valid part.
        JsonNode after = findById(adminList(), id);
        assertThat(after.path("caption").asString()).isEqualTo(longest);
        assertThat(after.path("published").asBoolean()).isTrue();
    }

    // --- Reorder ----------------------------------------------------------------------------------------

    @Test
    void reorder_with_full_permutation_read_from_api_gives_list_in_new_order() throws Exception {
        List<String> mine = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            mine.add(data(upload(admin, "opaque.png", "sap-" + i + "-" + suffix + ".png", Map.of())
                            .andExpect(status().isCreated()))
                    .path("id")
                    .asString());
        }
        JsonNode before = adminList();
        List<String> reversed = new ArrayList<>(idsOf(before)).reversed();

        JsonNode reordered = data(reorder(reversed).andExpect(status().isOk()));

        assertThat(idsOf(reordered)).containsExactlyElementsOf(reversed);
        List<Integer> sortOrders = new ArrayList<>();
        reordered.forEach(photo -> sortOrders.add(photo.path("sortOrder").asInt()));
        assertThat(sortOrders.getFirst()).isEqualTo(1);
        assertThat(sortOrders.getLast()).isEqualTo(reversed.size());
        assertThat(sortOrders).isSorted().doesNotHaveDuplicates();
        assertThat(idsOf(adminList())).containsExactlyElementsOf(reversed);
        // The public page uses the same order: this test's three photos are reversed compared with the upload.
        assertThat(new ArrayList<>(publicPhotos().keySet())
                        .stream().filter(mine::contains).toList())
                .containsExactlyElementsOf(mine);
        // Reordering is not editing a photo: each photo's updatedAt does not change.
        JsonNode one = findById(before, mine.getFirst());
        assertThat(findById(adminList(), mine.getFirst()).path("updatedAt")).isEqualTo(one.path("updatedAt"));

        // After reordering, a new photo still goes to the top.
        JsonNode next = data(upload(admin, "opaque.png", "sau-sap-" + suffix + ".png", Map.of())
                .andExpect(status().isCreated()));
        assertThat(next.path("sortOrder").asInt()).isLessThan(1);
        assertThat(adminList().get(0).path("id").asString())
                .isEqualTo(next.path("id").asString());
    }

    @Test
    void reorder_that_is_not_a_full_permutation_is_400_and_old_order_is_intact() throws Exception {
        for (int i = 0; i < 2; i++) {
            upload(admin, "opaque.png", "sai-" + i + "-" + suffix + ".png", Map.of())
                    .andExpect(status().isCreated());
        }
        JsonNode before = adminList();
        List<String> ids = idsOf(before);

        // One photo is missing (an old tab has not seen the photo just uploaded in another tab).
        assertError(reorder(ids.subList(0, ids.size() - 1)), 400, "VALIDATION_ERROR");
        // Duplicate id: the right count but one photo is missing.
        List<String> duplicated = new ArrayList<>(ids);
        duplicated.set(duplicated.size() - 1, ids.getFirst());
        assertError(reorder(duplicated), 400, "VALIDATION_ERROR");
        // An unknown id, added or replacing a real photo: the id is in the request body, so 400, not 404.
        List<String> extra = new ArrayList<>(ids);
        extra.add(UUID.randomUUID().toString());
        assertError(reorder(extra), 400, "GALLERY_PHOTO_NOT_FOUND");
        List<String> replaced = new ArrayList<>(ids);
        replaced.set(0, UUID.randomUUID().toString());
        assertError(reorder(replaced), 400, "GALLERY_PHOTO_NOT_FOUND");
        assertError(
                mockMvc.perform(put(ADMIN_GALLERY + "/order")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{}")),
                400,
                "VALIDATION_ERROR");

        assertThat(adminList()).isEqualTo(before);
    }

    // --- Delete -----------------------------------------------------------------------------------------

    @Test
    void delete_photo_returns_204_removes_photo_and_bytes_and_only_that_photo() throws Exception {
        JsonNode doomed = data(
                upload(admin, "orient6.jpg", "xoa-" + suffix + ".jpg", Map.of()).andExpect(status().isCreated()));
        JsonNode survivor = data(
                upload(admin, "opaque.png", "con-" + suffix + ".png", Map.of()).andExpect(status().isCreated()));
        String fileName = doomed.path("image").path("fileName").asString();
        UUID mediaId = UUID.fromString(doomed.path("image").path("id").asString());
        assertServed(fileName, "image/jpeg");

        mockMvc.perform(delete(ADMIN_GALLERY + "/" + doomed.path("id").asString())
                        .header("Authorization", admin))
                .andExpect(status().isNoContent());

        assertError(mockMvc.perform(get("/api/v1/media/" + fileName)), 404, "MEDIA_NOT_FOUND");
        assertThat(count("SELECT count(*) FROM media WHERE id = ?", mediaId)).isZero();
        assertThat(count("SELECT count(*) FROM media_content WHERE media_id = ?", mediaId))
                .isZero();
        assertThat(count(
                        "SELECT count(*) FROM gallery_photos WHERE id = ?",
                        UUID.fromString(doomed.path("id").asString())))
                .isZero();
        assertThat(idsOf(adminList()))
                .doesNotContain(doomed.path("id").asString())
                .contains(survivor.path("id").asString());
        // Control: another photo is not dragged along.
        assertServed(survivor.path("image").path("fileName").asString(), "image/png");

        assertError(
                mockMvc.perform(delete(ADMIN_GALLERY + "/" + doomed.path("id").asString())
                        .header("Authorization", admin)),
                404,
                "GALLERY_PHOTO_NOT_FOUND");
    }

    // --- Permissions and malformed requests -------------------------------------------------------------

    @Test
    void author_gets_403_and_anonymous_gets_401_on_every_gallery_admin_path() throws Exception {
        String author = auth.bearerFor(auth.createAuthor("gallery-" + suffix + "@blog.local"));
        JsonNode target =
                data(upload(admin, "orient6.jpg", "dich-" + suffix + ".jpg", Map.of("caption", "Admin own " + suffix))
                        .andExpect(status().isCreated()));
        String one = ADMIN_GALLERY + "/" + target.path("id").asString();
        List<String> ids = idsOf(adminList());

        // The gallery belongs to the site, not to an author: AUTHOR cannot administer any part of it.
        String authorUpload = "cua-author-" + suffix + ".jpg";
        assertError(mockMvc.perform(get(ADMIN_GALLERY).header("Authorization", author)), 403, "FORBIDDEN");
        assertError(upload(author, "orient6.jpg", authorUpload, Map.of()), 403, "FORBIDDEN");
        assertError(
                mockMvc.perform(put(one).header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(json("caption", "Author edit", "published", false))),
                403,
                "FORBIDDEN");
        assertError(mockMvc.perform(delete(one).header("Authorization", author)), 403, "FORBIDDEN");
        assertError(
                mockMvc.perform(put(ADMIN_GALLERY + "/order")
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("photoIds", ids.reversed())))),
                403,
                "FORBIDDEN");

        assertError(mockMvc.perform(get(ADMIN_GALLERY)), 401, "UNAUTHENTICATED");
        assertError(upload(null, "orient6.jpg", "an-danh-" + suffix + ".jpg", Map.of()), 401, "UNAUTHENTICATED");

        // With status alone, a bug that rejects EVERY request would also pass: the photo is intact, the order is
        // intact, no new photo.
        JsonNode after = adminList();
        assertThat(idsOf(after)).isEqualTo(ids);
        assertThat(findById(after, target.path("id").asString()).path("caption").asString())
                .isEqualTo("Admin own " + suffix);
        assertThat(mediaNamed(authorUpload)).isZero();
        // Control: the same list is readable by the admin (the adminList line above), and the public page is readable
        // by anyone.
        mockMvc.perform(get(PUBLIC_GALLERY).header("Authorization", author)).andExpect(status().isOk());
    }

    @Test
    void empty_or_missing_file_is_400_unrecognized_image_is_415_and_non_multipart_request_is_415() throws Exception {
        String empty = "rong-" + suffix + ".jpg";
        assertError(
                mockMvc.perform(multipart(ADMIN_GALLERY)
                        .file(new MockMultipartFile("file", empty, "image/jpeg", new byte[0]))
                        .header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
        assertError(
                mockMvc.perform(multipart(ADMIN_GALLERY)
                        .param("caption", "Caption only " + suffix)
                        .header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
        String gif = "anh-" + suffix + ".gif";
        assertError(
                mockMvc.perform(multipart(ADMIN_GALLERY).file(gifFile(gif)).header("Authorization", admin)),
                415,
                "MEDIA_UNSUPPORTED_TYPE");
        // JSON instead of multipart: there is no way to carry image bytes, so it is rejected by content type.
        assertError(
                mockMvc.perform(post(ADMIN_GALLERY)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"file\":\"aGVsbG8=\"}")),
                415,
                "VALIDATION_ERROR");

        assertThat(mediaNamed(empty)).isZero();
        assertThat(mediaNamed(gif)).isZero();
        // Control: a correct request succeeds.
        upload(admin, "orient6.jpg", "dung-" + suffix + ".jpg", Map.of()).andExpect(status().isCreated());
    }

    // --- Helpers ----------------------------------------------------------------------------------------

    private ResultActions upload(String token, String fixture, String originalName, Map<String, String> params)
            throws Exception {
        String contentType = fixture.endsWith(".png") ? "image/png" : "image/jpeg";
        MockMultipartHttpServletRequestBuilder request = multipart(ADMIN_GALLERY)
                .file(new MockMultipartFile("file", originalName, contentType, fixture(fixture)));
        params.forEach((name, value) -> request.param(name, value));
        if (token != null) {
            request.header("Authorization", token);
        }
        return mockMvc.perform(request);
    }

    private ResultActions updatePhoto(String id, String json) throws Exception {
        return mockMvc.perform(put(ADMIN_GALLERY + "/" + id)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(json));
    }

    private ResultActions reorder(List<String> photoIds) throws Exception {
        return mockMvc.perform(put(ADMIN_GALLERY + "/order")
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("photoIds", photoIds))));
    }

    /** JSON body from key, value pairs; a key that is not given is absent (different from present and null). */
    private String json(Object... pairs) {
        Map<String, Object> body = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            body.put((String) pairs[i], pairs[i + 1]);
        }
        return objectMapper.writeValueAsString(body);
    }

    private JsonNode adminList() throws Exception {
        return data(mockMvc.perform(get(ADMIN_GALLERY).header("Authorization", admin))
                .andExpect(status().isOk()));
    }

    /** Every public photo across every page, in the order the pages return them, keyed by id. */
    private Map<String, JsonNode> publicPhotos() throws Exception {
        Map<String, JsonNode> photos = new LinkedHashMap<>();
        int totalPages = 1;
        for (int page = 0; page < totalPages; page++) {
            JsonNode body = body(
                    mockMvc.perform(get(PUBLIC_GALLERY).param("size", "100").param("page", String.valueOf(page)))
                            .andExpect(status().isOk()));
            body.path("data").forEach(photo -> photos.put(photo.path("id").asString(), photo));
            totalPages = body.path("pagination").path("totalPages").asInt();
        }
        return photos;
    }

    private JsonNode pagination(String size, String page) throws Exception {
        return body(mockMvc.perform(get(PUBLIC_GALLERY).param("size", size).param("page", page))
                        .andExpect(status().isOk()))
                .path("pagination");
    }

    private MockHttpServletResponse assertServed(String fileName, String contentType) throws Exception {
        MockHttpServletResponse response = mockMvc.perform(get("/api/v1/media/" + fileName))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse();
        assertThat(response.getContentType()).isEqualTo(contentType);
        assertThat(response.getContentAsByteArray()).isNotEmpty();
        return response;
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        JsonNode error = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("error");
        assertThat(error.path("code").asString()).isEqualTo(code);
    }

    private long mediaNamed(String originalFilename) {
        return count("SELECT count(*) FROM media WHERE original_filename = ?", originalFilename);
    }

    private long count(String sql, Object argument) {
        return jdbcTemplate.queryForObject(sql, Long.class, argument);
    }

    private static List<String> idsOf(JsonNode array) {
        List<String> ids = new ArrayList<>();
        array.forEach(node -> ids.add(node.path("id").asString()));
        return ids;
    }

    private static JsonNode findById(JsonNode array, String id) {
        for (JsonNode node : array) {
            if (id.equals(node.path("id").asString())) {
                return node;
            }
        }
        return fail("Photo %s not found in the list", id);
    }

    /** GIF magic bytes: the image pipeline rejects with 415 right at the sniff step. */
    private static MockMultipartFile gifFile(String originalName) {
        return new MockMultipartFile(
                "file",
                originalName,
                "image/gif",
                "GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;".getBytes(StandardCharsets.ISO_8859_1));
    }

    private static byte[] fixture(String name) throws IOException {
        try (InputStream in = GalleryIT.class.getResourceAsStream("/media/" + name)) {
            assertThat(in).as("fixture %s", name).isNotNull();
            return in.readAllBytes();
        }
    }

    private JsonNode body(ResultActions result) throws Exception {
        return objectMapper.readTree(result.andReturn().getResponse().getContentAsString());
    }

    private JsonNode data(ResultActions result) throws Exception {
        return body(result).path("data");
    }
}
