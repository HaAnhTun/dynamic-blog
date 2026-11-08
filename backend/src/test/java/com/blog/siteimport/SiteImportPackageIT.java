package com.blog.siteimport;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.i18n.Languages;
import com.blog.siteimport.format.ProfileFile;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.ZipPackages;
import com.blog.user.entity.UserRole;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The site profile import of a ZIP package through the HTTP API: the photo of the About section and the images of the
 * About page body are stored like the avatar and named in the content by their {@code /media/} paths; a preview shows
 * the change without storing anything; the same package imported twice changes nothing; the problems of a package and of
 * a plain {@code .md} file that names an image; undo restores the content and keeps the stored images.
 */
@AutoConfigureMockMvc
class SiteImportPackageIT extends AbstractIntegrationTest {

    private static final String BASE = "/api/v1/admin/site-import";
    private static final String MEDIA_PATH = "/media/[0-9a-f-]{36}\\.(jpg|png)";
    private static final List<String> ABOUT_SECTIONS = List.of("about", "about-page");

    private static final String PROFILE = """
            # About
            - photo: assets/me.png

            An introduction paragraph.

            ## Who I am {#who}
            First paragraph.

            # About page
            Opening text.

            ![A view](assets/view.png)

            More text.
            """;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private Languages languages;

    private String admin;
    private String author;
    private String locale;

    @BeforeEach
    void setUp() {
        wipe();
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        admin = auth.bearerFor(auth.createAccount("site-package-admin-" + suffix + "@blog.local", UserRole.ADMIN));
        author = auth.bearerFor(auth.createAuthor("site-package-author-" + suffix + "@blog.local"));
        locale = languages.defaultLocale();
    }

    @AfterEach
    void cleanUp() {
        wipe();
    }

    private void wipe() {
        jdbcTemplate.update("delete from site_import_log");
        jdbcTemplate.update("delete from site_content_revision");
        jdbcTemplate.update("delete from site_content");
        jdbcTemplate.update("delete from media where original_filename in ('me.png', 'view.png', 'extra.png')");
    }

    private String file(String body) {
        return "---\nschema_version: 1\ncontent_type: site-profile\nlocale: " + locale + "\n---\n" + body;
    }

    private byte[] pack(String body) {
        return ZipPackages.zip()
                .add("profile.md", file(body))
                .add("assets/me.png", ZipPackages.image("opaque.png"))
                .add("assets/view.png", ZipPackages.image("p3.png"))
                .build();
    }

    private static MockMultipartFile upload(String name, byte[] bytes) {
        return new MockMultipartFile("file", name, "application/octet-stream", bytes);
    }

    private ResultActions preview(String name, byte[] bytes) throws Exception {
        return mockMvc.perform(
                multipart(BASE + "/preview").file(upload(name, bytes)).header("Authorization", admin));
    }

    private ResultActions apply(String name, byte[] bytes) throws Exception {
        return mockMvc.perform(multipart(BASE + "/apply")
                .file(upload(name, bytes))
                .param("sha256", ProfileFile.sha256Hex(bytes))
                .param("mode", "update")
                .param("sections", ABOUT_SECTIONS.toArray(String[]::new))
                .header("Authorization", admin));
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString(UTF_8))
                .path("data");
    }

    private JsonNode error(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString(UTF_8))
                .path("error");
    }

    private static JsonNode section(JsonNode preview, String id) {
        for (JsonNode section : preview.path("sections")) {
            if (section.path("id").asString().equals(id)) {
                return section;
            }
        }
        throw new AssertionError("no section " + id);
    }

    private JsonNode storedAbout() {
        List<String> rows = jdbcTemplate.queryForList(
                "select cast(data as text) from site_content where key = 'about' and locale = ?", String.class, locale);
        return rows.isEmpty() ? null : objectMapper.readTree(rows.get(0));
    }

    private int storedImages() {
        return jdbcTemplate.queryForObject(
                "select count(*) from media where post_id is null and original_filename in ('me.png', 'view.png')",
                Integer.class);
    }

    private static List<String> messages(JsonNode errors) {
        List<String> out = new ArrayList<>();
        errors.forEach(e -> out.add(e.path("message").asString()));
        return out;
    }

    @Test
    void a_package_stores_the_photo_and_the_body_image_and_names_them_by_their_media_paths() throws Exception {
        byte[] zip = pack(PROFILE);

        JsonNode preview = data(preview("profile.zip", zip).andExpect(status().isOk()));
        assertThat(preview.path("errors").size()).isZero();
        assertThat(preview.path("pack").path("assets").asInt()).isEqualTo(2);
        assertThat(preview.path("pack").path("usedAssets").asInt()).isEqualTo(2);
        assertThat(preview.path("notes").size()).isZero();
        assertThat(section(preview, "about").path("status").asString()).isEqualTo("new");
        assertThat(section(preview, "about").path("errors").size()).isZero();
        assertThat(storedImages()).as("a preview stores nothing").isZero();

        JsonNode applied = data(apply("profile.zip", zip).andExpect(status().isOk()));
        assertThat(applied.path("importId").asLong()).isPositive();

        JsonNode about = storedAbout();
        assertThat(about.path("photo").asString()).matches(MEDIA_PATH);
        assertThat(about.path("body").asString())
                .matches("(?s)Opening text\\.\\n\\n!\\[A view]\\(" + MEDIA_PATH + "#\\d+x\\d+\\)\\n\\nMore text\\.");
        assertThat(storedImages()).isEqualTo(2);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from media where post_id is not null and original_filename in ('me.png', 'view.png')",
                        Integer.class))
                .as("the images belong to no post")
                .isZero();
    }

    @Test
    void the_same_package_twice_is_unchanged_and_stores_no_second_copy() throws Exception {
        byte[] zip = pack(PROFILE);
        apply("profile.zip", zip).andExpect(status().isOk());
        JsonNode first = storedAbout();

        JsonNode again = data(preview("profile.zip", zip).andExpect(status().isOk()));
        assertThat(section(again, "about").path("status").asString()).isEqualTo("unchanged");
        assertThat(section(again, "about-page").path("status").asString()).isEqualTo("unchanged");
        JsonNode applied = data(apply("profile.zip", zip).andExpect(status().isOk()));

        assertThat(applied.path("sections").get(0).path("status").asString()).isEqualTo("unchanged");
        assertThat(applied.path("importId").isNull()).isTrue();
        assertThat(storedAbout()).isEqualTo(first);
        assertThat(storedImages()).isEqualTo(2);
    }

    @Test
    void an_avatar_with_the_same_bytes_is_never_shared_with_the_about_page() throws Exception {
        mockMvc.perform(multipart("/api/v1/admin/site-content/avatar")
                        .file(new MockMultipartFile("file", "avatar.png", "image/png", ZipPackages.image("opaque.png")))
                        .header("Authorization", admin))
                .andExpect(status().isCreated());
        String avatar = jdbcTemplate.queryForObject(
                "select cast(id as text) from media where post_id is null and original_filename = 'avatar.png'",
                String.class);
        try {
            apply("profile.zip", pack(PROFILE)).andExpect(status().isOk());

            assertThat(storedAbout().path("photo").asString()).doesNotContain(avatar);
            assertThat(storedImages()).isEqualTo(2);
        } finally {
            jdbcTemplate.update("delete from media where id = cast(? as uuid)", avatar);
        }
    }

    @Test
    void undo_restores_the_content_and_the_stored_images_stay() throws Exception {
        byte[] zip = pack(PROFILE);
        long importId = data(apply("profile.zip", zip).andExpect(status().isOk()))
                .path("importId")
                .asLong();

        mockMvc.perform(post(BASE + "/undo")
                        .param("importId", String.valueOf(importId))
                        .header("Authorization", admin))
                .andExpect(status().isOk());

        assertThat(storedAbout()).isNull();
        assertThat(storedImages()).isEqualTo(2);
    }

    @Test
    void an_image_that_nothing_uses_is_a_note_and_is_not_stored() throws Exception {
        byte[] zip = ZipPackages.zip()
                .add("profile.md", file(PROFILE))
                .add("assets/me.png", ZipPackages.image("opaque.png"))
                .add("assets/view.png", ZipPackages.image("p3.png"))
                .add("assets/extra.png", ZipPackages.image("p3-alpha.png"))
                .build();

        JsonNode preview = data(preview("profile.zip", zip).andExpect(status().isOk()));
        assertThat(preview.path("notes").size()).isEqualTo(1);
        assertThat(preview.path("notes").get(0).path("code").asString()).isEqualTo("asset_unused");
        assertThat(preview.path("notes").get(0).path("key").asString()).isEqualTo("assets/extra.png");
        assertThat(preview.path("pack").path("unusedAssets").asInt()).isEqualTo(1);

        apply("profile.zip", zip).andExpect(status().isOk());
        assertThat(storedImages()).isEqualTo(2);
    }

    @Test
    void a_photo_or_body_image_that_is_not_in_the_package_is_a_problem() throws Exception {
        byte[] zip = ZipPackages.zip()
                .add("profile.md", file(PROFILE))
                .add("assets/view.png", ZipPackages.image("p3.png"))
                .build();

        JsonNode preview = data(preview("profile.zip", zip).andExpect(status().isOk()));
        JsonNode about = section(preview, "about");
        assertThat(about.path("status").asString()).isEqualTo("error");
        assertThat(about.path("errors").get(0).path("field").asString()).isEqualTo("photo");
        assertThat(messages(about.path("errors"))).anyMatch(m -> m.contains("assets/me.png"));

        byte[] noBody = ZipPackages.zip()
                .add("profile.md", file(PROFILE))
                .add("assets/me.png", ZipPackages.image("opaque.png"))
                .build();
        JsonNode second = data(preview("profile.zip", noBody).andExpect(status().isOk()));
        assertThat(section(second, "about-page").path("status").asString()).isEqualTo("error");

        ResultActions refused = apply("profile.zip", zip);
        refused.andExpect(status().isBadRequest());
        assertThat(error(refused).path("code").asString()).isEqualTo("SITE_IMPORT_INVALID");
        assertThat(error(refused).path("message").asString()).doesNotContain("assets/me.png");
        assertThat(storedAbout()).isNull();
        assertThat(storedImages()).isZero();
    }

    @Test
    void a_plain_markdown_file_that_names_an_image_path_is_a_problem_and_one_without_stays_as_before()
            throws Exception {
        byte[] plain = file(PROFILE).getBytes(UTF_8);

        JsonNode preview = data(preview("profile.md", plain).andExpect(status().isOk()));
        JsonNode about = section(preview, "about");
        assertThat(about.path("status").asString()).isEqualTo("error");
        assertThat(about.path("errors").get(0).path("field").asString()).isEqualTo("photo");
        assertThat(preview.path("pack").isNull()).isTrue();
        apply("profile.md", plain).andExpect(status().isBadRequest());

        byte[] without = file(PROFILE.replace("- photo: assets/me.png\n\n", "")
                        .replace("![A view](assets/view.png)", "A text."))
                .getBytes(UTF_8);
        apply("profile.md", without).andExpect(status().isOk());
        assertThat(storedAbout().has("photo")).isFalse();
    }

    @Test
    void the_photo_of_an_export_imports_back_unchanged() throws Exception {
        byte[] zip = pack(PROFILE);
        apply("profile.zip", zip).andExpect(status().isOk());
        String photo = storedAbout().path("photo").asString();

        String export = mockMvc.perform(
                        get(BASE + "/export").param("locale", locale).header("Authorization", admin))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString(UTF_8);
        assertThat(export).contains("- photo: " + photo);

        byte[] back = export.getBytes(UTF_8);
        JsonNode preview = data(preview("profile.md", back).andExpect(status().isOk()));
        assertThat(section(preview, "about").path("status").asString()).isEqualTo("unchanged");
        assertThat(section(preview, "about-page").path("status").asString()).isEqualTo("unchanged");
    }

    @Test
    void an_author_cannot_preview_or_apply_a_package() throws Exception {
        byte[] zip = pack(PROFILE);

        mockMvc.perform(multipart(BASE + "/preview")
                        .file(upload("profile.zip", zip))
                        .header("Authorization", author))
                .andExpect(status().isForbidden());
        mockMvc.perform(multipart(BASE + "/apply")
                        .file(upload("profile.zip", zip))
                        .param("sha256", ProfileFile.sha256Hex(zip))
                        .param("mode", "update")
                        .param("sections", "about")
                        .header("Authorization", author))
                .andExpect(status().isForbidden());
        mockMvc.perform(multipart(BASE + "/preview").file(upload("profile.zip", zip)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void a_file_that_is_not_a_readable_archive_is_refused_without_naming_anything_from_it() throws Exception {
        ResultActions refused = preview("profile.zip", "not an archive".getBytes(UTF_8));

        refused.andExpect(status().isBadRequest());
        assertThat(error(refused).path("code").asString()).isEqualTo("SITE_IMPORT_INVALID_FILE");
    }
}
