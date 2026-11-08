package com.blog.siteimport;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doCallRealMethod;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.i18n.Languages;
import com.blog.sitecontent.repository.SiteContentRepository;
import com.blog.siteimport.format.ProfileFile;
import com.blog.siteimport.format.SectionDescriptor;
import com.blog.siteimport.format.SectionRegistry;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.UserRole;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.AbstractMockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The Markdown profile import through the HTTP API: template and export, preview (writes nothing), apply (hash-checked,
 * all or nothing, only the selected sections, omitted fields kept), undo (exact, refuses after a later change), status,
 * serialization of concurrent imports, authorization and the rule that no log holds file content.
 *
 * Like SiteContentIT, every test starts from and leaves behind empty site content, revision and import log tables, and
 * uses a fresh ADMIN account so it has its own write rate-limit bucket. {@link SiteContentRepository} is a spy so one
 * test can make the second write fail; every other test runs the real methods.
 */
@AutoConfigureMockMvc
class SiteImportIT extends AbstractIntegrationTest {

    private static final String BASE = "/api/v1/admin/site-import";
    private static final String CONTENT = "/api/v1/admin/site-content";

    private static final List<String> ALL_SECTIONS =
            SectionRegistry.sections().stream().map(SectionDescriptor::id).toList();

    /** The body of a complete file in neutral example data; the front matter adds five lines before it. */
    private static final String FULL = """
        # Site
        - name: Example Site
        - tagline: Notes on building software
        - positioning: A personal site with articles.

        # Identity
        - name: Alex Example
        - role: Software engineer
        - location: Example City
        - greeting: Hello, I am Alex.
        - headline: I build web applications.
        - subline: Articles about the backend and the frontend.

        # Career goals
        Looking for a team that values testing.

        # About
        An introduction paragraph.

        ## Who I am {#who}
        First paragraph.

        Second paragraph.

        # Skills
        ## Backend {#backend level=used-in-project}
        - Java
        - Docker | worked-with
        - Kubernetes | learning | Reading the docs

        # Now
        - last_updated: 2026-10-01
        - intro: What I do now.

        ## Items
        - Writing a post.
        - Reading | All posts | /writing

        # Timeline
        - experience_summary: Some years of work.

        ## Entries
        - experience | Engineer | Example Org | 2020 - 2024 | Built things.
        - education | Degree

        # Contact
        - email: someone@example.com
        - github: https://github.com/example
        - blurb: Write to me.

        ## Social links
        - Mastodon | https://example.social/@someone

        # Blogroll
        - Example Blog | https://blog.example.com | Good notes

        # About page
        A short page body.

        ## What this page covers
        Notes and articles.
        """;

    /** An About page body with a block, a fence that holds a hash line, a table and a nested list. */
    private static final String ABOUT_BODY = """
        Opening paragraph.

        ## What I do

        :::callout{type="tip" title="Note"}
        Inside a block.
        :::

        ```bash
        # a comment line, not a heading
        echo done
        ```

        | Name | Value |
        |---|---|
        | a | b |

        - one
          - nested
        - two
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

    @MockitoSpyBean
    private SiteContentRepository contentRepository;

    private String admin;
    private String author;
    private String locale;
    private String otherLocale;

    @BeforeEach
    void setUp() {
        wipe();
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        admin = auth.bearerFor(auth.createAccount("site-import-admin-" + suffix + "@blog.local", UserRole.ADMIN));
        author = auth.bearerFor(auth.createAuthor("site-import-author-" + suffix + "@blog.local"));
        locale = languages.defaultLocale();
        otherLocale = languages.enabled().stream()
                .filter(l -> !l.equals(locale))
                .findFirst()
                .orElseThrow();
    }

    @AfterEach
    void cleanUp() {
        wipe();
    }

    private void wipe() {
        jdbcTemplate.update("delete from site_import_log");
        jdbcTemplate.update("delete from site_content_revision");
        jdbcTemplate.update("delete from site_content");
    }

    // --- Downloads -----------------------------------------------------------------------------------------

    @Test
    void the_template_of_every_enabled_locale_downloads_as_markdown_and_previews_without_problems() throws Exception {
        for (String language : languages.enabled()) {
            MvcResult result = mockMvc.perform(
                            get(BASE + "/template").param("locale", language).header("Authorization", admin))
                    .andExpect(status().isOk())
                    .andReturn();
            assertThat(result.getResponse().getContentType()).isEqualTo("text/markdown;charset=UTF-8");
            assertThat(result.getResponse().getHeader("Content-Disposition"))
                    .isEqualTo("attachment; filename=\"site-profile-template.md\"");
            String template = result.getResponse().getContentAsString(UTF_8);
            assertThat(template).startsWith("---\n").contains("locale: " + language);

            JsonNode preview = data(preview(template).andExpect(status().isOk()));
            assertThat(preview.path("errors").size()).isZero();
            assertThat(preview.path("locale").asString()).isEqualTo(language);
            for (JsonNode section : preview.path("sections")) {
                assertThat(section.path("status").asString())
                        .as(section.path("id").asString())
                        .isEqualTo("new");
            }
        }
        assertError(
                mockMvc.perform(get(BASE + "/template").param("locale", "xx").header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
        assertError(mockMvc.perform(get(BASE + "/template").header("Authorization", admin)), 400, "VALIDATION_ERROR");
    }

    // --- The whole journey ---------------------------------------------------------------------------------

    @Test
    void preview_apply_status_export_and_undo_of_a_complete_file() throws Exception {
        String text = file(FULL);

        JsonNode preview = data(preview(text).andExpect(status().isOk()));
        assertThat(preview.path("sha256").asString()).isEqualTo(sha(text));
        assertThat(preview.path("bytes").asLong()).isEqualTo(text.getBytes(UTF_8).length);
        assertThat(preview.path("schemaVersion").asString()).isEqualTo("1");
        assertThat(preview.path("contentType").asString()).isEqualTo("site-profile");
        assertThat(preview.path("locale").asString()).isEqualTo(locale);
        assertThat(preview.path("willWriteTo").asString()).isEqualTo(locale);
        assertThat(preview.path("errors").size()).isZero();
        assertThat(ids(preview.path("sections"))).containsExactlyElementsOf(ALL_SECTIONS);
        for (JsonNode section : preview.path("sections")) {
            assertThat(section.path("status").asString())
                    .as(section.path("id").asString())
                    .isEqualTo("new");
            assertThat(section.path("selectable").asBoolean()).isTrue();
            assertThat(section.path("present").asBoolean()).isTrue();
        }
        assertThat(section(preview, "identity").path("missingOptional").get(0).asString())
                .isEqualTo("gallery_lead");

        JsonNode applied = data(apply(text, "update", ALL_SECTIONS).andExpect(status().isOk()));
        long importId = applied.path("importId").asLong();
        assertThat(importId).isPositive();
        assertThat(applied.path("locale").asString()).isEqualTo(locale);
        assertThat(applied.path("mode").asString()).isEqualTo("update");
        assertThat(statuses(applied.path("sections"), "id")).allMatch(s -> s.endsWith(":created"));
        assertThat(rowCount()).isEqualTo(8);
        assertThat(stored("profile", locale).path("seeking").asString())
                .isEqualTo("Looking for a team that values testing.");
        assertThat(stored("skills", locale).path("groups").get(0).path("items").size())
                .isEqualTo(3);

        JsonNode status = data(statusCall().andExpect(status().isOk())).path("lastImport");
        assertThat(status.path("id").asLong()).isEqualTo(importId);
        assertThat(status.path("locale").asString()).isEqualTo(locale);
        assertThat(status.path("mode").asString()).isEqualTo("update");
        assertThat(status.path("undone").asBoolean()).isFalse();
        assertThat(status.path("undoable").asBoolean()).isTrue();
        assertThat(status.path("createdAt").asString()).isNotBlank();
        assertThat(statuses(status.path("sections"), "key")).hasSize(8).allMatch(s -> s.endsWith(":created"));

        MvcResult export = mockMvc.perform(
                        get(BASE + "/export").param("locale", locale).header("Authorization", admin))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(export.getResponse().getContentType()).isEqualTo("text/markdown;charset=UTF-8");
        assertThat(export.getResponse().getHeader("Content-Disposition"))
                .isEqualTo("attachment; filename=\"site-profile-" + locale + ".md\"");
        assertThat(export.getResponse().getContentAsString(UTF_8))
                .contains("# Site", "- name: Example Site", "locale: " + locale);

        JsonNode undone = data(undo(importId).andExpect(status().isOk()));
        assertThat(undone.path("importId").asLong()).isEqualTo(importId);
        assertThat(undone.path("locale").asString()).isEqualTo(locale);
        assertThat(statuses(undone.path("sections"), "key")).hasSize(8).allMatch(s -> s.endsWith(":removed"));
        assertThat(rowCount()).isZero();

        JsonNode after = data(statusCall().andExpect(status().isOk())).path("lastImport");
        assertThat(after.path("undone").asBoolean()).isTrue();
        assertThat(after.path("undoable").asBoolean()).isFalse();
        assertError(undo(importId), 404, "SITE_IMPORT_NOTHING_TO_UNDO");
    }

    @Test
    void the_status_of_a_site_that_never_imported_is_empty() throws Exception {
        JsonNode status = data(statusCall().andExpect(status().isOk()));

        assertThat(status.has("lastImport")).isTrue();
        assertThat(status.path("lastImport").isNull()).isTrue();
        assertError(undo(1), 404, "SITE_IMPORT_NOTHING_TO_UNDO");
    }

    // --- Preview -------------------------------------------------------------------------------------------

    @Test
    void a_preview_writes_nothing() throws Exception {
        putOk("site", locale, site("Stored Site", "Stored tagline"));
        putOk("site", locale, site("Stored Site", "Second tagline"));
        Snapshot before = snapshot();

        JsonNode preview = data(preview(file(FULL)).andExpect(status().isOk()));

        assertThat(section(preview, "site").path("status").asString()).isEqualTo("will_change");
        assertThat(snapshot()).isEqualTo(before);
        assertThat(data(statusCall()).path("lastImport").isNull()).isTrue();
    }

    @Test
    void a_preview_reports_value_changes_list_counts_and_unchanged_sections() throws Exception {
        putOk("site", locale, site("Stored Site", "Same tagline"));
        putOk(
                "blogroll",
                locale,
                "{\"entries\":[{\"name\":\"Kept Blog\",\"url\":\"https://kept.example.com\"},"
                        + "{\"name\":\"Gone Blog\",\"url\":\"https://gone.example.com\"}]}");
        String text = file("""
            # Site
            - name: New Site
            - tagline: Same tagline

            # Blogroll
            - Kept Blog | https://kept.example.com
            - New Blog | https://new.example.com
            """);

        JsonNode preview = data(preview(text).andExpect(status().isOk()));

        JsonNode site = section(preview, "site");
        assertThat(site.path("status").asString()).isEqualTo("will_change");
        assertThat(site.path("changes").size()).isEqualTo(1);
        JsonNode change = site.path("changes").get(0);
        assertThat(change.path("field").asString()).isEqualTo("name");
        assertThat(change.path("kind").asString()).isEqualTo("value");
        assertThat(change.path("before").asString()).isEqualTo("Stored Site");
        assertThat(change.path("after").asString()).isEqualTo("New Site");
        assertThat(site.path("missingOptional").get(0).asString()).isEqualTo("positioning");

        JsonNode list = section(preview, "blogroll").path("changes").get(0);
        assertThat(list.path("kind").asString()).isEqualTo("list");
        assertThat(list.path("added").asInt()).isEqualTo(1);
        assertThat(list.path("removed").asInt()).isEqualTo(1);
        assertThat(list.path("kept").asInt()).isEqualTo(1);

        JsonNode missing = section(preview, "identity");
        assertThat(missing.path("present").asBoolean()).isFalse();
        assertThat(missing.path("status").asString()).isEqualTo("missing");
        assertThat(missing.path("selectable").asBoolean()).isFalse();

        String same = file("# Site\n- name: Stored Site\n- tagline: Same tagline\n");
        JsonNode unchanged = section(data(preview(same).andExpect(status().isOk())), "site");
        assertThat(unchanged.path("status").asString()).isEqualTo("unchanged");
        assertThat(unchanged.path("changes").size()).isZero();
    }

    // --- Apply ---------------------------------------------------------------------------------------------

    @Test
    void a_file_that_is_not_the_previewed_one_is_refused_with_409() throws Exception {
        String text = file(FULL);
        MockMultipartFile upload = markdown(text);

        assertError(
                mockMvc.perform(multipart(BASE + "/apply")
                        .file(upload)
                        .param("sha256", sha(text + "\n"))
                        .param("mode", "update")
                        .param("sections", "site")
                        .header("Authorization", admin)),
                409,
                "SITE_IMPORT_HASH_MISMATCH");
        assertThat(rowCount()).isZero();
        assertThat(logCount()).isZero();
    }

    @Test
    void apply_checks_mode_sections_and_the_file() throws Exception {
        String text = file(FULL);

        assertError(apply(text, "replace", List.of("site")), 400, "VALIDATION_ERROR");
        assertError(apply(text, "update", List.of()), 400, "VALIDATION_ERROR");
        assertError(apply(text, "update", List.of("projects")), 400, "VALIDATION_ERROR");
        assertError(apply(file("# Site\n- name: Only Site\n"), "update", List.of("blogroll")), 400, "VALIDATION_ERROR");
        assertError(
                mockMvc.perform(multipart(BASE + "/preview")
                        .file(new MockMultipartFile("file", "profile.txt", "text/plain", text.getBytes(UTF_8)))
                        .header("Authorization", admin)),
                400,
                "SITE_IMPORT_INVALID_FILE");
        assertError(
                mockMvc.perform(multipart(BASE + "/preview")
                        .file(new MockMultipartFile("file", "profile.md", "text/markdown", new byte[] {0x50, 0, 0x4b}))
                        .header("Authorization", admin)),
                400,
                "SITE_IMPORT_INVALID_FILE");
        byte[] large = new byte[ProfileFile.MAX_BYTES + 1];
        Arrays.fill(large, (byte) 'a');
        assertError(
                mockMvc.perform(multipart(BASE + "/preview")
                        .file(new MockMultipartFile("file", "profile.md", "text/markdown", large))
                        .header("Authorization", admin)),
                413,
                "VALIDATION_ERROR");
        assertError(
                mockMvc.perform(multipart(BASE + "/preview").header("Authorization", admin)),
                400,
                "SITE_IMPORT_INVALID_FILE");
        assertThat(rowCount()).isZero();
        assertThat(logCount()).isZero();
    }

    @Test
    void create_only_never_overwrites_a_stored_section() throws Exception {
        putOk("site", locale, site("Stored Site", "Stored tagline"));
        JsonNode stored = stored("site", locale);

        JsonNode applied = data(
                apply(file(FULL), "create-only", List.of("site", "blogroll")).andExpect(status().isOk()));

        assertThat(statuses(applied.path("sections"), "id")).containsExactly("site:skipped", "blogroll:created");
        assertThat(applied.path("importId").isNull()).isFalse();
        assertThat(stored("site", locale)).isEqualTo(stored);
        assertThat(revisionCount("site")).isZero();
        assertThat(stored("blogroll", locale).path("entries").size()).isEqualTo(1);
    }

    @Test
    void update_writes_only_the_selected_sections_and_keeps_what_the_file_leaves_out_or_empty() throws Exception {
        putOk(
                "site",
                locale,
                "{\"name\":\"Stored Site\",\"tagline\":\"Stored tagline\",\"positioning\":\"Stored text\"}");
        String text = file("""
            # Site
            - name: New Site
            - tagline:

            # Blogroll
            - Example Blog | https://blog.example.com
            """);

        JsonNode applied = data(apply(text, "update", List.of("site")).andExpect(status().isOk()));

        assertThat(statuses(applied.path("sections"), "id")).containsExactly("site:updated");
        JsonNode site = stored("site", locale);
        assertThat(site.path("name").asString()).isEqualTo("New Site");
        assertThat(site.path("tagline").asString()).isEqualTo("Stored tagline");
        assertThat(site.path("positioning").asString()).isEqualTo("Stored text");
        assertThat(stored("blogroll", locale)).isNull();
        assertThat(revisionCount("site")).isEqualTo(1);
    }

    @Test
    void rows_replace_the_whole_list_and_the_log_counts_the_items() throws Exception {
        putOk(
                "blogroll",
                locale,
                "{\"entries\":[{\"name\":\"Kept Blog\",\"url\":\"https://kept.example.com\"},"
                        + "{\"name\":\"Gone Blog\",\"url\":\"https://gone.example.com\"}]}");
        String text = file("""
            # Blogroll
            - Kept Blog | https://kept.example.com
            - New Blog | https://new.example.com | A note
            """);

        data(apply(text, "update", List.of("blogroll")).andExpect(status().isOk()));

        JsonNode entries = stored("blogroll", locale).path("entries");
        assertThat(entries.size()).isEqualTo(2);
        assertThat(entries.get(0).path("name").asString()).isEqualTo("Kept Blog");
        assertThat(entries.get(1).path("name").asString()).isEqualTo("New Blog");
        assertThat(entries.get(1).path("note").asString()).isEqualTo("A note");
        JsonNode logged = loggedSections().get(0);
        assertThat(logged.path("key").asString()).isEqualTo("blogroll");
        assertThat(logged.path("status").asString()).isEqualTo("updated");
        assertThat(logged.path("added").asInt()).isEqualTo(1);
        assertThat(logged.path("removed").asInt()).isEqualTo(1);
        assertThat(logged.path("kept").asInt()).isEqualTo(1);
    }

    @Test
    void career_goals_without_a_saved_profile_needs_the_identity_section() throws Exception {
        String alone = file("# Career goals\nLooking for a team that values testing.\n");

        JsonNode preview = data(preview(alone).andExpect(status().isOk()));
        JsonNode goals = section(preview, "career-goals");
        assertThat(goals.path("status").asString()).isEqualTo("error");
        assertThat(goals.path("selectable").asBoolean()).isFalse();
        JsonNode error = goals.path("errors").get(0);
        assertThat(error.path("line").asInt()).isEqualTo(6);
        assertThat(error.path("message").asString()).contains("no saved profile", "(identity)");

        ResultActions rejected = apply(alone, "update", List.of("career-goals"));
        assertError(rejected, 400, "SITE_IMPORT_INVALID");
        assertThat(message(rejected)).startsWith("Career goals line 6: ").contains("identity");

        // With Identity in the same file both are new, and applying both works; Career goals alone still does not.
        String both = file(FULL);
        JsonNode together = data(preview(both).andExpect(status().isOk()));
        assertThat(section(together, "career-goals").path("status").asString()).isEqualTo("new");
        assertError(apply(both, "update", List.of("career-goals")), 400, "SITE_IMPORT_INVALID");
        assertThat(rowCount()).isZero();
        data(apply(both, "update", List.of("identity", "career-goals")).andExpect(status().isOk()));
        assertThat(stored("profile", locale).path("seeking").asString())
                .isEqualTo("Looking for a team that values testing.");
    }

    @Test
    void a_clean_section_is_not_blamed_for_the_errors_of_a_sibling_in_the_same_file() throws Exception {
        String text = file("# Identity\n- name: Alex Example\n- greeting: Hello.\n- headline: " + "x".repeat(201)
                + "\n\n# Career goals\nLooking for a team that values testing.\n");

        JsonNode preview = data(preview(text).andExpect(status().isOk()));

        JsonNode identity = section(preview, "identity");
        assertThat(identity.path("status").asString()).isEqualTo("error");
        assertThat(identity.path("errors").get(0).path("field").asString()).isEqualTo("headline");
        JsonNode goals = section(preview, "career-goals");
        assertThat(goals.path("errors").size()).isZero();
        assertThat(goals.path("status").asString()).isEqualTo("new");
    }

    @Test
    void a_failure_in_the_middle_of_an_apply_leaves_every_table_unchanged() throws Exception {
        putOk("site", locale, site("Stored Site", "Stored tagline"));
        Snapshot before = snapshot();
        doCallRealMethod()
                .doThrow(new DataAccessResourceFailureException("simulated failure"))
                .when(contentRepository)
                .upsert(anyString(), anyString(), anyInt(), anyString(), any());

        int status = apply(file(FULL), "update", ALL_SECTIONS)
                .andReturn()
                .getResponse()
                .getStatus();

        assertThat(status).isGreaterThanOrEqualTo(500);
        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void importing_the_same_file_twice_changes_nothing_the_second_time() throws Exception {
        String text = file(FULL);
        data(apply(text, "update", ALL_SECTIONS).andExpect(status().isOk()));
        Snapshot first = snapshot();

        JsonNode second = data(apply(text, "update", ALL_SECTIONS).andExpect(status().isOk()));

        assertThat(second.path("importId").isNull()).isTrue();
        assertThat(statuses(second.path("sections"), "id")).allMatch(s -> s.endsWith(":unchanged"));
        assertThat(snapshot()).isEqualTo(first);
        assertThat(logCount()).isEqualTo(1);
    }

    @Test
    void an_export_previews_back_as_unchanged() throws Exception {
        data(apply(file(FULL), "update", ALL_SECTIONS).andExpect(status().isOk()));
        String exported = mockMvc.perform(
                        get(BASE + "/export").param("locale", locale).header("Authorization", admin))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString(UTF_8);

        JsonNode preview = data(preview(exported).andExpect(status().isOk()));

        assertThat(preview.path("errors").size()).isZero();
        assertThat(preview.path("ignoredTotal").asInt()).isZero();
        for (JsonNode section : preview.path("sections")) {
            assertThat(section.path("status").asString())
                    .as(section.path("id").asString())
                    .isEqualTo("unchanged");
        }
    }

    @Test
    void the_locale_of_the_file_decides_the_target_and_a_disabled_locale_is_a_file_error() throws Exception {
        String other = file(otherLocale, "# Site\n- name: Other Site\n");
        data(apply(other, "update", List.of("site")).andExpect(status().isOk()));
        assertThat(stored("site", otherLocale).path("name").asString()).isEqualTo("Other Site");
        assertThat(stored("site", locale)).isNull();

        String disabled = file("xx", "# Site\n- name: Other Site\n");
        JsonNode preview = data(preview(disabled).andExpect(status().isOk()));
        assertThat(preview.path("locale").isNull()).isTrue();
        assertThat(preview.path("willWriteTo").isNull()).isTrue();
        JsonNode error = preview.path("errors").get(0);
        assertThat(error.path("field").asString()).isEqualTo("locale");
        assertThat(error.path("line").asInt()).isEqualTo(4);
        assertError(apply(disabled, "update", List.of("site")), 400, "SITE_IMPORT_INVALID");
        assertThat(rowCount()).isEqualTo(1);
    }

    @Test
    void unsafe_urls_are_rejected_with_their_line_and_without_their_value() throws Exception {
        String text = file("""
            # Blogroll
            - Script | javascript:alert(1)
            - Data | data:text/html,hello
            - Plain | http://example.com
            """);

        JsonNode blogroll = section(data(preview(text).andExpect(status().isOk())), "blogroll");

        assertThat(blogroll.path("status").asString()).isEqualTo("error");
        List<Integer> lines = new ArrayList<>();
        for (JsonNode error : blogroll.path("errors")) {
            assertThat(error.path("field").asString()).isEqualTo("url");
            assertThat(error.path("message").asString()).doesNotContain("javascript", "data:", "http:");
            lines.add(error.path("line").asInt());
        }
        assertThat(lines).containsExactly(7, 8, 9);
        ResultActions rejected = apply(text, "update", List.of("blogroll"));
        assertError(rejected, 400, "SITE_IMPORT_INVALID");
        assertThat(message(rejected)).startsWith("Blogroll line 7 url: ").doesNotContain("javascript");
        assertThat(rowCount()).isZero();
    }

    @Test
    void html_and_script_text_is_stored_as_typed_text() throws Exception {
        String name = "<b>Bold</b> & <script>alert(1)</script>";

        data(apply(file("# Site\n- name: " + name + "\n"), "update", List.of("site"))
                .andExpect(status().isOk()));

        assertThat(stored("site", locale).path("name").asString()).isEqualTo(name);
    }

    // --- Undo ----------------------------------------------------------------------------------------------

    @Test
    void undo_restores_the_replaced_version_and_removes_what_the_import_created() throws Exception {
        putOk("site", locale, site("Stored Site", "Stored tagline"));
        JsonNode original = stored("site", locale);
        long importId = importId(apply(file(FULL), "update", List.of("site", "blogroll")));
        assertThat(stored("site", locale).path("name").asString()).isEqualTo("Example Site");

        JsonNode undone = data(undo(importId).andExpect(status().isOk()));

        assertThat(statuses(undone.path("sections"), "key")).containsExactly("site:restored", "blogroll:removed");
        assertThat(stored("site", locale)).isEqualTo(original);
        assertThat(stored("blogroll", locale)).isNull();
        // The undo is recoverable: the imported versions are kept as revisions.
        assertThat(revisionCount("site")).isEqualTo(2);
        assertThat(revisionCount("blogroll")).isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from site_import_log where undone_at is not null and undone_by is not null",
                        Integer.class))
                .isEqualTo(1);
    }

    @Test
    void undo_refuses_when_a_section_was_changed_after_the_import() throws Exception {
        long importId = importId(apply(file(FULL), "update", List.of("site")));
        putOk("site", locale, site("Manual Site", ""));

        assertThat(data(statusCall()).path("lastImport").path("undoable").asBoolean())
                .isFalse();
        ResultActions refused = undo(importId);

        assertError(refused, 409, "SITE_IMPORT_UNDO_CONFLICT");
        assertThat(message(refused)).contains("site");
        assertThat(stored("site", locale).path("name").asString()).isEqualTo("Manual Site");
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from site_import_log where undone_at is null", Integer.class))
                .isEqualTo(1);
    }

    @Test
    void undo_names_its_import_and_a_stale_or_missing_id_changes_nothing() throws Exception {
        long first = importId(apply(file("# Site\n- name: First Site\n"), "update", List.of("site")));
        long second = importId(apply(file("# Site\n- name: Second Site\n"), "update", List.of("site")));
        Snapshot before = snapshot();

        // Regression: a page that still shows the first import must not undo the second one.
        ResultActions stale = undo(first);
        assertError(stale, 409, "SITE_IMPORT_UNDO_CONFLICT");
        assertThat(message(stale)).isEqualTo("A newer import exists; reload the page");
        assertError(mockMvc.perform(post(BASE + "/undo").header("Authorization", admin)), 400, "VALIDATION_ERROR");
        assertError(
                mockMvc.perform(post(BASE + "/undo").param("importId", "latest").header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");
        assertThat(snapshot()).isEqualTo(before);
        assertThat(undoneCount()).isZero();

        JsonNode undone = data(undo(second).andExpect(status().isOk()));
        assertThat(undone.path("importId").asLong()).isEqualTo(second);
        assertThat(stored("site", locale).path("name").asString()).isEqualTo("First Site");
        assertThat(undoneCount()).isEqualTo(1);
    }

    @Test
    void undo_says_so_when_the_previous_version_is_no_longer_kept() throws Exception {
        putOk("site", locale, site("Stored Site", "Stored tagline"));
        long importId = importId(apply(file(FULL), "update", List.of("site")));
        jdbcTemplate.update("delete from site_content_revision where key = 'site' and locale = ?", locale);

        assertThat(data(statusCall()).path("lastImport").path("undoable").asBoolean())
                .isFalse();
        ResultActions refused = undo(importId);

        assertError(refused, 409, "SITE_IMPORT_UNDO_CONFLICT");
        assertThat(message(refused)).isEqualTo("The previous version of site is no longer kept");
        assertThat(stored("site", locale).path("name").asString()).isEqualTo("Example Site");
        assertThat(undoneCount()).isZero();
    }

    // --- Concurrency ---------------------------------------------------------------------------------------

    @Test
    void concurrent_imports_are_serialized() throws Exception {
        putOk("site", locale, site("Initial", ""));
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<Future<Integer>> results = new ArrayList<>();
            for (String name : List.of("Writer A", "Writer B")) {
                Callable<Integer> write = () -> {
                    start.await();
                    return apply(file("# Site\n- name: " + name + "\n"), "update", List.of("site"))
                            .andReturn()
                            .getResponse()
                            .getStatus();
                };
                results.add(pool.submit(write));
            }
            start.countDown();
            for (Future<Integer> result : results) {
                assertThat(result.get(30, TimeUnit.SECONDS)).isEqualTo(200);
            }
        } finally {
            pool.shutdownNow();
        }

        String last = stored("site", locale).path("name").asString();
        assertThat(last).isIn("Writer A", "Writer B");
        List<JsonNode> logs =
                jdbcTemplate
                        .queryForList("select cast(sections as text) from site_import_log order by id", String.class)
                        .stream()
                        .map(text -> objectMapper.readTree(text).get(0))
                        .toList();
        assertThat(logs).hasSize(2);
        // Serial order: the first import replaced "Initial", the second replaced what the first wrote.
        assertThat(revisionName(logs.get(0).path("previousRevisionId").asLong()))
                .isEqualTo("Initial");
        assertThat(revisionName(logs.get(1).path("previousRevisionId").asLong()))
                .isEqualTo(last.equals("Writer A") ? "Writer B" : "Writer A");
        assertThat(data(statusCall()).path("lastImport").path("undoable").asBoolean())
                .isTrue();
    }

    // --- Authorization, rate limit, logs -------------------------------------------------------------------

    @Test
    void only_an_admin_can_use_the_import() throws Exception {
        MockMultipartFile upload = markdown(file(FULL));
        for (String token : new String[] {author, null}) {
            int expected = token == null ? 401 : 403;
            assertThat(send(get(BASE + "/template").param("locale", locale), token))
                    .isEqualTo(expected);
            assertThat(send(get(BASE + "/export").param("locale", locale), token))
                    .isEqualTo(expected);
            assertThat(send(multipart(BASE + "/preview").file(upload), token)).isEqualTo(expected);
            assertThat(send(
                            multipart(BASE + "/apply")
                                    .file(upload)
                                    .param("sha256", sha(file(FULL)))
                                    .param("mode", "update")
                                    .param("sections", "site"),
                            token))
                    .isEqualTo(expected);
            assertThat(send(post(BASE + "/undo").param("importId", "1"), token)).isEqualTo(expected);
            assertThat(send(get(BASE + "/status"), token)).isEqualTo(expected);
        }
        assertThat(rowCount()).isZero();
        assertThat(logCount()).isZero();
    }

    @Test
    void previews_and_applies_share_the_site_content_write_limit() throws Exception {
        String text = file("# Site\n- name: Example Site\n");
        int status = 200;
        int calls = 0;
        while (status == 200 && calls < 200) {
            status = preview(text).andReturn().getResponse().getStatus();
            calls++;
        }

        assertThat(calls).isGreaterThan(1);
        assertThat(status).isEqualTo(429);
        assertError(preview(text), 429, "RATE_LIMITED");
        assertError(apply(text, "update", List.of("site")), 429, "RATE_LIMITED");
        assertError(undo(1), 429, "RATE_LIMITED");
        assertThat(rowCount()).isZero();
    }

    @Test
    void no_log_line_and_no_import_log_row_contains_a_value_of_the_file() throws Exception {
        String marker = "Quokka Marker 7731";
        String text = file(FULL.replace("Example Site", marker).replace("Example City", marker + " City"));
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Logger imports = (Logger) LoggerFactory.getLogger("com.blog.siteimport");
        Level previous = imports.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        imports.setLevel(Level.DEBUG);
        try {
            data(preview(text).andExpect(status().isOk()));
            long importId = importId(apply(text, "update", ALL_SECTIONS));
            data(undo(importId).andExpect(status().isOk()));
        } finally {
            root.detachAppender(logs);
            imports.setLevel(previous);
        }

        assertThat(logs.list)
                .anySatisfy(e -> assertThat(e.getFormattedMessage()).startsWith("site import applied"));
        for (ILoggingEvent event : logs.list) {
            assertThat(event.getFormattedMessage()).doesNotContain(marker, "Alex Example", "# Site");
        }
        for (JsonNode section : loggedSections()) {
            assertThat(fieldNames(section))
                    .isSubsetOf(Set.of("key", "status", "previousRevisionId", "afterHash", "added", "removed", "kept"));
        }
        assertThat(jdbcTemplate.queryForObject("select cast(sections as text) from site_import_log", String.class))
                .doesNotContain(marker, "Alex Example");
    }

    // --- About page body -----------------------------------------------------------------------------------

    private String aboutPageFile(String body) {
        return file("# About\nAn introduction paragraph.\n\n# About page\n" + body);
    }

    @Test
    void an_about_page_body_is_stored_as_text_previewed_changed_and_undone() throws Exception {
        String text = aboutPageFile(ABOUT_BODY);
        JsonNode first = data(preview(text).andExpect(status().isOk()));
        assertThat(first.path("errors").size()).isZero();
        assertThat(section(first, "about-page").path("status").asString()).isEqualTo("new");

        long firstImport = importId(apply(text, "update", List.of("about", "about-page")));

        JsonNode about = stored("about", locale);
        assertThat(about.path("intro").asString()).isEqualTo("An introduction paragraph.");
        assertThat(about.path("body").asString()).isEqualTo(ABOUT_BODY.strip());
        JsonNode unchanged = section(data(preview(text).andExpect(status().isOk())), "about-page");
        assertThat(unchanged.path("status").asString()).isEqualTo("unchanged");

        String changedText = text.replace("Opening paragraph.", "A different paragraph.");
        JsonNode changed = section(data(preview(changedText).andExpect(status().isOk())), "about-page");
        assertThat(changed.path("status").asString()).isEqualTo("will_change");
        JsonNode change = changed.path("changes").get(0);
        assertThat(change.path("field").asString()).isEqualTo("body");
        assertThat(change.path("before").isNull()).isTrue();
        assertThat(change.path("after").isNull()).isTrue();
        assertThat(change.path("added").asInt()).isEqualTo(1);
        assertThat(change.path("removed").asInt()).isEqualTo(1);
        assertThat(change.path("kept").asInt()).isPositive();
        assertThat(changed.toString()).doesNotContain("different paragraph", "echo done");

        long secondImport = importId(apply(changedText, "update", List.of("about-page")));
        assertThat(stored("about", locale).path("body").asString()).startsWith("A different paragraph.");
        assertThat(stored("about", locale).path("intro").asString()).isEqualTo("An introduction paragraph.");

        data(undo(secondImport).andExpect(status().isOk()));
        assertThat(stored("about", locale).path("body").asString()).isEqualTo(ABOUT_BODY.strip());
        assertThat(firstImport).isLessThan(secondImport);
    }

    @Test
    void a_file_without_an_about_page_section_never_removes_a_stored_body() throws Exception {
        data(apply(aboutPageFile(ABOUT_BODY), "update", List.of("about", "about-page"))
                .andExpect(status().isOk()));

        data(apply(file("# About\nA new introduction.\n"), "update", List.of("about"))
                .andExpect(status().isOk()));

        assertThat(stored("about", locale).path("intro").asString()).isEqualTo("A new introduction.");
        assertThat(stored("about", locale).path("body").asString()).isEqualTo(ABOUT_BODY.strip());
    }

    @Test
    void an_export_of_a_stored_body_previews_back_as_unchanged_and_carries_the_body_verbatim() throws Exception {
        data(apply(aboutPageFile(ABOUT_BODY), "update", List.of("about", "about-page"))
                .andExpect(status().isOk()));
        String exported = mockMvc.perform(
                        get(BASE + "/export").param("locale", locale).header("Authorization", admin))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString(UTF_8);

        JsonNode preview = data(preview(exported).andExpect(status().isOk()));

        assertThat(exported).contains("# About page\n\n" + ABOUT_BODY.strip());
        assertThat(preview.path("errors").size()).isZero();
        assertThat(section(preview, "about-page").path("status").asString()).isEqualTo("unchanged");
        assertThat(section(preview, "about").path("status").asString()).isEqualTo("unchanged");
    }

    @Test
    void an_about_page_body_over_the_limit_and_a_repeated_section_are_problems_without_the_text() throws Exception {
        String tooLong = aboutPageFile(("Confidential sentence number one.\n").repeat(700));
        String twice = file("# About\nIntro.\n\n# About page\nFirst.\n\n# About page\nSecond.\n");

        JsonNode longPreview = data(preview(tooLong).andExpect(status().isOk()));
        JsonNode twicePreview = data(preview(twice).andExpect(status().isOk()));

        JsonNode longPage = section(longPreview, "about-page");
        assertThat(longPage.path("status").asString()).isEqualTo("error");
        assertThat(longPage.path("errors").get(0).path("field").asString()).isEqualTo("body");
        assertThat(longPreview.toString()).contains("20000").doesNotContain("Confidential");
        assertThat(section(twicePreview, "about-page").path("status").asString())
                .isEqualTo("error");
        assertThat(twicePreview.toString()).contains("appears twice").doesNotContain("Second.");
        assertThat(rowCount()).isZero();
    }

    @Test
    void no_log_line_and_no_import_log_row_contains_the_about_page_body() throws Exception {
        String marker = "Quokka Body Marker 5521";
        String text = aboutPageFile(ABOUT_BODY.replace("Opening paragraph.", marker));
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Logger imports = (Logger) LoggerFactory.getLogger("com.blog.siteimport");
        Level previous = imports.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        imports.setLevel(Level.DEBUG);
        StringBuilder answers = new StringBuilder();
        try {
            answers.append(data(preview(text).andExpect(status().isOk())));
            ResultActions applied = apply(text, "update", List.of("about", "about-page"));
            JsonNode appliedData = data(applied.andExpect(status().isOk()));
            answers.append(appliedData);
            answers.append(data(undo(appliedData.path("importId").asLong()).andExpect(status().isOk())));
        } finally {
            root.detachAppender(logs);
            imports.setLevel(previous);
        }

        for (ILoggingEvent event : logs.list) {
            assertThat(event.getFormattedMessage()).doesNotContain(marker, "echo done");
        }
        assertThat(answers.toString()).doesNotContain(marker, "echo done");
        assertThat(jdbcTemplate.queryForObject("select cast(sections as text) from site_import_log", String.class))
                .doesNotContain(marker, "echo done");
    }

    // --- Helpers -------------------------------------------------------------------------------------------

    /** A row of every table the import touches, as text, to compare before and after. */
    private record Snapshot(List<Map<String, Object>> content, List<Map<String, Object>> revisions, int logs) {}

    private Snapshot snapshot() {
        return new Snapshot(
                jdbcTemplate.queryForList("select key, locale, schema_version, cast(data as text) as data, updated_at "
                        + "from site_content order by key, locale"),
                jdbcTemplate.queryForList(
                        "select id, key, locale, cast(data as text) as data from site_content_revision order by id"),
                logCount());
    }

    private String file(String body) {
        return file(locale, body);
    }

    private static String file(String forLocale, String body) {
        return "---\nschema_version: 1\ncontent_type: site-profile\nlocale: " + forLocale + "\n---\n" + body;
    }

    private static MockMultipartFile markdown(String text) {
        return new MockMultipartFile("file", "profile.md", "text/markdown", text.getBytes(UTF_8));
    }

    private static String sha(String text) {
        return ProfileFile.sha256Hex(text.getBytes(UTF_8));
    }

    private static String site(String name, String tagline) {
        return "{\"name\":\"" + name + "\",\"tagline\":\"" + tagline + "\",\"positioning\":\"\"}";
    }

    private ResultActions preview(String text) throws Exception {
        return mockMvc.perform(multipart(BASE + "/preview").file(markdown(text)).header("Authorization", admin));
    }

    private ResultActions apply(String text, String mode, List<String> sections) throws Exception {
        return mockMvc.perform(multipart(BASE + "/apply")
                .file(markdown(text))
                .param("sha256", sha(text))
                .param("mode", mode)
                .param("sections", sections.toArray(String[]::new))
                .header("Authorization", admin));
    }

    private ResultActions undo(long importId) throws Exception {
        return mockMvc.perform(
                post(BASE + "/undo").param("importId", String.valueOf(importId)).header("Authorization", admin));
    }

    private long importId(ResultActions applied) throws Exception {
        long importId =
                data(applied.andExpect(status().isOk())).path("importId").asLong();
        assertThat(importId).isPositive();
        return importId;
    }

    private ResultActions statusCall() throws Exception {
        return mockMvc.perform(get(BASE + "/status").header("Authorization", admin));
    }

    private void putOk(String key, String forLocale, String payload) throws Exception {
        mockMvc.perform(put(CONTENT + "/" + key)
                        .param("locale", forLocale)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"schemaVersion\":1,\"payload\":" + payload + "}"))
                .andExpect(status().isOk());
    }

    private int send(AbstractMockHttpServletRequestBuilder<?> request, String token) throws Exception {
        if (token != null) {
            request.header("Authorization", token);
        }
        return mockMvc.perform(request).andReturn().getResponse().getStatus();
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString(UTF_8))
                .path("data");
    }

    private String message(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString(UTF_8))
                .path("error")
                .path("message")
                .asString();
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        JsonNode error = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString(UTF_8))
                .path("error");
        assertThat(error.path("code").asString()).isEqualTo(code);
    }

    private JsonNode stored(String key, String forLocale) {
        List<String> rows = jdbcTemplate.queryForList(
                "select cast(data as text) from site_content where key = ? and locale = ?",
                String.class,
                key,
                forLocale);
        return rows.isEmpty() ? null : objectMapper.readTree(rows.get(0));
    }

    private List<JsonNode> loggedSections() {
        List<JsonNode> sections = new ArrayList<>();
        jdbcTemplate
                .queryForList("select cast(sections as text) from site_import_log order by id", String.class)
                .forEach(text -> objectMapper.readTree(text).forEach(sections::add));
        return sections;
    }

    private int rowCount() {
        return jdbcTemplate.queryForObject("select count(*) from site_content", Integer.class);
    }

    private int undoneCount() {
        return jdbcTemplate.queryForObject(
                "select count(*) from site_import_log where undone_at is not null", Integer.class);
    }

    private int logCount() {
        return jdbcTemplate.queryForObject("select count(*) from site_import_log", Integer.class);
    }

    private int revisionCount(String key) {
        return jdbcTemplate.queryForObject(
                "select count(*) from site_content_revision where key = ? and locale = ?", Integer.class, key, locale);
    }

    private String revisionName(long id) {
        String data = jdbcTemplate.queryForObject(
                "select cast(data as text) from site_content_revision where id = ?", String.class, id);
        return objectMapper.readTree(data).path("name").asString();
    }

    private static JsonNode section(JsonNode preview, String id) {
        for (JsonNode section : preview.path("sections")) {
            if (section.path("id").asString().equals(id)) {
                return section;
            }
        }
        throw new AssertionError("no section " + id);
    }

    private static List<String> ids(JsonNode sections) {
        List<String> out = new ArrayList<>();
        sections.forEach(s -> out.add(s.path("id").asString()));
        return out;
    }

    private static List<String> statuses(JsonNode sections, String name) {
        List<String> out = new ArrayList<>();
        sections.forEach(
                s -> out.add(s.path(name).asString() + ":" + s.path("status").asString()));
        return out;
    }

    private static List<String> fieldNames(JsonNode node) {
        return new ArrayList<>(node.propertyNames());
    }
}
