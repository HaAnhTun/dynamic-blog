package com.blog.postimport;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.i18n.Languages;
import com.blog.postimport.format.PostFile;
import com.blog.postimport.service.PreviewState;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogAssertions;
import com.blog.user.entity.UserRole;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The preview of the post import through the HTTP API, with the real filter chain and a real database: what a preview says
 * for new files, every note and problem, the slug rules, the category and tag resolution, the limits of an upload, who may
 * call it, the rate limit, and that it writes nothing and tells nothing about a file in an error or a log line.
 *
 * Every test has its own accounts (the rate limit is per person) and puts a random token into every slug and name: the
 * database is shared and never cleaned. Posts, categories and tags used as fixtures are made through the admin API.
 */
@AutoConfigureMockMvc
class PostImportPreviewIT extends AbstractIntegrationTest {

    private static final String BASE = "/api/v1/admin/post-import";
    private static final String BODY = "A short body for the import preview.\n";

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
    private String otherAuthor;
    private String reader;
    private String token;
    private String defaultLanguage;
    private String otherLanguage;

    @BeforeEach
    void setUp() {
        token = UUID.randomUUID().toString().substring(0, 8);
        admin = auth.bearerFor(auth.createAccount("post-import-admin-" + token + "@blog.local", UserRole.ADMIN));
        author = auth.bearerFor(auth.createAuthor("post-import-author-" + token + "@blog.local"));
        otherAuthor = auth.bearerFor(auth.createAuthor("post-import-other-" + token + "@blog.local"));
        reader = auth.bearerFor(auth.createReader(auth.nextGithubId(), "post-import-reader-" + token));
        defaultLanguage = languages.defaultLocale();
        otherLanguage = languages.enabled().stream()
                .filter(language -> !language.equals(defaultLanguage))
                .findFirst()
                .orElseThrow();
    }

    // --- A new file -----------------------------------------------------------------------------------------

    @Test
    void a_new_file_is_previewed_as_new_with_its_slug_language_hash_and_state_and_nothing_is_written()
            throws Exception {
        String text = file(
                "title: Preview " + token,
                "slug: new-" + token,
                "excerpt: One sentence.",
                "category: Fresh category " + token,
                "tags: first-" + token + ", second-" + token);
        Snapshot before = snapshot();

        JsonNode data = data(preview(author, markdown("new.md", text)).andExpect(status().isOk()));

        JsonNode file = data.path("files").get(0);
        assertThat(file.path("position").asInt()).isEqualTo(1);
        assertThat(file.path("fileName").asString()).isEqualTo("new.md");
        assertThat(file.path("bytes").asInt()).isEqualTo(text.getBytes(UTF_8).length);
        assertThat(file.path("sha256").asString()).isEqualTo(PostFile.sha256Hex(text.getBytes(UTF_8)));
        assertThat(file.path("state").asString()).isEqualTo("new");
        assertThat(file.path("slug").asString()).isEqualTo("new-" + token);
        assertThat(file.path("slugSource").isNull()).isTrue();
        assertThat(file.path("language").asString()).isEqualTo(defaultLanguage);
        assertThat(file.path("problems").size()).isZero();
        assertThat(file.path("changes").path("title").path("after").asString()).isEqualTo("Preview " + token);
        assertThat(file.path("changes").path("title").path("before").isNull()).isTrue();
        assertThat(file.path("changes").path("category").path("after").asString())
                .isEqualTo("Fresh category " + token);
        assertThat(file.path("changes").path("tagsAdded").asInt()).isEqualTo(2);
        assertThat(file.path("newCategories"))
                .extracting(JsonNode::asString)
                .containsExactly("Fresh category " + token);
        assertThat(file.path("newTags"))
                .extracting(JsonNode::asString)
                .containsExactly("first-" + token, "second-" + token);
        assertThat(codes(file))
                .containsExactlyInAnyOrder("language_defaulted", "category_will_be_created", "tags_will_be_created");
        assertThat(data.path("filesWithProblems").size()).isZero();
        assertThat(data.path("newCategoryCount").asInt()).isEqualTo(1);
        assertThat(data.path("newTagCount").asInt()).isEqualTo(2);

        // The state is opaque and carries no text from the file.
        String state = file.path("previewState").asString();
        assertThat(PreviewState.decode(state)).contains(PreviewState.forNew());
        assertThat(state).doesNotContain(token);

        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void a_file_with_only_a_title_and_a_body_is_valid_and_takes_its_slug_from_the_file_name() throws Exception {
        String text = "---\ntitle: Only a title " + token + "\n---\n" + BODY;

        JsonNode file = firstFile(preview(author, markdown("from-name-" + token + ".md", text)));

        assertThat(file.path("state").asString()).isEqualTo("new");
        assertThat(file.path("slug").asString()).isEqualTo("from-name-" + token);
        assertThat(file.path("slugSource").asString()).isEqualTo("file_name");
        assertThat(codes(file)).contains("slug_from_file_name", "language_defaulted");
    }

    @Test
    void an_empty_slug_key_counts_as_absent_and_a_file_name_that_is_no_slug_falls_back_to_the_title() throws Exception {
        String text = file("title: Hello Title " + token, "slug:");

        JsonNode named = firstFile(preview(author, markdown("named-" + token + ".md", text)));
        JsonNode titled = firstFile(preview(author, markdown("---.md", text)));

        assertThat(named.path("slug").asString()).isEqualTo("named-" + token);
        assertThat(named.path("slugSource").asString()).isEqualTo("file_name");
        assertThat(titled.path("slug").asString()).isEqualTo("hello-title-" + token);
        assertThat(titled.path("slugSource").asString()).isEqualTo("title");
        assertThat(codes(titled)).contains("slug_from_title");
    }

    @Test
    void a_slug_that_is_only_normalised_is_not_an_error_and_the_preview_shows_the_normalised_result() throws Exception {
        String text = file("title: Normalised " + token, "slug:  My  Slug!! " + token + " ");

        JsonNode file = firstFile(preview(author, markdown("x.md", text)));

        assertThat(file.path("state").asString()).isEqualTo("new");
        assertThat(file.path("slug").asString()).isEqualTo("my-slug-" + token);
    }

    // --- Notes ----------------------------------------------------------------------------------------------

    @Test
    void notes_name_the_ignored_keys_and_the_language_default_but_not_what_the_file_cannot_change() throws Exception {
        String text = file(
                "title: Notes " + token,
                "slug: notes-" + token,
                "language: " + otherLanguage.toUpperCase(java.util.Locale.ROOT),
                "featured: true",
                "status: published",
                "colour: blue",
                "two words: value");

        JsonNode file = firstFile(preview(author, markdown("notes.md", text)));

        assertThat(file.path("state").asString()).isEqualTo("new");
        assertThat(file.path("language").asString()).isEqualTo(otherLanguage);
        assertThat(codes(file))
                .containsExactlyInAnyOrder(
                        "featured_ignored", "status_ignored", "key_ignored", "key_ignored", "category_missing");
        assertThat(codes(file)).doesNotContain("language_defaulted");
        // A plain word is named, any other key only by its line.
        assertThat(file.path("ignored"))
                .extracting(i -> i.path("name").isNull() ? null : i.path("name").asString())
                .containsExactly("colour", null);
        assertThat(file.path("ignored")).extracting(i -> i.path("line").asInt()).containsExactly(7, 8);
        assertThat(file.toString()).doesNotContain("two words", "blue");
    }

    @Test
    void a_file_with_a_translation_of_gets_a_note_that_it_is_ignored_with_the_line_of_the_key() throws Exception {
        String text = file("title: Linked " + token, "slug: linked-" + token, "translation_of: other-" + token);

        JsonNode file = firstFile(preview(author, markdown("linked.md", text)));

        assertThat(file.path("state").asString()).isEqualTo("new");
        assertThat(codes(file)).contains("translation_of_ignored");
        JsonNode note = file.path("notes").get(codes(file).indexOf("translation_of_ignored"));
        assertThat(note.path("key").asString()).isEqualTo("translation_of");
        assertThat(note.path("line").asInt()).isEqualTo(4);
        assertThat(file.toString()).doesNotContain("other-" + token);
    }

    @Test
    void a_cover_in_a_plain_markdown_file_is_a_problem_with_its_line_and_a_description_alone_is_ignored()
            throws Exception {
        String withCover = file("title: Covered " + token, "slug: covered-" + token, "cover: assets/cover.png");
        String alone = file("title: Alone " + token, "slug: alone-" + token, "cover_alt: A red door");

        JsonNode covered = firstFile(preview(author, markdown("covered.md", withCover)));
        JsonNode described = firstFile(preview(author, markdown("alone.md", alone)));

        assertThat(covered.path("state").asString()).isEqualTo("error");
        assertThat(covered.path("problems"))
                .anySatisfy(problem -> assertThat(problem.path("key").asString() + ":"
                                + problem.path("line").asInt())
                        .isEqualTo("cover:4"));
        assertThat(described.path("state").asString()).isEqualTo("new");
        assertThat(described.path("notes"))
                .filteredOn(note -> "key_ignored".equals(note.path("code").asString()))
                .extracting(note ->
                        note.path("key").asString() + ":" + note.path("line").asInt())
                .containsExactly("cover_alt:4");
    }

    @Test
    void an_unedited_downloaded_file_shows_no_featured_or_status_note() throws Exception {
        createCategory("Downloaded category " + token, Map.of());
        String text = file(
                "title: Downloaded " + token,
                "slug: downloaded-" + token,
                "category: Downloaded category " + token,
                "language: " + defaultLanguage,
                "featured: false",
                "status: draft");

        JsonNode file = firstFile(preview(author, markdown("downloaded.md", text)));

        assertThat(file.path("state").asString()).isEqualTo("new");
        assertThat(codes(file)).isEmpty();
    }

    @Test
    void a_new_post_without_a_category_gets_a_note_and_stays_importable_as_a_draft() throws Exception {
        String category = "Chosen category " + token;
        createCategory(category, Map.of());
        JsonNode absent = firstFile(preview(
                author, markdown("absent.md", file("title: No category " + token, "slug: no-category-" + token))));
        JsonNode empty = firstFile(preview(
                author,
                markdown(
                        "empty.md",
                        file("title: Empty category " + token, "slug: empty-category-" + token, "category:"))));
        JsonNode given = firstFile(preview(
                author,
                markdown(
                        "given.md",
                        file(
                                "title: With category " + token,
                                "slug: with-category-" + token,
                                "category: " + category))));

        for (JsonNode file : List.of(absent, empty)) {
            assertThat(file.path("state").asString()).isEqualTo("new");
            assertThat(file.path("problems")).isEmpty();
            assertThat(file.path("previewState").isNull()).isFalse();
            assertThat(codes(file)).containsExactly("language_defaulted", "category_missing");
            JsonNode note = file.path("notes").get(1);
            assertThat(note.path("key").asString()).isEqualTo("category");
        }
        // The key is not in the file, so there is no line to point at.
        assertThat(absent.path("notes").get(1).path("line").isNull()).isTrue();
        assertThat(given.path("state").asString()).isEqualTo("new");
        assertThat(codes(given)).doesNotContain("category_missing");
    }

    // --- Problems -------------------------------------------------------------------------------------------

    @Test
    void problems_carry_the_position_the_key_and_the_line_and_never_a_value_of_the_file() throws Exception {
        String missingTitle = "---\nslug: no-title-" + token + "\n---\n" + BODY;
        String noBody = "---\ntitle: Empty body " + token + "\n---\n";
        String badLanguage = file("title: Bad language " + token, "language: zz");
        String repeated = file("title: First " + token, "title: Second " + token);
        String badFeatured = file("title: Bad flag " + token, "featured: maybe");

        JsonNode data = data(preview(
                        author,
                        markdown(named("a"), missingTitle),
                        markdown(named("b"), noBody),
                        markdown(named("c"), badLanguage),
                        markdown(named("d"), repeated),
                        markdown(named("e"), badFeatured))
                .andExpect(status().isOk()));

        assertThat(data.path("filesWithProblems")).extracting(JsonNode::asInt).containsExactly(1, 2, 3, 4, 5);
        JsonNode files = data.path("files");
        for (JsonNode file : files) {
            assertThat(file.path("state").asString()).isEqualTo("error");
            assertThat(file.path("previewState").isNull()).isTrue();
            assertThat(file.path("changes").isNull()).isTrue();
            assertThat(file.path("problems").size()).isGreaterThanOrEqualTo(1);
            for (JsonNode problem : file.path("problems")) {
                assertThat(problem.path("position").asInt())
                        .isEqualTo(file.path("position").asInt());
                assertThat(problem.path("message").asString()).doesNotContain(token);
            }
        }
        JsonNode title = files.get(0).path("problems").get(0);
        assertThat(title.path("key").asString()).isEqualTo("title");
        assertThat(files.get(1).path("problems").get(0).path("key").isNull()).isTrue();
        JsonNode language = files.get(2).path("problems").get(0);
        assertThat(language.path("key").asString()).isEqualTo("language");
        assertThat(language.path("line").asInt()).isEqualTo(3);
        JsonNode second = files.get(3).path("problems").get(0);
        assertThat(second.path("key").asString()).isEqualTo("title");
        assertThat(second.path("line").asInt()).isEqualTo(3);
        assertThat(files.get(4).path("problems").get(0).path("key").asString()).isEqualTo("featured");
    }

    @Test
    void problems_are_listed_up_to_the_cap_per_answer_but_every_file_in_error_keeps_its_first_one() throws Exception {
        // One hundred title lines make 99 problems ("given twice"): the parser's own cap of a file is not reached.
        String crowded = "---\n" + "title: t\n".repeat(100) + "---\n\n" + BODY;

        JsonNode data = data(preview(
                        author,
                        markdown(named("one"), crowded),
                        markdown(named("two"), crowded),
                        markdown(named("three"), crowded),
                        markdown(named("four"), crowded))
                .andExpect(status().isOk()));

        JsonNode files = data.path("files");
        assertThat(files).extracting(f -> f.path("problems").size()).containsExactly(99, 99, 2, 1);
        assertThat(files).extracting(f -> f.path("problemsTotal").asInt()).containsExactly(99, 99, 99, 99);
        assertThat(data.path("problemsOmitted").asInt()).isEqualTo(97 + 98);
        assertThat(data.path("filesWithProblems")).extracting(JsonNode::asInt).containsExactly(1, 2, 3, 4);
    }

    @Test
    void a_file_without_front_matter_fences_reports_the_parsers_one_problem_and_nothing_about_its_content()
            throws Exception {
        String noFences = "title: No fences " + token + "\n\n" + BODY;
        String unclosed = "---\ntitle: Unclosed " + token + "\n\n" + BODY;
        String noBody = "---\ntitle: Empty body " + token + "\n---\n";

        JsonNode files = data(preview(
                                author,
                                markdown(named("nofences"), noFences),
                                markdown(named("unclosed"), unclosed),
                                markdown(named("nobody"), noBody))
                        .andExpect(status().isOk()))
                .path("files");

        for (int i = 0; i < 3; i++) {
            JsonNode file = files.get(i);
            assertThat(file.path("state").asString()).isEqualTo("error");
            assertThat(file.path("problems")).hasSize(1);
            assertThat(file.path("problemsTotal").asInt()).isEqualTo(1);
            assertThat(file.path("changes").isNull()).isTrue();
            assertThat(file.path("previewState").isNull()).isTrue();
        }
        // An unreadable front matter says so and nothing else: no title, body or language problem, no note.
        for (int i = 0; i < 2; i++) {
            assertThat(files.get(i).path("problems").get(0).path("key").isNull())
                    .isTrue();
            assertThat(files.get(i).path("problems").get(0).path("line").asInt())
                    .isEqualTo(1);
            assertThat(files.get(i).path("notes")).isEmpty();
        }
        assertThat(files.get(0).path("problems").get(0).path("message").asString())
                .isEqualTo("the file must start with front matter between two --- lines");
        assertThat(files.get(1).path("problems").get(0).path("message").asString())
                .isEqualTo("the front matter is not closed with ---");
        // A readable file with an empty body still gets the body problem: the two cases are not told apart by the body.
        assertThat(files.get(2).path("problems").get(0).path("message").asString())
                .isEqualTo("a new post needs a body");
    }

    // --- Slugs ----------------------------------------------------------------------------------------------

    @Test
    void two_files_with_the_same_final_slug_are_both_errors_and_name_each_other_by_position_only() throws Exception {
        String shared = "shared-" + token;
        JsonNode data = data(preview(
                        author,
                        markdown("a.md", file("title: One " + token, "slug: " + shared)),
                        markdown(
                                "b.md",
                                file("title: Two " + token, "slug: " + shared.toUpperCase(java.util.Locale.ROOT))),
                        markdown("c.md", file("title: Three " + token, "slug: three-" + token)))
                .andExpect(status().isOk()));

        JsonNode files = data.path("files");
        assertThat(files.get(0).path("state").asString()).isEqualTo("error");
        assertThat(files.get(1).path("state").asString()).isEqualTo("error");
        assertThat(files.get(2).path("state").asString()).isEqualTo("new");
        assertThat(files.get(0).path("problems").get(0).path("message").asString())
                .endsWith("file 2");
        assertThat(files.get(1).path("problems").get(0).path("message").asString())
                .endsWith("file 1");
        assertThat(files.get(0).path("problems").get(0).path("key").asString()).isEqualTo("slug");
        assertThat(files.get(0).path("problems").get(0).path("line").asInt()).isEqualTo(3);
    }

    @Test
    void an_author_gets_the_same_sentence_as_for_an_old_slug_for_the_slug_of_someone_elses_draft_or_published_post()
            throws Exception {
        String draft = "theirs-" + token;
        String live = "theirs-live-" + token;
        createPost(otherAuthor, "Their secret draft title " + token, draft);
        UUID published = createPost(otherAuthor, "Their published title " + token, live);
        jdbcTemplate.update("update posts set status = 'PUBLISHED', published_at = now() where id = ?", published);

        for (String theirs : List.of(draft, live)) {
            JsonNode file =
                    firstFile(preview(author, markdown("x.md", file("title: Mine " + token, "slug: " + theirs))));

            // Not an update of that post, and not a sentence that tells a post of someone else from a slug given up.
            assertThat(file.path("state").asString()).isEqualTo("error");
            assertThat(file.path("problems")).hasSize(1);
            JsonNode problem = file.path("problems").get(0);
            assertThat(problem.path("key").asString()).isEqualTo("slug");
            assertThat(problem.path("message").asString()).isEqualTo("this slug is not available; choose another slug");
            assertThat(file.path("changes").isNull()).isTrue();
            assertThat(file.path("previewState").isNull()).isTrue();
            assertThat(file.toString()).doesNotContain("secret draft", "published title");
        }
    }

    @Test
    void a_slug_that_is_the_current_slug_of_a_post_the_caller_may_manage_matches_that_post() throws Exception {
        String mine = "mine-" + token;
        UUID mineId = createPost(author, "My draft " + token, mine);
        String adminsOwn = "admin-owned-" + token;
        createPost(admin, "Admin draft " + token, adminsOwn);
        String authors = "author-owned-" + token;
        UUID authorsId = createPost(otherAuthor, "Author draft " + token, authors);

        JsonNode asAuthor =
                firstFile(preview(author, markdown("x.md", file("title: Again " + token, "slug: " + mine))));
        JsonNode asAdmin = data(preview(
                                admin,
                                markdown("a.md", file("title: Again " + token, "slug: " + adminsOwn)),
                                markdown("b.md", file("title: Again " + token, "slug: " + authors)))
                        .andExpect(status().isOk()))
                .path("files");

        // The body of the fixture is not the body of the file, so each is an update; nothing is an error.
        for (JsonNode file : List.of(asAuthor, asAdmin.get(0), asAdmin.get(1))) {
            assertThat(file.path("state").asString()).isEqualTo("will_change");
            assertThat(file.path("problems").size()).isZero();
        }
        PreviewState own =
                PreviewState.decode(asAuthor.path("previewState").asString()).orElseThrow();
        assertThat(own.action()).isEqualTo("update");
        assertThat(own.postId()).isEqualTo(mineId);
        assertThat(own.status()).isEqualTo("DRAFT");
        PreviewState foreign = PreviewState.decode(
                        asAdmin.get(1).path("previewState").asString())
                .orElseThrow();
        assertThat(foreign.postId()).isEqualTo(authorsId);
    }

    @Test
    void a_slug_that_is_only_in_the_slug_history_of_a_post_is_an_error_for_everyone_and_is_never_taken_back()
            throws Exception {
        String old = "old-" + token;
        UUID mine = createPost(author, "History post " + token, "current-" + token);
        jdbcTemplate.update("insert into post_slug_history (old_slug, post_id) values (?, ?)", old, mine);

        JsonNode asOwner = firstFile(preview(author, markdown("x.md", file("title: Back " + token, "slug: " + old))));
        JsonNode asOther =
                firstFile(preview(otherAuthor, markdown("x.md", file("title: Back " + token, "slug: " + old))));
        JsonNode asAdmin = firstFile(preview(admin, markdown("x.md", file("title: Back " + token, "slug: " + old))));

        for (JsonNode file : List.of(asOwner, asOther, asAdmin)) {
            assertThat(file.path("state").asString()).isEqualTo("error");
            assertThat(file.path("problems").get(0).path("message").asString())
                    .isEqualTo("this slug is not available; choose another slug");
        }
    }

    // --- Categories and tags --------------------------------------------------------------------------------

    @Test
    void existing_categories_and_tags_are_matched_by_name_ignoring_case_and_across_languages_and_are_not_created()
            throws Exception {
        String category = "Category " + token;
        String tag = "Tag " + token;
        String other = "Other " + token;
        createCategory(category, Map.of(otherLanguage, Map.of("name", "Translated " + token)));
        createTag(tag, Map.of());
        createTag(other, Map.of(otherLanguage, Map.of("name", "Elsewhere " + token)));

        JsonNode file = firstFile(preview(
                author,
                markdown(
                        named("matching"),
                        file(
                                "title: Matching " + token,
                                "category:   " + category.toUpperCase(java.util.Locale.ROOT) + "  ",
                                "tags: " + tag.toLowerCase(java.util.Locale.ROOT) + ", elsewhere " + token))));

        assertThat(file.path("state").asString()).isEqualTo("new");
        assertThat(file.path("newCategories").size()).isZero();
        assertThat(file.path("newTags").size()).isZero();
        assertThat(codes(file)).doesNotContain("category_will_be_created", "tags_will_be_created", "category_missing");

        JsonNode viaTranslation = firstFile(preview(
                author,
                markdown(named("translated"), file("title: Translated " + token, "category: translated " + token))));
        assertThat(viaTranslation.path("state").asString()).isEqualTo("new");
        assertThat(viaTranslation.path("newCategories").size()).isZero();
    }

    @Test
    void a_name_with_more_than_one_candidate_is_an_error_naming_the_key_and_the_line_but_no_name() throws Exception {
        createCategory("First holder " + token, Map.of(defaultLanguage, Map.of("name", "Shared " + token)));
        createCategory("Second holder " + token, Map.of(defaultLanguage, Map.of("name", "shared " + token)));
        createTag("Tag holder one " + token, Map.of(defaultLanguage, Map.of("name", "Tagshared " + token)));
        createTag("Tag holder two " + token, Map.of(defaultLanguage, Map.of("name", "tagshared " + token)));

        JsonNode file = firstFile(preview(
                author,
                markdown(
                        named("ambiguous"),
                        file(
                                "title: Ambiguous " + token,
                                "language: " + defaultLanguage,
                                "category: Shared " + token,
                                "tags: Tagshared " + token))));

        assertThat(file.path("state").asString()).isEqualTo("error");
        assertThat(file.path("problems"))
                .extracting(p -> p.path("key").asString())
                .containsExactly("category", "tags");
        assertThat(file.path("problems"))
                .extracting(p -> p.path("line").asInt())
                .containsExactly(4, 5);
        assertThat(file.path("problems").toString()).doesNotContain(token);
        assertThat(file.path("newCategories").size()).isZero();
    }

    @Test
    void
            a_new_name_is_created_once_by_the_first_file_that_needs_it_and_over_the_cap_the_file_that_goes_over_is_the_error()
                    throws Exception {
        String shared = "Shared new " + token;
        List<MockMultipartFile> files = new ArrayList<>();
        files.add(markdown(named("a"), file("title: A " + token, "tags: " + tags("a", 20))));
        files.add(markdown(named("b"), file("title: B " + token, "tags: " + tags("b", 19) + ", " + shared)));
        files.add(markdown(named("c"), file("title: C " + token, "tags: " + tags("c", 20))));
        files.add(markdown(
                named("d"), file("title: D " + token, "category: " + shared, "tags: " + shared + ", " + tags("d", 5))));

        // As an administrator: these files carry 20 tags each, and an author may put at most
        // app.author-quota.max-tags-per-post (10 here) on a post, which the preview refuses (AuthorQuotaIT). The caps
        // of new names
        // are the same for both roles.
        JsonNode data =
                data(preview(admin, files.toArray(MockMultipartFile[]::new)).andExpect(status().isOk()));

        JsonNode result = data.path("files");
        assertThat(result.get(0).path("newTags").size()).isEqualTo(20);
        assertThat(result.get(1).path("newTags").size()).isEqualTo(20);
        // 40 tags so far, 20 more would make 60: over the cap of 50.
        assertThat(result.get(2).path("state").asString()).isEqualTo("error");
        assertThat(result.get(2).path("problems").get(0).path("key").asString()).isEqualTo("tags");
        assertThat(result.get(2).path("newTags").size()).isZero();
        // The tag of file 2 is created once: file 4 only adds its own 5, so 45 in all.
        assertThat(result.get(3).path("state").asString()).isEqualTo("new");
        assertThat(result.get(3).path("newTags").size()).isEqualTo(5);
        assertThat(result.get(3).path("newCategories"))
                .extracting(JsonNode::asString)
                .containsExactly(shared);
        assertThat(data.path("newTagCount").asInt()).isEqualTo(45);
        assertThat(data.path("newCategoryCount").asInt()).isEqualTo(1);
        assertThat(data.path("filesWithProblems")).extracting(JsonNode::asInt).containsExactly(3);
    }

    // --- Limits of an upload --------------------------------------------------------------------------------

    @Test
    void twenty_files_are_accepted_and_twenty_one_are_refused_with_the_invalid_file_code() throws Exception {
        List<MockMultipartFile> files = new ArrayList<>();
        for (int i = 1; i <= 21; i++) {
            files.add(
                    markdown("f" + i + ".md", file("title: File " + i + " " + token, "slug: bulk-" + i + "-" + token)));
        }

        JsonNode accepted = data(preview(author, files.subList(0, 20).toArray(MockMultipartFile[]::new))
                .andExpect(status().isOk()));
        assertThat(accepted.path("files").size()).isEqualTo(20);
        assertThat(accepted.path("filesWithProblems").size()).isZero();

        assertError(preview(author, files.toArray(MockMultipartFile[]::new)), 400, "POST_IMPORT_INVALID_FILE");
    }

    @Test
    void a_missing_file_part_a_wrong_name_and_an_empty_file_are_refused_naming_the_file_by_position() throws Exception {
        assertError(
                mockMvc.perform(multipartRequest().header("Authorization", author)), 400, "POST_IMPORT_INVALID_FILE");

        ResultActions wrongName = preview(
                author,
                markdown("ok.md", file("title: Ok " + token)),
                new MockMultipartFile("file", "notes.txt", "text/plain", "x".getBytes(UTF_8)));
        assertError(wrongName, 400, "POST_IMPORT_INVALID_FILE");
        assertThat(message(wrongName)).startsWith("File 2:");

        ResultActions empty = preview(author, new MockMultipartFile("file", "empty.md", "text/markdown", new byte[0]));
        assertError(empty, 400, "POST_IMPORT_INVALID_FILE");
        assertThat(message(empty)).startsWith("File 1:");

        ResultActions control = preview(
                author,
                new MockMultipartFile(
                        "file", "c.md", "text/markdown", "---\ntitle: x\u0001\n---\nBody\n".getBytes(UTF_8)));
        assertError(control, 400, "POST_IMPORT_INVALID_FILE");
        assertThat(message(control)).startsWith("File 1:").contains("line 2");
    }

    @Test
    void a_file_over_its_cap_and_files_over_the_total_cap_are_refused_with_413() throws Exception {
        byte[] big = new byte[PostFile.MAX_BYTES + 1];
        java.util.Arrays.fill(big, (byte) 'x');
        assertError(
                preview(
                        author,
                        markdown("ok.md", file("title: Ok " + token)),
                        new MockMultipartFile("file", "big.md", "text/markdown", big)),
                413,
                "VALIDATION_ERROR");

        // Seventeen files that are each under their cap are over the 4 MiB total.
        byte[] under = new byte[250_000];
        java.util.Arrays.fill(under, (byte) 'x');
        List<MockMultipartFile> files = new ArrayList<>();
        for (int i = 1; i <= 17; i++) {
            files.add(new MockMultipartFile("file", "f" + i + ".md", "text/markdown", under));
        }
        assertError(preview(author, files.toArray(MockMultipartFile[]::new)), 413, "VALIDATION_ERROR");
    }

    // --- Who may call it ------------------------------------------------------------------------------------

    @Test
    void admins_and_authors_may_preview_a_reader_gets_403_and_an_anonymous_caller_401_and_nothing_is_written()
            throws Exception {
        MockMultipartFile one = markdown("one.md", file("title: Roles " + token, "category: Role category " + token));
        Snapshot before = snapshot();

        assertThat(preview(admin, one).andReturn().getResponse().getStatus()).isEqualTo(200);
        assertThat(preview(author, one).andReturn().getResponse().getStatus()).isEqualTo(200);
        assertError(preview(reader, one), 403, "FORBIDDEN");
        assertError(preview(null, one), 401, "UNAUTHENTICATED");

        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void the_template_of_every_language_downloads_for_admins_and_authors_and_previews_without_problems()
            throws Exception {
        for (String language : languages.enabled()) {
            var result = mockMvc.perform(
                            get(BASE + "/template").param("language", language).header("Authorization", author))
                    .andExpect(status().isOk())
                    .andReturn();
            assertThat(result.getResponse().getContentType()).isEqualTo("text/markdown;charset=UTF-8");
            assertThat(result.getResponse().getHeader("Content-Disposition"))
                    .isEqualTo("attachment; filename=\"post-template-" + language + ".md\"");
            // The example slug is replaced so that a post another test made cannot take it.
            String template = result.getResponse()
                    .getContentAsString(UTF_8)
                    .replaceAll("(?m)^slug:.*$", "slug: template-" + language + "-" + token);
            assertThat(template).startsWith("---\n").contains("language: " + language);

            JsonNode file = firstFile(
                    preview(language.equals(otherLanguage) ? admin : author, markdown("template.md", template)));
            assertThat(file.path("state").asString()).as(language).isEqualTo("new");
            assertThat(file.path("problems").size()).as(language).isZero();
            assertThat(file.path("language").asString()).isEqualTo(language);
        }
        var defaulted = mockMvc.perform(get(BASE + "/template").header("Authorization", admin))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(defaulted.getResponse().getHeader("Content-Disposition"))
                .contains("post-template-" + defaultLanguage);
        assertError(
                mockMvc.perform(get(BASE + "/template").param("language", "zz").header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
        assertThat(mockMvc.perform(get(BASE + "/template").header("Authorization", reader))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(403);
        assertThat(mockMvc.perform(get(BASE + "/template"))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
    }

    // --- Rate limit -----------------------------------------------------------------------------------------

    @Test
    void every_preview_counts_against_the_post_import_limit_of_the_person() throws Exception {
        MockMultipartFile one = markdown("one.md", file("title: Limit " + token));
        int status = 200;
        int calls = 0;
        while (status == 200 && calls < 200) {
            status = preview(author, one).andReturn().getResponse().getStatus();
            calls++;
        }

        assertThat(calls).isGreaterThan(1);
        assertThat(status).isEqualTo(429);
        assertError(preview(author, one), 429, "RATE_LIMITED");
        // The limit is per person and a count of its own: another author still previews.
        assertThat(preview(otherAuthor, one).andReturn().getResponse().getStatus())
                .isEqualTo(200);
    }

    // --- Hygiene --------------------------------------------------------------------------------------------

    @Test
    void no_log_line_error_body_or_problem_message_contains_a_value_of_the_files() throws Exception {
        String marker = "Quokka-Marker-" + token;
        String text = file(
                "A body line with " + marker + "\n",
                "title: Title " + marker,
                "slug: slug-" + marker.toLowerCase(java.util.Locale.ROOT),
                "category: Category " + marker,
                "tags: Tag " + marker + ", other " + marker,
                "status: published",
                "key with " + marker + ": value",
                "language: zz-" + marker);
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Logger imports = (Logger) LoggerFactory.getLogger("com.blog.postimport");
        Level previous = imports.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        imports.setLevel(Level.DEBUG);
        List<String> bodies = new ArrayList<>();
        try {
            ResultActions refusedProblems = preview(author, markdown("name-" + marker + ".md", text));
            JsonNode data = data(refusedProblems.andExpect(status().isOk()));
            for (String part : List.of("problems", "notes", "ignored")) {
                assertThat(data.path("files").get(0).path(part).toString())
                        .doesNotContain(marker, marker.toLowerCase(java.util.Locale.ROOT));
            }
            assertThat(data.path("files").get(0).path("state").asString()).isEqualTo("error");

            bodies.add(responseBody(preview(
                    author,
                    new MockMultipartFile("file", "name-" + marker + ".txt", "text/plain", text.getBytes(UTF_8)))));
            // A control character in a body line: the refusal names the line (the sixth), never the text around it.
            String controlAnswer = responseBody(preview(
                    author,
                    new MockMultipartFile(
                            "file",
                            "name-" + marker + ".md",
                            "text/markdown",
                            ("---\ntitle: Title " + marker + "\n---\n\nFirst body line\nSecond " + marker
                                            + "\u0001 line\n")
                                    .getBytes(UTF_8))));
            assertThat(controlAnswer).contains("control character on line 6");
            bodies.add(controlAnswer);
            byte[] big = new byte[PostFile.MAX_BYTES + 1];
            java.util.Arrays.fill(big, (byte) 'x');
            bodies.add(responseBody(
                    preview(author, new MockMultipartFile("file", "name-" + marker + ".md", "text/markdown", big))));
            bodies.add(responseBody(preview(
                    author,
                    markdown("ok.md", file("title: Fine " + token, "slug: fine-" + token)),
                    markdown("a" + marker + ".md", ""))));
        } finally {
            root.detachAppender(logs);
            imports.setLevel(previous);
        }

        assertThat(logs.list)
                .anySatisfy(e -> assertThat(e.getFormattedMessage()).startsWith("post import previewed"));
        LogAssertions.assertNoValues(logs.list, marker, marker.toLowerCase(java.util.Locale.ROOT));
        for (String body : bodies) {
            assertThat(body).isNotEmpty().doesNotContain(marker, marker.toLowerCase(java.util.Locale.ROOT));
        }
    }

    // --- Helpers --------------------------------------------------------------------------------------------

    /** A row count of every table a preview must not touch. */
    private record Snapshot(Map<String, Integer> counts) {}

    private Snapshot snapshot() {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String table : List.of(
                "posts",
                "categories",
                "tags",
                "post_tags",
                "post_revisions",
                "post_slug_history",
                "search_outbox",
                "newsletter_issues",
                "post_import_log",
                "site_import_log")) {
            counts.put(table, jdbcTemplate.queryForObject("select count(*) from " + table, Integer.class));
        }
        return new Snapshot(counts);
    }

    /** A post file: the front matter lines, then a body; a first argument that ends with a line break is the body. */
    private static String file(String... frontMatter) {
        String body = BODY;
        int from = 0;
        if (frontMatter.length > 0 && frontMatter[0].endsWith("\n")) {
            body = frontMatter[0];
            from = 1;
        }
        return "---\n" + String.join("\n", List.of(frontMatter).subList(from, frontMatter.length)) + "\n---\n\n" + body;
    }

    private static MockMultipartFile markdown(String name, String text) {
        return new MockMultipartFile("file", name, "text/markdown", text.getBytes(UTF_8));
    }

    /** A file name with the test's token, so that a file without a slug key gets a slug no other test uses. */
    private String named(String stem) {
        return stem + "-" + token + ".md";
    }

    private MockMultipartHttpServletRequestBuilder multipartRequest() {
        return multipart(BASE + "/preview");
    }

    private ResultActions preview(String bearer, MockMultipartFile... files) throws Exception {
        MockMultipartHttpServletRequestBuilder request = multipartRequest();
        for (MockMultipartFile file : files) {
            request.file(file);
        }
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        return mockMvc.perform(request);
    }

    private JsonNode firstFile(ResultActions result) throws Exception {
        return data(result.andExpect(status().isOk())).path("files").get(0);
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper.readTree(responseBody(result)).path("data");
    }

    private static String responseBody(ResultActions result) throws Exception {
        return result.andReturn().getResponse().getContentAsString(UTF_8);
    }

    private String message(ResultActions result) throws Exception {
        return objectMapper
                .readTree(responseBody(result))
                .path("error")
                .path("message")
                .asString();
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        assertThat(objectMapper
                        .readTree(responseBody(result))
                        .path("error")
                        .path("code")
                        .asString())
                .isEqualTo(code);
    }

    private static List<String> codes(JsonNode file) {
        List<String> codes = new ArrayList<>();
        file.path("notes").forEach(note -> codes.add(note.path("code").asString()));
        return codes;
    }

    private String tags(String prefix, int count) {
        List<String> names = new ArrayList<>();
        for (int i = 1; i <= count; i++) {
            names.add(prefix + i + "-" + token);
        }
        return String.join(", ", names);
    }

    private UUID createPost(String bearer, String title, String slug) throws Exception {
        Map<String, Object> body = Map.of("title", title, "content", "Fixture body.", "slug", slug);
        JsonNode created = objectMapper.readTree(responseBody(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated())));
        return UUID.fromString(created.path("data").path("id").asString());
    }

    private void createCategory(String name, Map<String, Object> translations) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("translations", translations);
        mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated());
    }

    private void createTag(String name, Map<String, Object> translations) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("translations", translations);
        mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated());
    }
}
