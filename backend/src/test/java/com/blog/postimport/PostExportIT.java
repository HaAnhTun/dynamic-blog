package com.blog.postimport;

import static com.blog.support.ZipPackages.image;
import static com.blog.support.ZipPackages.zip;
import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.postimport.format.ParsedPost;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostMarkdownParser;
import com.blog.postimport.format.PostPackage;
import com.blog.postimport.format.PostPackageReader;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.UserRole;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
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
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The "Download ZIP" export through the HTTP API, with the real filter chain and a real database: who may call it, what it
 * answers, and above all that conversion works both ways, so a post exported as a package and imported again is the same post.
 *
 * Every test has its own accounts and puts a random token into every slug: the database is shared and never cleaned.
 */
@AutoConfigureMockMvc
class PostExportIT extends AbstractIntegrationTest {

    private static final String IMPORT = "/api/v1/admin/post-import";
    private static final Path FIXTURES = Path.of("..", "fixtures", "article-packages");
    private static final Pattern MEDIA_URL = Pattern.compile("/media/([0-9a-f-]{36})\\.(png|jpg)(#\\d+x\\d+)?");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String admin;
    private String author;
    private String otherAuthor;
    private String reader;
    private String token;

    @BeforeEach
    void setUp() {
        token = UUID.randomUUID().toString().substring(0, 8);
        admin = auth.bearerFor(auth.createAccount("exp-admin-" + token + "@blog.local", UserRole.ADMIN));
        author = auth.bearerFor(auth.createAuthor("exp-author-" + token + "@blog.local"));
        otherAuthor = auth.bearerFor(auth.createAuthor("exp-other-" + token + "@blog.local"));
        reader = auth.bearerFor(auth.createReader(auth.nextGithubId(), "exp-reader-" + token));
    }

    // --- Who may export, and what the answer looks like -------------------------------------------------------

    @Test
    void an_author_exports_their_own_draft_as_a_zip_with_the_download_headers() throws Exception {
        String slug = "export-own-" + token;
        UUID id = importFixture(author, "a-architecture", slug);

        MockHttpServletResponse response =
                export(author, id).andExpect(status().isOk()).andReturn().getResponse();

        assertThat(response.getContentType()).isEqualTo("application/zip");
        assertThat(response.getHeader("Content-Disposition"))
                .startsWith("attachment")
                .contains("filename=\"" + slug + ".zip\"");
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
        PostPackage pack =
                PostPackageReader.read(response.getContentAsByteArray(), PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);
        assertThat(pack.problems()).isEmpty();
        assertThat(pack.assets()).hasSize(1);
        assertThat(pack.assets().get(0).path()).matches("assets/[a-z0-9-]+-1\\.png");
        ParsedPost parsed = PostMarkdownParser.parse(1, "article.md", pack.markdown());
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().slug()).isEqualTo(slug);
        assertThat(parsed.values().status()).isEqualTo("DRAFT");
        assertThat(parsed.values().content())
                .contains("src=\"" + pack.assets().get(0).path() + "\"")
                .doesNotContain("/media/");
    }

    @Test
    void an_admin_exports_any_post_and_the_others_are_refused_in_the_usual_way() throws Exception {
        UUID id = importFixture(author, "a-architecture", "export-who-" + token);

        export(admin, id).andExpect(status().isOk());
        export(otherAuthor, id).andExpect(status().isForbidden());
        export(reader, id).andExpect(status().isForbidden());
        export(null, id).andExpect(status().isUnauthorized());
        // An administrator gets the honest answer for a post that does not exist; an author is refused before it is
        // looked up.
        export(admin, UUID.randomUUID()).andExpect(status().isNotFound());
        export(author, UUID.randomUUID()).andExpect(status().isForbidden());
    }

    @Test
    void a_post_with_a_published_translation_names_it_in_translation_of_and_a_draft_names_nothing() throws Exception {
        UUID id = importFixture(author, "a-architecture", "export-tr-" + token);
        UUID sibling = importFixture(author, "a-architecture", "export-tr-vi-" + token);
        jdbcTemplate.update(
                "update posts set language = 'vi', status = 'PUBLISHED', published_at = now() where id = ?", sibling);
        jdbcTemplate.update(
                "update posts set translation_group_id = ? where id in (?, ?)", UUID.randomUUID(), id, sibling);

        assertThat(articleOf(export(author, id))).contains("translation_of: export-tr-vi-" + token + "\n");
        // The post is a draft: it is never named as the translation of its published sibling.
        assertThat(articleOf(export(author, sibling))).doesNotContain("translation_of");
    }

    // --- The round trip -----------------------------------------------------------------------------------------

    @Test
    void a_package_exported_and_imported_again_is_the_same_post_with_the_same_images() throws Exception {
        String slug = "export-trip-" + token;
        UUID id = importFixture(author, "a-architecture", slug);
        Map<String, Object> before = describe(id);
        String bodyBefore = canonicalBody(id);
        byte[] zip = export(author, id)
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsByteArray();
        List<String> mediaBefore = media(id);
        assertThat(mediaBefore).isNotEmpty();

        // The exported file against the post that exists: the truth is recorded in docs/post-file-format.md.
        JsonNode preview = preview(author, "trip.zip", zip);
        JsonNode card = preview.path("files").get(0);
        assertThat(card.path("state").asString()).isEqualTo("will_change");
        assertThat(card.path("changes").path("contentDiffers").asBoolean()).isTrue();
        assertThat(card.path("changes").path("title").path("before").asString())
                .isEqualTo(card.path("changes").path("title").path("after").asString());
        assertThat(card.path("changes").path("tagsAdded").asInt()).isZero();
        assertThat(card.path("changes").path("tagsRemoved").asInt()).isZero();

        jdbcTemplate.update("delete from posts where id = ?", id);
        UUID again = importZip(author, "trip.zip", zip, slug);

        assertThat(describe(again)).isEqualTo(before);
        assertThat(canonicalBody(again)).isEqualTo(bodyBefore);
        assertThat(media(again)).isEqualTo(mediaBefore);
    }

    @Test
    void a_package_of_a_post_without_images_is_unchanged_when_previewed_against_the_post_it_came_from()
            throws Exception {
        UUID id = createDraft(admin, "Plain " + token);
        byte[] zip = export(admin, id)
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsByteArray();

        JsonNode card = preview(admin, "plain.zip", zip).path("files").get(0);

        assertThat(card.path("state").asString()).isEqualTo("unchanged");
        assertThat(card.path("pkg").path("assets").asInt()).isZero();
    }

    @Test
    void a_post_written_by_hand_with_every_kind_of_reference_exports_and_imports_with_the_same_text() throws Exception {
        UUID id = createDraft(admin, "Hand written " + token);
        String one = upload(admin, id, "opaque.png", "Overview");
        String two = upload(admin, id, "p3.png", "Harbour");
        String content = "Intro.\n\n![Overview](" + one + ")\n\n![With a title](" + two + " \"A title\")\n\n"
                + "::figure{src=\"" + one + "\" alt=\"Overview again\" caption=\"A caption\"}\n\n"
                + ":::figure{src=\"" + two + "\" alt=\"Harbour\"}\nThe caption inside.\n:::\n\n"
                + ":::gallery{columns=2}\n![First](" + one + ")\n![Second](" + two + ")\n:::\n\n"
                + "A [link to the image](" + two + ") and a [reference][img].\n\n[img]: " + one + "\n\n"
                + "```markdown\n![in a fence](" + one + ")\n```\n\nInline `![code](" + one + ")` stays.\n";
        saveContent(admin, id, content);
        Map<String, String> hashes = hashesOf(id);
        String bodyBefore = canonicalBody(id, hashes);
        byte[] zip = export(admin, id)
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsByteArray();

        PostPackage pack = PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);
        assertThat(pack.assets()).hasSize(2);
        // Only what is outside code was rewritten: the fence and the code span still name the site path.
        assertThat(pack.markdown()).contains("![in a fence](" + one + ")").contains("`![code](" + one + ")`");

        String slug = jdbcTemplate.queryForObject("select slug from posts where id = ?", String.class, id);
        jdbcTemplate.update("delete from posts where id = ?", id);
        UUID again = importZip(admin, "hand.zip", zip, slug);

        assertThat(canonicalBody(again, hashes)).isEqualTo(bodyBefore);
    }

    @Test
    void a_post_of_a_series_with_a_declared_part_keeps_the_series_and_the_part() throws Exception {
        String series = "Export series " + token;
        String slug = "export-series-" + token;
        byte[] source = zip().add(
                        "article.md",
                        "---\ntitle: Part two\nslug: " + slug + "\nlanguage: en\ntags: queues\nseries: " + series
                                + "\nseries_part: 2\nseries_description: All about queues " + token
                                + ".\n---\n\nThe text of part two.\n")
                .build();
        UUID id = importZip(admin, "series.zip", source, slug);
        byte[] zip = export(admin, id)
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsByteArray();
        PostPackage pack = PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);
        assertThat(pack.markdown())
                .contains("series: " + series + "\n")
                .contains("series_part: 2\n")
                .contains("series_description: All about queues " + token + ".\n");

        jdbcTemplate.update("delete from posts where id = ?", id);
        jdbcTemplate.update("delete from series where title = ?", series);
        UUID again = importZip(admin, "series.zip", zip, slug);

        Map<String, Object> row = jdbcTemplate.queryForMap(
                "select s.title, s.description, p.series_part from posts p join series s on s.id = p.series_id where p.id = ?",
                again);
        assertThat(row.get("title")).isEqualTo(series);
        assertThat(row.get("description")).isEqualTo("All about queues " + token + ".");
        assertThat(row.get("series_part")).isEqualTo(2);
    }

    @Test
    void a_post_in_a_series_without_a_declared_part_is_exported_without_series_keys() throws Exception {
        UUID id = createDraft(admin, "No part " + token);
        UUID series = UUID.randomUUID();
        jdbcTemplate.update(
                "insert into series (id, title, slug) values (?, ?, ?)", series, "Plain " + token, "plain-" + token);
        jdbcTemplate.update("update posts set series_id = ?, series_position = 1 where id = ?", series, id);

        assertThat(articleOf(export(admin, id))).doesNotContain("series");
    }

    @Test
    void an_author_exporting_a_post_gets_no_metadata_of_an_image_that_is_not_their_posts() throws Exception {
        // A site image the author did not upload (a gallery photo, say), with a file name only the admin should see.
        UUID media = UUID.randomUUID();
        byte[] png = image("opaque.png");
        jdbcTemplate.update(
                "insert into media (id, content_type, width, height, byte_size, sha256, original_filename, uploaded_by) "
                        + "values (?, 'image/png', 1, 1, ?, ?, 'secret-name.png', "
                        + "(select id from users where email = 'admin@blog.local'))",
                media,
                png.length,
                "cd".repeat(32));
        jdbcTemplate.update("insert into media_content (media_id, data) values (?, ?)", media, png);
        UUID id = createDraft(author, "Borrowed image " + token);
        saveContent(author, id, "Text.\n\n![](/media/" + media + ".png)\n");

        byte[] byAuthor = export(author, id)
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsByteArray();
        PostPackage authors = PostPackageReader.read(byAuthor, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);

        // The reference stays as written and nothing named after the file is in the package.
        assertThat(authors.assets()).isEmpty();
        assertThat(authors.markdown()).contains("/media/" + media + ".png");
        assertThat(new String(byAuthor, java.nio.charset.StandardCharsets.ISO_8859_1))
                .doesNotContain("secret-name");

        // An admin still gets the image, named as before.
        byte[] byAdmin = export(admin, id)
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsByteArray();
        PostPackage admins = PostPackageReader.read(byAdmin, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);
        assertThat(admins.assets()).hasSize(1);
        assertThat(admins.assets().get(0).path()).contains("secret-name");
    }

    // --- Helpers ------------------------------------------------------------------------------------------------

    private ResultActions export(String bearer, UUID id) throws Exception {
        var request = get("/api/v1/admin/posts/" + id + "/export");
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        return mockMvc.perform(request);
    }

    private String articleOf(ResultActions result) throws Exception {
        byte[] zip = result.andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
        return PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES)
                .markdown();
    }

    /** The package of a fixture folder with its own slug (the shared database keeps every post). */
    private static byte[] fixture(String folder, String slug) throws IOException {
        Path dir = FIXTURES.resolve(folder);
        String article =
                Files.readString(dir.resolve("article.md"), UTF_8).replaceFirst("(?m)^slug: .*$", "slug: " + slug);
        var builder = zip().add("article.md", article);
        try (Stream<Path> files = Files.walk(dir.resolve("assets"))) {
            for (Path file : files.filter(Files::isRegularFile).sorted().toList()) {
                builder.add("assets/" + file.getFileName(), Files.readAllBytes(file));
            }
        }
        return builder.build();
    }

    private UUID importFixture(String bearer, String folder, String slug) throws Exception {
        return importZip(bearer, folder + ".zip", fixture(folder, slug), slug);
    }

    private UUID importZip(String bearer, String name, byte[] zip, String slug) throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", name, "application/zip", zip);
        MockMultipartHttpServletRequestBuilder previewRequest =
                multipart(IMPORT + "/preview").file(file).header("Authorization", bearer);
        JsonNode preview = data(mockMvc.perform(previewRequest).andExpect(status().isOk()));
        ArrayNode items = objectMapper.createArrayNode();
        ObjectNode item = items.addObject();
        item.put("sha256", preview.path("files").get(0).path("sha256").asString());
        item.put("selected", true);
        item.put("state", preview.path("files").get(0).path("previewState").asString());
        mockMvc.perform(multipart(IMPORT + "/apply")
                        .file(file)
                        .param("manifest", objectMapper.writeValueAsString(items))
                        .header("Authorization", bearer))
                .andExpect(status().isOk());
        return jdbcTemplate.queryForObject("select id from posts where slug = ?", UUID.class, slug);
    }

    private JsonNode preview(String bearer, String name, byte[] zip) throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", name, "application/zip", zip);
        return data(mockMvc.perform(multipart(IMPORT + "/preview").file(file).header("Authorization", bearer))
                .andExpect(status().isOk()));
    }

    private UUID createDraft(String bearer, String title) throws Exception {
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("title", title, "content", "Placeholder.", "language", "en"))))
                .andExpect(status().isCreated()));
        return UUID.fromString(created.path("id").asString());
    }

    /** Uploads an image into the body of the post and returns the path the editor writes for it. */
    private String upload(String bearer, UUID postId, String resource, String alt) throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", resource, "application/octet-stream", image(resource));
        JsonNode media = data(mockMvc.perform(multipart("/api/v1/admin/posts/" + postId + "/images")
                        .file(file)
                        .param("altText", alt)
                        .header("Authorization", bearer))
                .andExpect(status().isOk()));
        return "/media/" + media.path("fileName").asString();
    }

    private void saveContent(String bearer, UUID id, String content) throws Exception {
        mockMvc.perform(put("/api/v1/admin/posts/" + id)
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("title", "Hand written " + token, "content", content))))
                .andExpect(status().isOk());
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString(UTF_8))
                .path("data");
    }

    /** What the round trip must keep: the fields of the post the file carries. */
    private Map<String, Object> describe(UUID id) {
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "select title, excerpt, language, featured, status, category_id from posts where id = ?", id);
        List<String> tags = jdbcTemplate.queryForList(
                "select t.slug from post_tags pt join tags t on t.id = pt.tag_id where pt.post_id = ? order by t.slug",
                String.class,
                id);
        return Map.of(
                "row", row,
                "tags", tags);
    }

    /**
     * The body with every site image replaced by the hash of its bytes, so two posts can be compared. The {@code #<w>x<h>} hint
     * that an import appends to a path is dropped: a hand-written path has none, and the sizes are compared on the images.
     */
    private String canonicalBody(UUID id) {
        return canonicalBody(id, Map.of());
    }

    /**
     * Like {@link #canonicalBody(UUID)}; a path that names an image which no longer exists (the original post is deleted before
     * its package is imported again, and a path in a code fence is kept as written) is read as the hash in {@code known}.
     */
    private String canonicalBody(UUID id, Map<String, String> known) {
        String content = jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, id);
        Matcher matcher = MEDIA_URL.matcher(content);
        StringBuilder out = new StringBuilder();
        while (matcher.find()) {
            List<String> sha = jdbcTemplate.queryForList(
                    "select sha256 from media where id = ?", String.class, UUID.fromString(matcher.group(1)));
            String hash = sha.isEmpty() ? known.get(matcher.group(1)) : sha.get(0);
            matcher.appendReplacement(out, Matcher.quoteReplacement("IMAGE:" + hash));
        }
        matcher.appendTail(out);
        return out.toString();
    }

    /** The hash of the bytes of each image of the post, by id. */
    private Map<String, String> hashesOf(UUID postId) {
        Map<String, String> hashes = new java.util.HashMap<>();
        jdbcTemplate.query(
                "select id, sha256 from media where post_id = ?",
                rs -> {
                    hashes.put(rs.getString("id"), rs.getString("sha256"));
                },
                postId);
        return hashes;
    }

    /** The hashes of the images of the post, in the order of creation. */
    private List<String> media(UUID id) {
        return jdbcTemplate.queryForList(
                "select sha256 || ':' || width || 'x' || height from media where post_id = ? order by sha256",
                String.class,
                id);
    }
}
