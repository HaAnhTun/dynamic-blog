package com.blog.siteimport;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.startsWith;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.i18n.Languages;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostPackage;
import com.blog.postimport.format.PostPackageReader;
import com.blog.siteimport.format.ProfileFile;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.ZipPackages;
import com.blog.user.entity.User;
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
 * The timeline logos and the ZIP export of the site profile through the HTTP API: a logo of a package is stored like the
 * About photo and named by its {@code /media/} path; the export of a language is a package (the profile file and every image
 * the content uses) that imports back unchanged on the same site and restores the content and the images on a clean one.
 */
@AutoConfigureMockMvc
class SiteImportTimelinePackageIT extends AbstractIntegrationTest {

    private static final String BASE = "/api/v1/admin/site-import";
    private static final String MEDIA_PATH = "/media/[0-9a-f-]{36}\\.(jpg|png)";
    private static final List<String> SECTIONS = List.of("about", "about-page", "timeline");

    private static final String TIMELINE = """
            # Timeline
            - experience_summary: Years of work.

            ## Platform Engineer {kind=experience}
            - org: Example Corp
            - url: https://example.com/team
            - logo: assets/logo.png
            - location: Example City
            - department: Platform
            - period: 09/2023 - Present
            - summary: Builds and runs services.
            - tech: Java | Spring Boot
            - highlight: Cut the build time.
            - highlight: Wrote the guide.

            ## BSc Software {kind=education}
            - org: Example College
            - period: 2019 - 2023
            """;

    private static final String EVERYTHING = """
            # About
            - photo: assets/me.jpg

            An introduction paragraph.

            ## Who I am {#who}
            First paragraph.

            # About page
            Opening text.

            ![A view](assets/view.png)

            More text.

            """ + TIMELINE;

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

    private User adminUser;
    private String admin;
    private String author;
    private String locale;

    @BeforeEach
    void setUp() {
        wipeContent();
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        adminUser = auth.createAccount("site-timeline-admin-" + suffix + "@blog.local", UserRole.ADMIN);
        admin = auth.bearerFor(adminUser);
        author = auth.bearerFor(auth.createAuthor("site-timeline-author-" + suffix + "@blog.local"));
        locale = languages.defaultLocale();
    }

    @AfterEach
    void cleanUp() {
        wipeContent();
        wipeImages();
    }

    private void wipeContent() {
        jdbcTemplate.update("delete from site_import_log");
        jdbcTemplate.update("delete from site_content_revision");
        jdbcTemplate.update("delete from site_content");
    }

    private void wipeImages() {
        if (adminUser != null) {
            jdbcTemplate.update("delete from media where uploaded_by = ?", adminUser.getId());
        }
    }

    private String file(String body) {
        return "---\nschema_version: 1\ncontent_type: site-profile\nlocale: " + locale + "\n---\n" + body;
    }

    private byte[] everything() {
        return ZipPackages.zip()
                .add("profile.md", file(EVERYTHING))
                .add("assets/me.jpg", ZipPackages.image("orient6.jpg"))
                .add("assets/view.png", ZipPackages.image("p3.png"))
                .add("assets/logo.png", ZipPackages.image("opaque.png"))
                .build();
    }

    private static MockMultipartFile upload(String name, byte[] bytes) {
        return new MockMultipartFile("file", name, "application/octet-stream", bytes);
    }

    private ResultActions preview(String name, byte[] bytes) throws Exception {
        return mockMvc.perform(
                multipart(BASE + "/preview").file(upload(name, bytes)).header("Authorization", admin));
    }

    private ResultActions apply(String name, byte[] bytes, List<String> sections) throws Exception {
        return mockMvc.perform(multipart(BASE + "/apply")
                .file(upload(name, bytes))
                .param("sha256", ProfileFile.sha256Hex(bytes))
                .param("mode", "update")
                .param("sections", sections.toArray(String[]::new))
                .header("Authorization", admin));
    }

    private byte[] exportZip() throws Exception {
        return mockMvc.perform(get(BASE + "/export")
                        .param("locale", locale)
                        .param("format", "zip")
                        .header("Authorization", admin))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsByteArray();
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

    private JsonNode stored(String key) {
        List<String> rows = jdbcTemplate.queryForList(
                "select cast(data as text) from site_content where key = ? and locale = ?", String.class, key, locale);
        return rows.isEmpty() ? null : objectMapper.readTree(rows.get(0));
    }

    private int storedImages() {
        return jdbcTemplate.queryForObject(
                "select count(*) from media where uploaded_by = ?", Integer.class, adminUser.getId());
    }

    private List<String> imageFacts() {
        return jdbcTemplate.queryForList(
                "select content_type || ' ' || width || 'x' || height from media where uploaded_by = ?"
                        + " order by content_type, width, height",
                String.class,
                adminUser.getId());
    }

    /** The stored content with the ids of the images taken out, so that two copies of the same content compare equal. */
    private static String withoutImageIds(JsonNode content) {
        return content.toString().replaceAll("/media/[0-9a-f-]{36}", "/media/ID");
    }

    private static List<String> messages(JsonNode errors) {
        List<String> out = new ArrayList<>();
        errors.forEach(e -> out.add(e.path("message").asString()));
        return out;
    }

    // --- Logos ----------------------------------------------------------------------------------------------------

    @Test
    void a_package_stores_the_logo_and_names_it_by_its_media_path() throws Exception {
        byte[] zip = ZipPackages.zip()
                .add("profile.md", file(TIMELINE))
                .add("assets/logo.png", ZipPackages.image("opaque.png"))
                .build();

        JsonNode preview = data(preview("profile.zip", zip).andExpect(status().isOk()));
        assertThat(preview.path("errors").size()).isZero();
        assertThat(preview.path("pack").path("usedAssets").asInt()).isEqualTo(1);
        assertThat(preview.path("notes").size()).isZero();
        assertThat(section(preview, "timeline").path("status").asString()).isEqualTo("new");
        assertThat(storedImages()).as("a preview stores nothing").isZero();

        data(apply("profile.zip", zip, List.of("timeline")).andExpect(status().isOk()));

        JsonNode timeline = stored("timeline");
        JsonNode job = timeline.path("entries").get(0);
        assertThat(job.path("logo").asString()).matches(MEDIA_PATH);
        assertThat(job.path("title").asString()).isEqualTo("Platform Engineer");
        assertThat(job.path("url").asString()).isEqualTo("https://example.com/team");
        assertThat(job.path("location").asString()).isEqualTo("Example City");
        assertThat(job.path("department").asString()).isEqualTo("Platform");
        assertThat(job.path("tech").toString()).isEqualTo("[\"Java\",\"Spring Boot\"]");
        assertThat(job.path("highlights").toString()).isEqualTo("[\"Cut the build time.\",\"Wrote the guide.\"]");
        assertThat(timeline.path("entries").get(1).has("logo")).isFalse();
        assertThat(timeline.path("entries").get(1).has("tech")).isFalse();
        assertThat(storedImages()).isEqualTo(1);
    }

    @Test
    void the_same_logo_package_twice_is_unchanged_and_stores_no_second_copy() throws Exception {
        byte[] zip = ZipPackages.zip()
                .add("profile.md", file(TIMELINE))
                .add("assets/logo.png", ZipPackages.image("opaque.png"))
                .build();
        apply("profile.zip", zip, List.of("timeline")).andExpect(status().isOk());
        JsonNode first = stored("timeline");

        JsonNode again = data(preview("profile.zip", zip).andExpect(status().isOk()));
        assertThat(section(again, "timeline").path("status").asString()).isEqualTo("unchanged");
        JsonNode applied = data(apply("profile.zip", zip, List.of("timeline")).andExpect(status().isOk()));

        assertThat(applied.path("importId").isNull()).isTrue();
        assertThat(stored("timeline")).isEqualTo(first);
        assertThat(storedImages()).isEqualTo(1);
    }

    @Test
    void a_logo_that_is_not_in_the_package_is_a_problem_and_so_is_a_path_in_a_plain_file() throws Exception {
        byte[] noLogo = ZipPackages.zip().add("profile.md", file(TIMELINE)).build();

        JsonNode preview = data(preview("profile.zip", noLogo).andExpect(status().isOk()));
        JsonNode timeline = section(preview, "timeline");
        assertThat(timeline.path("status").asString()).isEqualTo("error");
        assertThat(timeline.path("errors").get(0).path("field").asString()).isEqualTo("logo");
        assertThat(messages(timeline.path("errors"))).anyMatch(m -> m.contains("assets/logo.png"));

        ResultActions refused = apply("profile.zip", noLogo, List.of("timeline"));
        refused.andExpect(status().isBadRequest());
        assertThat(error(refused).path("code").asString()).isEqualTo("SITE_IMPORT_INVALID");
        assertThat(error(refused).path("message").asString()).doesNotContain("assets/logo.png");

        byte[] plain = file(TIMELINE).getBytes(UTF_8);
        JsonNode plainPreview = data(preview("profile.md", plain).andExpect(status().isOk()));
        assertThat(section(plainPreview, "timeline").path("status").asString()).isEqualTo("error");
        apply("profile.md", plain, List.of("timeline")).andExpect(status().isBadRequest());
        assertThat(stored("timeline")).isNull();
        assertThat(storedImages()).isZero();
    }

    @Test
    void an_unused_logo_image_is_a_note_and_a_logo_that_is_not_an_uploaded_path_is_a_problem() throws Exception {
        byte[] unused = ZipPackages.zip()
                .add("profile.md", file(TIMELINE.replace("- logo: assets/logo.png\n", "")))
                .add("assets/logo.png", ZipPackages.image("opaque.png"))
                .build();
        JsonNode preview = data(preview("profile.zip", unused).andExpect(status().isOk()));
        assertThat(preview.path("notes").get(0).path("code").asString()).isEqualTo("asset_unused");

        byte[] remote = file(TIMELINE.replace("assets/logo.png", "https://example.com/logo.png"))
                .getBytes(UTF_8);
        JsonNode remotePreview = data(preview("profile.md", remote).andExpect(status().isOk()));
        assertThat(section(remotePreview, "timeline").path("status").asString()).isEqualTo("error");
    }

    @Test
    void the_older_five_column_rows_still_import() throws Exception {
        byte[] rows = file("""
                # Timeline
                ## Entries
                - experience | Engineer | Example Org | 2020 - 2024 | Built things.
                - education | Degree
                """).getBytes(UTF_8);

        apply("profile.md", rows, List.of("timeline")).andExpect(status().isOk());

        JsonNode entries = stored("timeline").path("entries");
        assertThat(entries.size()).isEqualTo(2);
        assertThat(entries.get(0).path("org").asString()).isEqualTo("Example Org");
        assertThat(entries.get(0).has("logo")).isFalse();
    }

    @Test
    void one_logo_image_used_by_two_entries_is_stored_once() throws Exception {
        String twice =
                TIMELINE.replace("- org: Example College\n", "- org: Example College\n- logo: assets/logo.png\n");
        byte[] zip = ZipPackages.zip()
                .add("profile.md", file(twice))
                .add("assets/logo.png", ZipPackages.image("opaque.png"))
                .build();

        JsonNode preview = data(preview("profile.zip", zip).andExpect(status().isOk()));
        assertThat(preview.path("pack").path("usedAssets").asInt()).isEqualTo(1);
        apply("profile.zip", zip, List.of("timeline")).andExpect(status().isOk());

        JsonNode entries = stored("timeline").path("entries");
        assertThat(entries.get(0).path("logo").asString()).matches(MEDIA_PATH);
        assertThat(entries.get(1).path("logo").asString())
                .isEqualTo(entries.get(0).path("logo").asString());
        assertThat(storedImages()).isEqualTo(1);
    }

    @Test
    void the_logo_of_a_markdown_export_is_its_media_path_and_imports_back_unchanged() throws Exception {
        byte[] zip = ZipPackages.zip()
                .add("profile.md", file(TIMELINE))
                .add("assets/logo.png", ZipPackages.image("opaque.png"))
                .build();
        apply("profile.zip", zip, List.of("timeline")).andExpect(status().isOk());
        String logo = stored("timeline").path("entries").get(0).path("logo").asString();

        String export = mockMvc.perform(
                        get(BASE + "/export").param("locale", locale).header("Authorization", admin))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString(UTF_8);
        assertThat(export).contains("- logo: " + logo);

        byte[] back = export.getBytes(UTF_8);
        JsonNode preview = data(preview("site-profile.md", back).andExpect(status().isOk()));
        assertThat(section(preview, "timeline").path("status").asString()).isEqualTo("unchanged");
        assertThat(preview.path("errors").size()).isZero();
    }

    // --- The ZIP export -------------------------------------------------------------------------------------------

    @Test
    void the_export_zip_is_a_package_with_the_profile_file_and_every_image_and_the_download_headers() throws Exception {
        apply("profile.zip", everything(), SECTIONS).andExpect(status().isOk());

        byte[] zip = mockMvc.perform(get(BASE + "/export")
                        .param("locale", locale)
                        .param("format", "zip")
                        .header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", "application/zip"))
                .andExpect(header().string(
                                "Content-Disposition", "attachment; filename=\"site-profile-" + locale + ".zip\""))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(header().string("Cache-Control", "no-store"))
                .andReturn()
                .getResponse()
                .getContentAsByteArray();

        PostPackage pack = PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);
        assertThat(pack.readable()).isTrue();
        assertThat(pack.problems()).isEmpty();
        assertThat(pack.assets()).hasSize(3);
        assertThat(pack.markdown())
                .contains("# About", "# About page", "# Timeline")
                .containsPattern("- photo: assets/photo-1\\.(jpg|png)")
                .containsPattern("- logo: assets/logo-example-corp-\\d\\.(jpg|png)")
                .doesNotContain("/media/");
        assertThat(zip).isEqualTo(exportZip());
    }

    @Test
    void the_markdown_export_is_still_the_default_and_a_format_that_does_not_exist_is_refused() throws Exception {
        apply("profile.zip", everything(), SECTIONS).andExpect(status().isOk());

        mockMvc.perform(get(BASE + "/export").param("locale", locale).header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", startsWith("text/markdown")));
        mockMvc.perform(get(BASE + "/export")
                        .param("locale", locale)
                        .param("format", "md")
                        .header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", startsWith("text/markdown")));
        ResultActions refused = mockMvc.perform(get(BASE + "/export")
                .param("locale", locale)
                .param("format", "docx")
                .header("Authorization", admin));
        refused.andExpect(status().isBadRequest());
        assertThat(error(refused).path("code").asString()).isEqualTo("VALIDATION_ERROR");
    }

    @Test
    void a_package_exported_and_imported_again_on_the_same_site_is_unchanged() throws Exception {
        apply("profile.zip", everything(), SECTIONS).andExpect(status().isOk());
        JsonNode about = stored("about");
        JsonNode timeline = stored("timeline");
        List<String> images = imageFacts();
        byte[] zip = exportZip();

        JsonNode preview = data(preview("site-profile.zip", zip).andExpect(status().isOk()));
        assertThat(preview.path("errors").size()).isZero();
        for (String id : SECTIONS) {
            assertThat(section(preview, id).path("status").asString()).as(id).isEqualTo("unchanged");
        }
        JsonNode applied = data(apply("site-profile.zip", zip, SECTIONS).andExpect(status().isOk()));

        assertThat(applied.path("importId").isNull()).isTrue();
        assertThat(stored("about")).isEqualTo(about);
        assertThat(stored("timeline")).isEqualTo(timeline);
        assertThat(storedImages()).as("no second copy of any image").isEqualTo(3);
        assertThat(imageFacts()).isEqualTo(images);
    }

    @Test
    void a_package_exported_and_imported_on_a_clean_site_restores_the_content_and_the_images() throws Exception {
        apply("profile.zip", everything(), SECTIONS).andExpect(status().isOk());
        String about = withoutImageIds(stored("about"));
        String timeline = withoutImageIds(stored("timeline"));
        List<String> images = imageFacts();
        byte[] zip = exportZip();

        wipeContent();
        wipeImages();
        assertThat(stored("about")).isNull();
        assertThat(storedImages()).isZero();

        JsonNode preview = data(preview("site-profile.zip", zip).andExpect(status().isOk()));
        for (String id : SECTIONS) {
            assertThat(section(preview, id).path("status").asString()).as(id).isEqualTo("new");
        }
        apply("site-profile.zip", zip, SECTIONS).andExpect(status().isOk());

        assertThat(withoutImageIds(stored("about"))).isEqualTo(about);
        assertThat(withoutImageIds(stored("timeline"))).isEqualTo(timeline);
        assertThat(stored("about").path("photo").asString()).matches(MEDIA_PATH);
        assertThat(stored("timeline").path("entries").get(0).path("logo").asString())
                .matches(MEDIA_PATH);
        assertThat(storedImages()).isEqualTo(3);
        assertThat(imageFacts()).isEqualTo(images);
        // And the restored site exports the same package again.
        assertThat(PostPackageReader.read(exportZip(), PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES)
                        .markdown())
                .isEqualTo(PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES)
                        .markdown());
    }

    @Test
    void an_author_cannot_export_a_package() throws Exception {
        mockMvc.perform(get(BASE + "/export")
                        .param("locale", locale)
                        .param("format", "zip")
                        .header("Authorization", author))
                .andExpect(status().isForbidden());
        mockMvc.perform(get(BASE + "/export").param("locale", locale).param("format", "zip"))
                .andExpect(status().isUnauthorized());
    }
}
