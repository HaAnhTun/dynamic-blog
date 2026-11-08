package com.blog.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.media.entity.Media;
import com.blog.media.repository.MediaRepository;
import com.blog.media.service.MediaService;
import com.blog.media.service.PreparedUpload;
import com.blog.support.AbstractIntegrationTest;
import com.blog.user.repository.UserRepository;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Stores images in Postgres and serves them back through {@code GET /api/v1/media/{id}.{ext}}.
 *
 * Images are created through the real code path (MediaService.prepare then persist, with the image fixtures), not inserted
 * by hand into the table: what is served must be what the pipeline wrote. The shared DB is never cleaned, so
 * each test creates its own image (random UUID) and counts nothing globally.
 *
 * The GET requests carry no Authorization header: the image-serving path is public, and the filter chain's
 * fallback is denyAll, so "public" must be asserted rather than assumed.
 */
@AutoConfigureMockMvc
class MediaControllerIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private MediaService mediaService;

    @Autowired
    private MediaRepository mediaRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    /** The stored image together with exactly the bytes the pipeline returned, to compare with the served body. */
    private record Stored(Media media, byte[] bytes) {
        UUID id() {
            return media.getId();
        }

        String etag() {
            return "\"" + media.getSha256() + "\"";
        }
    }

    private Stored store(String fixture, String declaredType) throws IOException {
        return store(fixture, declaredType, null, null);
    }

    private Stored store(String fixture, String declaredType, String altText, UUID uploader) throws IOException {
        PreparedUpload prepared =
                mediaService.prepare(new MockMultipartFile("file", fixture, declaredType, fixture(fixture)));
        Media media = mediaService.persist(prepared, altText, uploader);
        return new Stored(media, prepared.image().bytes());
    }

    // --- 200 -----------------------------------------------------------------------------------

    @Test
    void jpeg_image_is_served_publicly_with_exactly_the_stored_bytes_and_immutable_headers() throws Exception {
        Stored jpeg = store("orient6.jpg", "image/jpeg");

        MockHttpServletResponse response = mockMvc.perform(get("/api/v1/media/" + jpeg.id() + ".jpg"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse();

        assertThat(response.getContentType()).isEqualTo("image/jpeg");
        assertThat(response.getContentAsByteArray()).isEqualTo(jpeg.bytes());
        assertThat(response.getHeader("Content-Length")).isEqualTo(String.valueOf(jpeg.bytes().length));
        // The strong ETag is the sha256 of exactly the served bytes, and there is only one.
        assertThat(jpeg.media().getSha256()).isEqualTo(sha256Hex(jpeg.bytes()));
        assertThat(response.getHeaders("ETag")).containsExactly(jpeg.etag());
        // The URL is by UUID and its content never changes: it can be cached forever. Spring Security by default adds
        // no-cache/no-store to every response; here it must yield to the controller's header.
        assertThat(response.getHeader("Cache-Control"))
                .contains("max-age=31536000", "public", "immutable")
                .doesNotContain("no-store", "no-cache", "private");
        assertThat(response.getHeader("Pragma")).isNull();
        assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
    }

    @Test
    void png_image_is_served_with_png_content_type_taken_from_stored_type() throws Exception {
        Stored png = store("opaque.png", "application/octet-stream");

        MockHttpServletResponse response = mockMvc.perform(get("/api/v1/media/" + png.id() + ".png"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse();

        // Content-Type follows the type the pipeline wrote, not the type the client claimed at upload.
        assertThat(response.getContentType()).isEqualTo("image/png");
        assertThat(response.getContentAsByteArray()).isEqualTo(png.bytes());
        assertThat(response.getHeaders("ETag")).containsExactly(png.etag());
    }

    // --- 304 -----------------------------------------------------------------------------------

    @Test
    void matching_if_none_match_gives_304_without_body_but_keeps_etag_and_cache_control() throws Exception {
        Stored jpeg = store("orient6.jpg", "image/jpeg");
        String url = "/api/v1/media/" + jpeg.id() + ".jpg";

        MockHttpServletResponse notModified = mockMvc.perform(get(url).header("If-None-Match", jpeg.etag()))
                .andExpect(status().isNotModified())
                .andReturn()
                .getResponse();

        assertThat(notModified.getContentAsByteArray()).isEmpty();
        // RFC 9110 section 15.4.5: a 304 carries back the ETag and Cache-Control that the 200 would have sent, so the
        // cache can refresh the copy it holds.
        assertThat(notModified.getHeaders("ETag")).containsExactly(jpeg.etag());
        assertThat(notModified.getHeader("Cache-Control")).contains("max-age=31536000", "immutable");

        // Control: a different ETag means a different image, so the full 200 and body are returned.
        MockHttpServletResponse stale = mockMvc.perform(get(url).header("If-None-Match", "\"" + "0".repeat(64) + "\""))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse();
        assertThat(stale.getContentAsByteArray()).isEqualTo(jpeg.bytes());
    }

    @Test
    void path_304_does_not_read_bytes_table() throws Exception {
        Stored jpeg = store("orient6.jpg", "image/jpeg");
        String url = "/api/v1/media/" + jpeg.id() + ".jpg";
        // Remove only the bytes, keep the metadata: any path that still touches the media_content table shows up
        // immediately.
        assertThat(jdbcTemplate.update("DELETE FROM media_content WHERE media_id = ?", jpeg.id()))
                .isEqualTo(1);

        // A plain GET is now 404: the real 200 path reads bytes from the separate table...
        mockMvc.perform(get(url))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("MEDIA_NOT_FOUND"));
        // ...while the conditional GET is still 304, so it answers from metadata without reading the 4 MB of bytes.
        mockMvc.perform(get(url).header("If-None-Match", jpeg.etag())).andExpect(status().isNotModified());

        mediaService.delete(jpeg.id());
    }

    // --- 4xx -----------------------------------------------------------------------------------

    @Test
    void suffix_not_matching_stored_type_is_404_media_not_found_and_not_cached() throws Exception {
        Stored jpeg = store("orient6.jpg", "image/jpeg");
        Stored png = store("opaque.png", "image/png");

        MockHttpServletResponse wrongExtension = mockMvc.perform(get("/api/v1/media/" + jpeg.id() + ".png"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("MEDIA_NOT_FOUND"))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty())
                .andReturn()
                .getResponse();
        mockMvc.perform(get("/api/v1/media/" + png.id() + ".jpg"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("MEDIA_NOT_FOUND"));

        // An error never carries the image's immutable header: a 404 cached for a year would hide the real image.
        assertThat(wrongExtension.getHeader("Cache-Control"))
                .contains("no-store")
                .doesNotContain("immutable");
    }

    @Test
    void nonexistent_uuid_is_404_media_not_found() throws Exception {
        mockMvc.perform(get("/api/v1/media/" + UUID.randomUUID() + ".jpg"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("MEDIA_NOT_FOUND"));
    }

    @Test
    void image_only_client_still_gets_json_404_instead_of_server_error() throws Exception {
        // An image client (Accept: image/png, without */*) asks for a deleted image. The error body is JSON, which does
        // not match
        // Accept; if content negotiation were left to decide, writing the error body would fail and the original
        // exception would escape
        // the handler: a 500 with an ERROR stack trace instead of a 404. The backend has a public URL on Koyeb/Render.
        mockMvc.perform(get("/api/v1/media/" + UUID.randomUUID() + ".jpg").header("Accept", "image/png"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("MEDIA_NOT_FOUND"));
        // Control: a browser's Accept for an <img> tag (with */* as a fallback) has always produced the JSON 404.
        mockMvc.perform(get("/api/v1/media/" + UUID.randomUUID() + ".jpg")
                        .header("Accept", "image/avif,image/webp,image/*,*/*;q=0.8"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("MEDIA_NOT_FOUND"));
    }

    @Test
    void id_that_is_not_a_uuid_is_400() throws Exception {
        mockMvc.perform(get("/api/v1/media/not-a-uuid.jpg"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {".gif", ".jpeg", ".JPG", ".webp", ""})
    void suffix_other_than_jpg_png_matches_no_route(String suffix) throws Exception {
        // One URL per image: no .jpeg/.JPG alias points at the same image (each alias would be one more
        // cache key), and no route returns an image without a suffix.
        Stored jpeg = store("orient6.jpg", "image/jpeg");

        mockMvc.perform(get("/api/v1/media/" + jpeg.id() + suffix))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("ENDPOINT_NOT_FOUND"));
    }

    // --- Store and delete ----------------------------------------------------------------------

    @Test
    void persist_writes_full_metadata_and_id_is_random_uuid() throws Exception {
        UUID admin =
                userRepository.findByEmail("admin@blog.local").orElseThrow().getId();
        String altText = "Test photo " + UUID.randomUUID();

        Stored stored = store("orient6.jpg", "image/jpeg", "  " + altText + "  ", admin);

        Media row = mediaRepository.findById(stored.id()).orElseThrow();
        assertThat(row.getContentType()).isEqualTo("image/jpeg");
        assertThat(row.getWidth()).isEqualTo(20);
        assertThat(row.getHeight()).isEqualTo(30);
        assertThat(row.getByteSize()).isEqualTo(stored.bytes().length);
        assertThat(row.getSha256()).isEqualTo(sha256Hex(stored.bytes()));
        assertThat(row.getDominantColor()).matches("^#[0-9a-f]{6}$");
        assertThat(row.getAltText()).isEqualTo(altText);
        assertThat(row.getOriginalFilename()).isEqualTo("orient6.jpg");
        assertThat(row.getUploadedBy()).isEqualTo(admin);
        assertThat(row.getCreatedAt()).isNotNull();
        assertThat(row.fileName()).isEqualTo(stored.id() + ".jpg");
        // "Unlisted, not private" only holds when the URL cannot be guessed: a random v4 UUID, not time-based.
        assertThat(stored.id().version()).isEqualTo(4);
    }

    @Test
    void deleting_media_deletes_bytes_too_and_repeating_the_call_does_not_fail() throws Exception {
        Stored stored = store("opaque.png", "image/png");
        String url = "/api/v1/media/" + stored.id() + ".png";
        mockMvc.perform(get(url)).andExpect(status().isOk());
        assertThat(contentRows(stored.id())).isEqualTo(1);

        mediaService.delete(stored.id());

        mockMvc.perform(get(url))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("MEDIA_NOT_FOUND"));
        // ON DELETE CASCADE: the bytes go together with the metadata, leaving no orphan megabytes that nothing
        // references.
        assertThat(contentRows(stored.id())).isZero();
        assertThat(mediaRepository.findById(stored.id())).isEmpty();
        // Delete is idempotent: removing the cover image twice (two admin tabs) does not become a 500.
        assertThatCode(() -> mediaService.delete(stored.id())).doesNotThrowAnyException();
    }

    // --- V11 constraints -----------------------------------------------------------------------

    @Test
    void media_table_accepts_only_images_satisfying_v11_constraints() {
        String sha = "0".repeat(64);
        // Control: a valid row goes through that very INSERT.
        UUID valid = jdbcTemplate.queryForObject("""
                INSERT INTO media (content_type, width, height, byte_size, sha256, dominant_color)
                VALUES ('image/png', 1, 1, 4194304, ?, '#0a0b0c') RETURNING id
                """, UUID.class, sha);
        assertThat(valid).isNotNull();
        jdbcTemplate.update("DELETE FROM media WHERE id = ?", valid);

        // The last net below the pipeline: even if the code has a bug, the DB does not accept SVG/HTML, empty images,
        // images over 4 MiB or a wrong color form.
        assertRejectedRow("'image/svg+xml', 1, 1, 1, '#000000'");
        assertRejectedRow("'image/webp', 1, 1, 1, '#000000'");
        assertRejectedRow("'image/png', 0, 1, 1, '#000000'");
        assertRejectedRow("'image/png', 1, 1, 0, '#000000'");
        assertRejectedRow("'image/png', 1, 1, 4194305, '#000000'");
        assertRejectedRow("'image/png', 1, 1, 1, '#FFFFFF'");
        assertRejectedRow("'image/png', 1, 1, 1, 'red'");
    }

    @Test
    void image_bytes_are_stored_out_of_line_without_recompression() {
        // JPEG/PNG are already compressed: letting TOAST compress with pglz again only costs CPU on every write. 'e' =
        // EXTERNAL.
        String storage = jdbcTemplate.queryForObject("""
                SELECT attstorage FROM pg_attribute
                WHERE attrelid = 'media_content'::regclass AND attname = 'data'
                """, String.class);
        assertThat(storage).isEqualTo("e");
    }

    // --- Helpers -------------------------------------------------------------------------------

    private void assertRejectedRow(String values) {
        assertThatThrownBy(() -> jdbcTemplate.update(
                        "INSERT INTO media (content_type, width, height, byte_size, dominant_color, sha256) VALUES ("
                                + values + ", '" + "0".repeat(64) + "')"))
                .as("must be rejected: %s", values)
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    private int contentRows(UUID mediaId) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM media_content WHERE media_id = ?", Integer.class, mediaId);
        return count == null ? 0 : count;
    }

    private static byte[] fixture(String name) throws IOException {
        try (InputStream in = MediaControllerIT.class.getResourceAsStream("/media/" + name)) {
            assertThat(in).as("fixture %s", name).isNotNull();
            return in.readAllBytes();
        }
    }

    private static String sha256Hex(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
