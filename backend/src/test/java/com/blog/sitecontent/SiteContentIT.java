package com.blog.sitecontent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.i18n.Languages;
import com.blog.sitecontent.service.SiteContentService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.AbstractMockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Site content: the public read with its fallback chain, ADMIN-only administration (validate, revisions, restore,
 * export and import, avatar), and the rule that the public answer carries nothing but payloads.
 *
 * Rows are keyed by (key, locale) in a database that is shared and never cleaned, so every test starts from, and
 * leaves behind, an empty site_content (and its revisions): that is the state the rest of the suite already runs in.
 * A fresh ADMIN account per test gives each test its own write rate-limit bucket.
 */
@AutoConfigureMockMvc
class SiteContentIT extends AbstractIntegrationTest {

    private static final String PUBLIC = "/api/v1/site-content";
    private static final String ADMIN = "/api/v1/admin/site-content";

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
    private UUID adminId;
    private String author;
    private String locale;
    private String otherLocale;
    private final List<UUID> createdMedia = new ArrayList<>();

    @BeforeEach
    void setUp() {
        wipe();
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        User adminAccount = auth.createAccount("site-content-admin-" + suffix + "@blog.local", UserRole.ADMIN);
        adminId = adminAccount.getId();
        admin = auth.bearerFor(adminAccount);
        author = auth.bearerFor(auth.createAuthor("site-content-author-" + suffix + "@blog.local"));
        locale = languages.defaultLocale();
        otherLocale = languages.enabled().stream()
                .filter(l -> !l.equals(locale))
                .findFirst()
                .orElseThrow();
    }

    @AfterEach
    void cleanUp() {
        wipe();
        createdMedia.forEach(id -> jdbcTemplate.update("delete from media where id = ?", id));
    }

    private void wipe() {
        jdbcTemplate.update("delete from site_content_revision");
        jdbcTemplate.update("delete from site_content");
    }

    // --- Public read ---------------------------------------------------------------------------------------

    @Test
    void the_public_read_prefers_the_locale_then_the_default_locale_then_leaves_the_key_out() throws Exception {
        putOk("site", locale, fixture("site"));
        putOk("timeline", locale, fixture("timeline"));
        String otherTimeline = fixture("timeline").replace("Several years of backend work.", "Other locale summary.");
        putOk("timeline", otherLocale, otherTimeline);

        JsonNode wanted =
                data(mockMvc.perform(get(PUBLIC).param("locale", otherLocale)).andExpect(status().isOk()));

        assertThat(wanted.path("locale").asString()).isEqualTo(otherLocale);
        assertThat(wanted.path("defaultLocale").asString()).isEqualTo(locale);
        assertThat(languageList(wanted.path("locales"))).containsExactlyElementsOf(languages.enabled());
        JsonNode sections = wanted.path("sections");
        // The row of the wanted locale wins, the default-locale row fills the gap, a key with no row is absent.
        assertThat(sections.path("timeline").path("experienceSummary").asString())
                .isEqualTo("Other locale summary.");
        assertThat(sections.path("site")).isEqualTo(objectMapper.readTree(fixture("site")));
        assertThat(sections.has("profile")).isFalse();
        assertThat(sections.size()).isEqualTo(2);

        JsonNode defaults = data(mockMvc.perform(get(PUBLIC)).andExpect(status().isOk()));
        assertThat(defaults.path("locale").asString()).isEqualTo(locale);
        assertThat(defaults.path("sections")
                        .path("timeline")
                        .path("experienceSummary")
                        .asString())
                .isEqualTo("Several years of backend work.");
    }

    @Test
    void an_empty_site_answers_with_no_sections() throws Exception {
        JsonNode content = data(mockMvc.perform(get(PUBLIC)).andExpect(status().isOk()));

        assertThat(content.path("sections").isObject()).isTrue();
        assertThat(content.path("sections").size()).isZero();
    }

    @Test
    void an_unknown_or_disabled_locale_is_a_validation_error() throws Exception {
        for (String bad : List.of("xx", "fr", "VI-", "../etc")) {
            assertError(mockMvc.perform(get(PUBLIC).param("locale", bad)), 400, "VALIDATION_ERROR");
        }
    }

    @Test
    void the_public_answer_carries_only_payloads() throws Exception {
        putOk("site", locale, fixture("site"));

        String body = mockMvc.perform(get(PUBLIC))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();

        JsonNode data = objectMapper.readTree(body).path("data");
        assertThat(fieldNames(data)).containsExactlyInAnyOrder("locale", "defaultLocale", "locales", "sections");
        assertThat(fieldNames(data.path("sections").path("site")))
                .containsExactlyInAnyOrder("name", "tagline", "positioning");
        assertThat(body).doesNotContain("updatedAt", "updatedBy", "createdBy", "schemaVersion", "revision");
        assertThat(body).doesNotContain("site-content-admin-");
    }

    // --- Admin: write and read -----------------------------------------------------------------------------

    @Test
    void put_validates_stores_and_returns_the_section() throws Exception {
        JsonNode saved = data(putSection("site", locale, 1, fixture("site")).andExpect(status().isOk()));

        assertThat(saved.path("key").asString()).isEqualTo("site");
        assertThat(saved.path("locale").asString()).isEqualTo(locale);
        assertThat(saved.path("schemaVersion").asInt()).isEqualTo(1);
        assertThat(saved.path("updatedAt").asString()).isNotBlank();
        assertThat(saved.path("payload")).isEqualTo(objectMapper.readTree(fixture("site")));

        JsonNode read = data(
                mockMvc.perform(get(ADMIN + "/site").param("locale", locale).header("Authorization", admin))
                        .andExpect(status().isOk()));
        assertThat(read.path("payload")).isEqualTo(saved.path("payload"));
        assertThat(jdbcTemplate.queryForObject(
                        "select cast(updated_by as text) from site_content where key = 'site' and locale = ?",
                        String.class,
                        locale))
                .isNotNull();
    }

    @Test
    void the_admin_list_and_read_see_exact_rows_without_fallback() throws Exception {
        putOk("site", locale, fixture("site"));

        JsonNode list = data(mockMvc.perform(get(ADMIN).param("locale", locale).header("Authorization", admin))
                .andExpect(status().isOk()));
        assertThat(list.path("sections").path("site").path("schemaVersion").asInt())
                .isEqualTo(1);
        assertThat(list.path("sections")
                        .path("site")
                        .path("payload")
                        .path("name")
                        .asString())
                .isEqualTo("Example Site");

        JsonNode other =
                data(mockMvc.perform(get(ADMIN).param("locale", otherLocale).header("Authorization", admin))
                        .andExpect(status().isOk()));
        assertThat(other.path("sections").size()).isZero();
        assertError(
                mockMvc.perform(
                        get(ADMIN + "/site").param("locale", otherLocale).header("Authorization", admin)),
                404,
                "SITE_CONTENT_NOT_FOUND");
        assertError(mockMvc.perform(get(ADMIN).header("Authorization", admin)), 400, "VALIDATION_ERROR");
    }

    @Test
    void an_invalid_payload_is_rejected_with_pointers_and_the_stored_row_is_untouched() throws Exception {
        putOk("contact", locale, fixture("contact"));
        String bad = fixture("contact").replace("https://example.com", "javascript:alert(1)");

        ResultActions rejected = putSection("contact", locale, 1, bad);

        assertError(rejected, 400, "SITE_CONTENT_INVALID");
        String message = objectMapper
                .readTree(rejected.andReturn().getResponse().getContentAsString())
                .path("error")
                .path("message")
                .asString();
        assertThat(message).startsWith("/social/1/url: ").doesNotContain("javascript");
        JsonNode stored = data(
                mockMvc.perform(get(ADMIN + "/contact").param("locale", locale).header("Authorization", admin))
                        .andExpect(status().isOk()));
        assertThat(stored.path("payload")).isEqualTo(objectMapper.readTree(fixture("contact")));
        assertThat(revisionCount("contact")).isZero();
    }

    @Test
    void an_unknown_key_property_or_schema_version_is_rejected() throws Exception {
        assertError(putSection("nope", locale, 1, fixture("site")), 400, "VALIDATION_ERROR");
        assertError(putSection("site", "xx", 1, fixture("site")), 400, "VALIDATION_ERROR");
        assertError(putSection("site", locale, 0, fixture("site")), 400, "SITE_CONTENT_INVALID");
        assertError(putSection("site", locale, 2, fixture("site")), 400, "SITE_CONTENT_INVALID");
        assertError(
                putSection(
                        "site", locale, 1, "{\"name\":\"x\",\"tagline\":\"\",\"positioning\":\"\",\"isAdmin\":true}"),
                400,
                "SITE_CONTENT_INVALID");
        assertError(
                mockMvc.perform(put(ADMIN + "/site")
                        .param("locale", locale)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"payload\":{}}")),
                400,
                "VALIDATION_ERROR");
        assertThat(rowCount()).isZero();
    }

    // --- Revisions -----------------------------------------------------------------------------------------

    @Test
    void every_change_keeps_a_revision_of_the_previous_row_and_only_ten_are_kept() throws Exception {
        putOk("site", locale, siteWithName("Name 0"));
        assertThat(revisionCount("site")).isZero();

        for (int i = 1; i <= 12; i++) {
            putOk("site", locale, siteWithName("Name " + i));
        }

        JsonNode revisions = data(mockMvc.perform(
                        get(ADMIN + "/site/revisions").param("locale", locale).header("Authorization", admin))
                .andExpect(status().isOk()));
        assertThat(revisions.size()).isEqualTo(10);
        assertThat(revisionCount("site")).isEqualTo(10);
        // Newest first: the newest revision holds the row as it was before the last write.
        long previous = Long.MAX_VALUE;
        for (JsonNode revision : revisions) {
            assertThat(revision.path("id").asLong()).isLessThan(previous);
            assertThat(revision.path("schemaVersion").asInt()).isEqualTo(1);
            assertThat(revision.has("createdAt")).isTrue();
            assertThat(revision.has("payload")).isFalse();
            previous = revision.path("id").asLong();
        }
        long newest = revisions.get(0).path("id").asLong();
        assertThat(revisionName(newest)).isEqualTo("Name 11");
        assertThat(revisionName(revisions.get(9).path("id").asLong())).isEqualTo("Name 2");
    }

    @Test
    void saving_what_is_already_stored_keeps_no_revision() throws Exception {
        putOk("site", locale, siteWithName("Name A"));
        putOk("site", locale, siteWithName("Name B"));
        assertThat(revisionCount("site")).isEqualTo(1);

        for (int i = 0; i < 12; i++) {
            putOk("site", locale, siteWithName("Name B"));
        }

        assertThat(revisionCount("site")).isEqualTo(1);
        assertThat(revisionName(revisionIds("site").get(0))).isEqualTo("Name A");
    }

    @Test
    void a_revision_that_no_longer_passes_the_validators_is_not_restored() throws Exception {
        putOk("site", locale, siteWithName("Current"));
        jdbcTemplate.update(
                "insert into site_content_revision (key, locale, schema_version, data) "
                        + "values ('site', ?, 1, cast(? as jsonb))",
                locale,
                "{\"name\":\"\",\"tagline\":\"\",\"positioning\":\"\"}");
        long invalid = revisionIds("site").get(0);

        assertError(restore("site", locale, invalid), 400, "SITE_CONTENT_INVALID");

        assertThat(data(mockMvc.perform(get(ADMIN + "/site")
                                        .param("locale", locale)
                                        .header("Authorization", admin))
                                .andExpect(status().isOk()))
                        .path("payload")
                        .path("name")
                        .asString())
                .isEqualTo("Current");
    }

    @Test
    void a_save_and_a_restore_are_logged_with_the_acting_administrator() throws Exception {
        try (LogCapture logs = LogCapture.of(SiteContentService.class)) {
            putOk("site", locale, siteWithName("First"));
            putOk("site", locale, siteWithName("Second"));
            long first = revisionIds("site").get(0);
            restore("site", locale, first).andExpect(status().isOk());

            assertThat(logs.messages())
                    .containsExactly(
                            "site content saved key=site locale=" + locale + " actor=" + adminId,
                            "site content saved key=site locale=" + locale + " actor=" + adminId,
                            "site content restored key=site locale=" + locale + " actor=" + adminId);
            logs.assertNeverLogged("First", "Second");
        }
    }

    @Test
    void restore_brings_back_a_revision_and_keeps_the_replaced_row_as_a_revision() throws Exception {
        putOk("site", locale, siteWithName("First"));
        putOk("site", locale, siteWithName("Second"));
        long first = revisionIds("site").get(0);

        JsonNode restored = data(restore("site", locale, first).andExpect(status().isOk()));

        assertThat(restored.path("payload").path("name").asString()).isEqualTo("First");
        assertThat(revisionIds("site")).hasSize(2);
        assertThat(revisionName(revisionIds("site").get(0))).isEqualTo("Second");
    }

    @Test
    void a_revision_of_another_key_or_locale_cannot_be_restored() throws Exception {
        putOk("site", locale, siteWithName("A"));
        putOk("site", locale, siteWithName("B"));
        putOk("timeline", locale, fixture("timeline"));
        putOk("timeline", locale, fixture("timeline"));
        long siteRevision = revisionIds("site").get(0);

        assertError(restore("timeline", locale, siteRevision), 404, "SITE_CONTENT_REVISION_NOT_FOUND");
        assertError(restore("site", otherLocale, siteRevision), 404, "SITE_CONTENT_REVISION_NOT_FOUND");
        assertError(restore("site", locale, Long.MAX_VALUE), 404, "SITE_CONTENT_REVISION_NOT_FOUND");
        assertThat(data(mockMvc.perform(get(ADMIN + "/site")
                                        .param("locale", locale)
                                        .header("Authorization", admin))
                                .andExpect(status().isOk()))
                        .path("payload")
                        .path("name")
                        .asString())
                .isEqualTo("B");
    }

    // --- Export and import ---------------------------------------------------------------------------------

    @Test
    void an_export_imports_back_unchanged_and_a_second_import_changes_nothing() throws Exception {
        putOk("site", locale, fixture("site"));
        putOk("profile", locale, fixture("profile"));
        putOk("case_studies", locale, fixture("case_studies"));

        ResultActions exported = mockMvc.perform(
                        get(ADMIN + "/export").param("locale", locale).header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(header().string(
                                "Content-Disposition",
                                org.hamcrest.Matchers.containsString("site-content-" + locale + ".json")));
        String file = exported.andReturn().getResponse().getContentAsString();
        JsonNode document = objectMapper.readTree(file);
        assertThat(document.path("format").asString()).isEqualTo("site-content");
        assertThat(document.path("formatVersion").asInt()).isEqualTo(1);
        assertThat(document.path("locale").asString()).isEqualTo(locale);
        assertThat(fieldNames(document.path("sections"))).containsExactlyInAnyOrder("site", "profile", "case_studies");
        assertThat(document.path("sections").path("site").path("schemaVersion").asInt())
                .isEqualTo(1);

        wipe();
        JsonNode created = data(importDocument(file).andExpect(status().isOk()));
        assertThat(created.path("locale").asString()).isEqualTo(locale);
        assertThat(statuses(created)).containsExactly("site:created", "profile:created", "case_studies:created");
        assertThat(rowCount()).isEqualTo(3);
        JsonNode again = objectMapper.readTree(
                mockMvc.perform(get(ADMIN + "/export").param("locale", locale).header("Authorization", admin))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString());
        assertThat(again).isEqualTo(document);

        JsonNode second = data(importDocument(file).andExpect(status().isOk()));
        assertThat(statuses(second)).containsExactly("site:unchanged", "profile:unchanged", "case_studies:unchanged");
        assertThat(revisionCount("site")).isZero();

        String changed = file.replace("Example Site", "Changed Site");
        JsonNode third = data(importDocument(changed).andExpect(status().isOk()));
        assertThat(statuses(third)).containsExactly("site:updated", "profile:unchanged", "case_studies:unchanged");
        assertThat(revisionCount("site")).isEqualTo(1);
    }

    @Test
    void an_import_with_one_bad_section_writes_nothing() throws Exception {
        putOk("site", locale, siteWithName("Before"));
        String document =
                "{\"format\":\"site-content\",\"formatVersion\":1,\"locale\":\"" + locale + "\",\"sections\":{"
                        + "\"site\":{\"schemaVersion\":1,\"payload\":" + siteWithName("After") + "},"
                        + "\"profile\":{\"schemaVersion\":1,\"payload\":" + fixture("profile") + "},"
                        + "\"now\":{\"schemaVersion\":1,\"payload\":"
                        + fixture("now").replace("2026-01-31", "2026-02-30") + "}}}";

        ResultActions rejected = importDocument(document);

        assertError(rejected, 400, "SITE_CONTENT_INVALID");
        String message = objectMapper
                .readTree(rejected.andReturn().getResponse().getContentAsString())
                .path("error")
                .path("message")
                .asString();
        assertThat(message).startsWith("/sections/now/lastUpdated: ");
        assertThat(rowCount()).isEqualTo(1);
        assertThat(revisionCount("site")).isZero();
        assertThat(data(mockMvc.perform(get(ADMIN + "/site")
                                        .param("locale", locale)
                                        .header("Authorization", admin))
                                .andExpect(status().isOk()))
                        .path("payload")
                        .path("name")
                        .asString())
                .isEqualTo("Before");
    }

    @Test
    void an_import_document_with_a_wrong_format_locale_or_key_is_rejected() throws Exception {
        String section = "{\"schemaVersion\":1,\"payload\":" + fixture("site") + "}";
        assertError(
                importDocument(
                        "{\"format\":\"other\",\"formatVersion\":1,\"locale\":\"" + locale + "\",\"sections\":{}}"),
                400,
                "SITE_CONTENT_INVALID");
        assertError(
                importDocument("{\"format\":\"site-content\",\"formatVersion\":2,\"locale\":\"" + locale
                        + "\",\"sections\":{}}"),
                400,
                "SITE_CONTENT_INVALID");
        assertError(
                importDocument("{\"format\":\"site-content\",\"formatVersion\":1,\"locale\":\"xx\",\"sections\":{}}"),
                400,
                "VALIDATION_ERROR");
        assertError(
                importDocument("{\"format\":\"site-content\",\"formatVersion\":1,\"locale\":\"" + locale
                        + "\",\"sections\":{\"admin\":" + section + "}}"),
                400,
                "SITE_CONTENT_INVALID");
        assertError(
                importDocument("{\"format\":\"site-content\",\"formatVersion\":1,\"locale\":\"" + locale
                        + "\",\"sections\":{\"site\":{\"schemaVersion\":9,\"payload\":" + fixture("site") + "}}}"),
                400,
                "SITE_CONTENT_INVALID");
        assertThat(rowCount()).isZero();
    }

    // --- Authorization -------------------------------------------------------------------------------------

    @Test
    void only_an_admin_can_use_the_admin_endpoints() throws Exception {
        putOk("site", locale, fixture("site"));
        String document =
                "{\"format\":\"site-content\",\"formatVersion\":1,\"locale\":\"" + locale + "\",\"sections\":{}}";
        MockMultipartFile file = new MockMultipartFile("file", "a.png", "image/png", pngBytes());

        for (String token : new String[] {author, null}) {
            int expected = token == null ? 401 : 403;
            assertThat(send(get(ADMIN).param("locale", locale), token)).isEqualTo(expected);
            assertThat(send(get(ADMIN + "/site").param("locale", locale), token))
                    .isEqualTo(expected);
            assertThat(send(get(ADMIN + "/export").param("locale", locale), token))
                    .isEqualTo(expected);
            assertThat(send(get(ADMIN + "/site/revisions").param("locale", locale), token))
                    .isEqualTo(expected);
            assertThat(send(
                            put(ADMIN + "/site")
                                    .param("locale", locale)
                                    .contentType(APPLICATION_JSON)
                                    .content(payloadBody(1, fixture("site"))),
                            token))
                    .isEqualTo(expected);
            assertThat(send(post(ADMIN + "/site/revisions/1/restore").param("locale", locale), token))
                    .isEqualTo(expected);
            assertThat(send(
                            post(ADMIN + "/import")
                                    .contentType(APPLICATION_JSON)
                                    .content(document),
                            token))
                    .isEqualTo(expected);
            assertThat(send(multipart(ADMIN + "/avatar").file(file), token)).isEqualTo(expected);
        }
        assertThat(data(mockMvc.perform(get(ADMIN + "/site")
                                        .param("locale", locale)
                                        .header("Authorization", admin))
                                .andExpect(status().isOk()))
                        .path("payload")
                        .path("name")
                        .asString())
                .isEqualTo("Example Site");
    }

    @Test
    void the_public_read_needs_no_token() throws Exception {
        mockMvc.perform(get(PUBLIC)).andExpect(status().isOk());
    }

    // --- Avatar --------------------------------------------------------------------------------------------

    @Test
    void an_avatar_goes_through_the_media_pipeline_and_creates_no_gallery_photo() throws Exception {
        Integer photosBefore = jdbcTemplate.queryForObject("select count(*) from gallery_photos", Integer.class);
        MockMultipartFile file = new MockMultipartFile("file", "avatar.png", "image/png", pngBytes());

        JsonNode uploaded =
                data(mockMvc.perform(multipart(ADMIN + "/avatar").file(file).header("Authorization", admin))
                        .andExpect(status().isCreated()));

        String url = uploaded.path("url").asString();
        assertThat(url).matches("/media/[0-9a-f-]{36}\\.(png|jpg)");
        createdMedia.add(UUID.fromString(url.substring("/media/".length(), "/media/".length() + 36)));
        assertThat(jdbcTemplate.queryForObject("select count(*) from gallery_photos", Integer.class))
                .isEqualTo(photosBefore);
        // The URL is exactly what the profile field accepts.
        String profile = fixture("profile").replace("\"avatar\": null", "\"avatar\": \"" + url + "\"");
        putOk("profile", locale, profile);
        assertThat(mockMvc.perform(get("/api/v1" + url))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(200);
    }

    @Test
    void an_avatar_upload_without_a_file_or_with_a_text_file_is_rejected() throws Exception {
        assertThat(mockMvc.perform(multipart(ADMIN + "/avatar").header("Authorization", admin))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(400);
        MockMultipartFile text = new MockMultipartFile("file", "a.png", "image/png", "not an image".getBytes());
        assertThat(mockMvc.perform(multipart(ADMIN + "/avatar").file(text).header("Authorization", admin))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isGreaterThanOrEqualTo(400);
    }

    // --- Concurrency ---------------------------------------------------------------------------------------

    @Test
    void two_concurrent_puts_of_the_same_key_leave_one_consistent_row() throws Exception {
        putOk("site", locale, siteWithName("Initial"));
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<Future<Integer>> results = new ArrayList<>();
            for (String name : List.of("Writer A", "Writer B")) {
                Callable<Integer> write = () -> {
                    start.await();
                    return putSection("site", locale, 1, siteWithName(name))
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

        assertThat(rowCount()).isEqualTo(1);
        String name = data(mockMvc.perform(
                                get(ADMIN + "/site").param("locale", locale).header("Authorization", admin))
                        .andExpect(status().isOk()))
                .path("payload")
                .path("name")
                .asString();
        assertThat(name).isIn("Writer A", "Writer B");
        // Each write snapshotted the row it replaced: the initial one, then the first winner.
        List<Long> revisions = revisionIds("site");
        assertThat(revisions).hasSize(2);
        assertThat(List.of(revisionName(revisions.get(0)), revisionName(revisions.get(1))))
                .containsExactlyInAnyOrder("Initial", name.equals("Writer A") ? "Writer B" : "Writer A");
    }

    // --- Helpers -------------------------------------------------------------------------------------------

    private static String fixture(String key) throws Exception {
        try (InputStream in = SiteContentIT.class.getResourceAsStream("/sitecontent/valid/" + key + ".json")) {
            return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static byte[] pngBytes() throws Exception {
        try (InputStream in = SiteContentIT.class.getResourceAsStream("/media/opaque.png")) {
            return in.readAllBytes();
        }
    }

    private static String siteWithName(String name) {
        return "{\"name\":\"" + name + "\",\"tagline\":\"\",\"positioning\":\"\"}";
    }

    private static String payloadBody(int version, String payload) {
        return "{\"schemaVersion\":" + version + ",\"payload\":" + payload + "}";
    }

    private ResultActions putSection(String key, String forLocale, int version, String payload) throws Exception {
        return mockMvc.perform(put(ADMIN + "/" + key)
                .param("locale", forLocale)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(payloadBody(version, payload)));
    }

    private void putOk(String key, String forLocale, String payload) throws Exception {
        putSection(key, forLocale, 1, payload).andExpect(status().isOk());
    }

    private ResultActions restore(String key, String forLocale, long revisionId) throws Exception {
        return mockMvc.perform(post(ADMIN + "/" + key + "/revisions/" + revisionId + "/restore")
                .param("locale", forLocale)
                .header("Authorization", admin));
    }

    private ResultActions importDocument(String document) throws Exception {
        return mockMvc.perform(post(ADMIN + "/import")
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(document));
    }

    private int send(AbstractMockHttpServletRequestBuilder<?> request, String token) throws Exception {
        if (token != null) {
            request.header("Authorization", token);
        }
        return mockMvc.perform(request).andReturn().getResponse().getStatus();
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        JsonNode error = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("error");
        assertThat(error.path("code").asString()).isEqualTo(code);
    }

    private int rowCount() {
        return jdbcTemplate.queryForObject("select count(*) from site_content", Integer.class);
    }

    private int revisionCount(String key) {
        return jdbcTemplate.queryForObject(
                "select count(*) from site_content_revision where key = ? and locale = ?", Integer.class, key, locale);
    }

    private List<Long> revisionIds(String key) throws Exception {
        List<Long> ids = new ArrayList<>();
        JsonNode list = data(mockMvc.perform(get(ADMIN + "/" + key + "/revisions")
                        .param("locale", locale)
                        .header("Authorization", admin))
                .andExpect(status().isOk()));
        list.forEach(revision -> ids.add(revision.path("id").asLong()));
        return ids;
    }

    private String revisionName(long id) throws Exception {
        String data = jdbcTemplate.queryForObject(
                "select cast(data as text) from site_content_revision where id = ?", String.class, id);
        return objectMapper.readTree(data).path("name").asString();
    }

    private static List<String> statuses(JsonNode importResult) {
        List<String> out = new ArrayList<>();
        importResult
                .path("sections")
                .forEach(s -> out.add(
                        s.path("key").asString() + ":" + s.path("status").asString()));
        return out;
    }

    private static List<String> fieldNames(JsonNode node) {
        return new ArrayList<>(node.propertyNames());
    }

    private static List<String> languageList(JsonNode node) {
        List<String> out = new ArrayList<>();
        node.forEach(n -> out.add(n.asString()));
        return out;
    }
}
