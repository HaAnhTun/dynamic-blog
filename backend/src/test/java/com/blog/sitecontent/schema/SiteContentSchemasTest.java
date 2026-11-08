package com.blog.sitecontent.schema;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.UnaryOperator;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/** The schema of every key: what is accepted, every limit, and the shape of the problems. No Spring, no database. */
class SiteContentSchemasTest {

    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    private static final Validator VALIDATOR =
            Validation.buildDefaultValidatorFactory().getValidator();

    private final SiteContentSchemas schemas = new SiteContentSchemas(VALIDATOR, new SiteContentUpgrades());

    static ObjectNode fixture(SiteContentKey key) {
        try (InputStream in =
                SiteContentSchemasTest.class.getResourceAsStream("/sitecontent/valid/" + key.key() + ".json")) {
            return (ObjectNode) MAPPER.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private List<String> problems(SiteContentKey key, JsonNode payload) {
        return schemas.check(key, 1, payload, "").problems();
    }

    private ObjectNode edited(SiteContentKey key, Consumer<ObjectNode> edit) {
        ObjectNode payload = fixture(key);
        edit.accept(payload);
        return payload;
    }

    private void assertProblem(SiteContentKey key, Consumer<ObjectNode> edit, String pointer) {
        assertThat(problems(key, edited(key, edit))).as(pointer).anyMatch(p -> p.startsWith(pointer + ": "));
    }

    private static String repeat(int length) {
        return "a".repeat(length);
    }

    // --- Valid payloads ------------------------------------------------------------------------------------

    @ParameterizedTest
    @EnumSource(SiteContentKey.class)
    void a_valid_payload_is_accepted_and_stored_exactly_as_written(SiteContentKey key) {
        ObjectNode payload = fixture(key);

        SiteContentSchemas.Checked checked = schemas.check(key, 1, payload, "");

        assertThat(checked.problems()).isEmpty();
        // Required-nullable fields stay explicit nulls, optional ones stay absent.
        assertThat(checked.payload()).isEqualTo(payload);
    }

    @Test
    void text_is_stored_as_typed_and_never_interpreted() {
        ObjectNode payload = edited(SiteContentKey.SITE, p -> p.put("name", "<script>alert(1)</script>"));

        assertThat(schemas.validate(SiteContentKey.SITE, 1, payload).get("name").asString())
                .isEqualTo("<script>alert(1)</script>");
    }

    // --- Text rules ----------------------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(
            strings = {
                "two\nlines",
                "tab\there",
                "nul\u0000byte",
                "del\u007fchar",
                "c1\u0085char",
                " leading",
                "trailing ",
                " nbsp",
                ""
            })
    void a_text_with_control_characters_edge_whitespace_or_no_content_is_rejected(String value) {
        assertProblem(SiteContentKey.SITE, p -> p.put("name", value), "/name");
    }

    @Test
    void the_length_limits_are_exact() {
        assertThat(problems(SiteContentKey.SITE, edited(SiteContentKey.SITE, p -> p.put("name", repeat(80)))))
                .isEmpty();
        assertProblem(SiteContentKey.SITE, p -> p.put("name", repeat(81)), "/name");
        assertProblem(SiteContentKey.SITE, p -> p.put("tagline", repeat(161)), "/tagline");
        assertProblem(SiteContentKey.SITE, p -> p.put("positioning", repeat(301)), "/positioning");
        assertProblem(SiteContentKey.PROFILE, p -> p.put("location", repeat(81)), "/location");
        assertProblem(SiteContentKey.PROFILE, p -> p.put("role", repeat(121)), "/role");
        assertProblem(SiteContentKey.PROFILE, p -> p.put("seeking", repeat(301)), "/seeking");
        assertProblem(SiteContentKey.PROFILE, p -> p.put("galleryLead", repeat(301)), "/galleryLead");
        assertProblem(
                SiteContentKey.PROFILE,
                p -> ((ObjectNode) p.get("hero")).put("headline", repeat(201)),
                "/hero/headline");
        assertProblem(SiteContentKey.ABOUT, p -> p.put("intro", repeat(601)), "/intro");
        assertProblem(SiteContentKey.NOW, p -> p.put("intro", repeat(301)), "/intro");
        assertProblem(SiteContentKey.TIMELINE, p -> p.put("experienceSummary", repeat(601)), "/experienceSummary");
    }

    @Test
    void required_nullable_fields_accept_null_but_not_an_empty_text() {
        assertThat(problems(SiteContentKey.PROFILE, edited(SiteContentKey.PROFILE, p -> p.putNull("seeking"))))
                .isEmpty();
        assertProblem(SiteContentKey.PROFILE, p -> p.put("seeking", ""), "/seeking");
        assertProblem(SiteContentKey.CONTACT, p -> p.put("email", ""), "/email");
    }

    @Test
    void a_required_text_cannot_be_null_or_missing() {
        assertProblem(SiteContentKey.SITE, p -> p.putNull("name"), "/name");
        assertProblem(SiteContentKey.SITE, p -> p.remove("name"), "/name");
    }

    @Test
    void a_number_is_not_a_text() {
        assertProblem(SiteContentKey.SITE, p -> p.put("name", 5), "/name");
    }

    @Test
    void the_payload_must_be_an_object() {
        SiteContentSchemas.Checked checked = schemas.check(SiteContentKey.SITE, 1, MAPPER.createArrayNode(), "");

        assertThat(checked.problems()).containsExactly("/: must be a JSON object");
    }

    // --- Unknown properties --------------------------------------------------------------------------------

    @Test
    void an_unknown_property_is_rejected_at_every_depth() {
        assertProblem(SiteContentKey.SITE, p -> p.put("role", "ADMIN"), "/role");
        assertProblem(SiteContentKey.PROFILE, p -> ((ObjectNode) p.get("hero")).put("html", "x"), "/hero/html");
        assertProblem(
                SiteContentKey.ABOUT,
                p -> ((ObjectNode) p.get("sections").get(1)).put("extra", "x"),
                "/sections/1/extra");
    }

    // --- URLs ----------------------------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(
            strings = {
                "javascript:alert(1)",
                "JavaScript:alert(1)",
                "data:text/html,hello",
                "http://example.com",
                "//example.com",
                "example.com",
                "/relative",
                "ftp://example.com",
                "https://",
                "https:example.com",
                "https://user:secret@example.com",
                "https://exa mple.com",
                "https://example.com\\evil",
                "vbscript:x",
                "mailto:",
                ""
            })
    void a_social_url_outside_the_allow_list_is_rejected(String url) {
        assertProblem(
                SiteContentKey.CONTACT, p -> ((ObjectNode) p.get("social").get(1)).put("url", url), "/social/1/url");
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "https://example.com",
                "HTTPS://example.com/Path?x=1#frag",
                "mailto:owner@example.com",
                "MAILTO:owner@example.com"
            })
    void https_and_mailto_urls_are_accepted_in_any_case(String url) {
        assertThat(problems(
                        SiteContentKey.CONTACT,
                        edited(
                                SiteContentKey.CONTACT,
                                p -> ((ObjectNode) p.get("social").get(1)).put("url", url))))
                .isEmpty();
    }

    @Test
    void github_and_blogroll_accept_https_only() {
        assertProblem(SiteContentKey.CONTACT, p -> p.put("github", "mailto:a@example.com"), "/github");
        assertProblem(SiteContentKey.CONTACT, p -> p.put("github", "http://github.com/x"), "/github");
        assertProblem(
                SiteContentKey.BLOGROLL,
                p -> ((ObjectNode) p.get("entries").get(0)).put("url", "http://example.com"),
                "/entries/0/url");
        assertProblem(
                SiteContentKey.BLOGROLL,
                p -> ((ObjectNode) p.get("entries").get(0)).put("url", "mailto:a@example.com"),
                "/entries/0/url");
    }

    @Test
    void an_evidence_link_is_an_https_url_or_a_path_of_the_site() {
        assertProblem(SiteContentKey.NOW, p -> evidence(p).put("href", "//evil.example"), "/items/1/evidence/href");
        assertProblem(SiteContentKey.NOW, p -> evidence(p).put("href", "/\\evil.example"), "/items/1/evidence/href");
        assertProblem(
                SiteContentKey.NOW, p -> evidence(p).put("href", "javascript:alert(1)"), "/items/1/evidence/href");
        assertProblem(
                SiteContentKey.NOW, p -> evidence(p).put("href", "mailto:a@example.com"), "/items/1/evidence/href");
        assertProblem(SiteContentKey.NOW, p -> evidence(p).put("href", "writing"), "/items/1/evidence/href");
        assertThat(problems(
                        SiteContentKey.NOW,
                        edited(SiteContentKey.NOW, p -> evidence(p).put("href", "/writing/some-post"))))
                .isEmpty();
    }

    private static ObjectNode evidence(ObjectNode now) {
        return (ObjectNode) now.get("items").get(1).get("evidence");
    }

    @Test
    void an_email_is_a_plain_address() {
        for (String email : List.of(
                "no-at-sign",
                "two@@signs",
                "a@b@c",
                "@x.com",
                "x@",
                "a b@x.com",
                "Name <a@x.com>",
                "a@x.com,b@x.com",
                // Anything that could add a header or a recipient to a mailto link.
                "a@x.com?bcc=evil@x.com",
                "a@x.com&cc=evil@x.com",
                "a@x.com;b@x.com",
                "a%40x.com@x.com")) {
            assertProblem(SiteContentKey.CONTACT, p -> p.put("email", email), "/email");
        }
    }

    // --- Dates ---------------------------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(
            strings = {"2026-02-30", "2026-1-1", "26-01-01", "+12026-01-01", "2026/01/01", "2026-01-01T00:00:00", ""})
    void a_date_must_be_a_real_calendar_day_written_yyyy_mm_dd(String date) {
        assertProblem(SiteContentKey.NOW, p -> p.put("lastUpdated", date), "/lastUpdated");
    }

    // --- Slugs, ids, enums, avatar -------------------------------------------------------------------------

    @Test
    void slugs_ids_and_enums_follow_their_patterns() {
        assertProblem(
                SiteContentKey.ABOUT,
                p -> ((ObjectNode) p.get("sections").get(0)).put("id", "Upper"),
                "/sections/0/id");
        assertProblem(
                SiteContentKey.ABOUT,
                p -> ((ObjectNode) p.get("sections").get(0)).put("id", repeat(41)),
                "/sections/0/id");
        assertProblem(
                SiteContentKey.SKILLS,
                p -> ((ObjectNode) p.get("groups").get(0)).put("defaultLevel", "expert"),
                "/groups/0/defaultLevel");
        assertProblem(
                SiteContentKey.SKILLS,
                p -> ((ObjectNode) p.get("groups").get(0).get("items").get(1)).put("level", "expert"),
                "/groups/0/items/1/level");
        assertProblem(
                SiteContentKey.TIMELINE,
                p -> ((ObjectNode) p.get("entries").get(0)).put("kind", "hobby"),
                "/entries/0/kind");
        assertProblem(
                SiteContentKey.CASE_STUDIES,
                p -> ((ObjectNode) p.get("items").get(0)).put("slug", "Has Space"),
                "/items/0/slug");
        assertProblem(
                SiteContentKey.CASE_STUDIES,
                p -> ((ObjectNode) p.get("items").get(0).get("readMore").get(0)).put("slug", "UPPER"),
                "/items/0/readMore/0/slug");
    }

    @Test
    void the_avatar_is_an_uploaded_image_path_or_null() {
        String id = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
        assertThat(problems(
                        SiteContentKey.PROFILE,
                        edited(SiteContentKey.PROFILE, p -> p.put("avatar", "/media/" + id + ".png"))))
                .isEmpty();
        assertThat(problems(
                        SiteContentKey.PROFILE,
                        edited(SiteContentKey.PROFILE, p -> p.put("avatar", "/media/" + id + ".jpg"))))
                .isEmpty();
        for (String avatar : List.of(
                "https://example.com/a.png",
                "/media/" + id + ".gif",
                "/media/" + id.toUpperCase() + ".png",
                "/media/../x.png",
                "/media/" + id)) {
            assertProblem(SiteContentKey.PROFILE, p -> p.put("avatar", avatar), "/avatar");
        }
    }

    @Test
    void duplicate_ids_and_slugs_are_rejected() {
        assertProblem(
                SiteContentKey.ABOUT,
                p -> ((ObjectNode) p.get("sections").get(1)).put("id", "background"),
                "/sections");
        assertProblem(
                SiteContentKey.SKILLS,
                p -> ((ArrayNode) p.get("groups")).add(p.get("groups").get(0).<JsonNode>deepCopy()),
                "/groups");
        assertProblem(
                SiteContentKey.CASE_STUDIES,
                p -> ((ArrayNode) p.get("items")).add(p.get("items").get(0).<JsonNode>deepCopy()),
                "/items");
    }

    // --- Counts --------------------------------------------------------------------------------------------

    private static void fill(ObjectNode payload, String list, int count, String uniqueField) {
        ArrayNode array = (ArrayNode) payload.get(list);
        ObjectNode template = (ObjectNode) array.get(0).deepCopy();
        while (array.size() < count) {
            ObjectNode copy = template.deepCopy();
            if (uniqueField != null) {
                copy.put(uniqueField, "item-" + array.size());
            }
            array.add(copy);
        }
    }

    @Test
    void the_number_of_entries_is_limited() {
        assertThat(problems(SiteContentKey.ABOUT, edited(SiteContentKey.ABOUT, p -> fill(p, "sections", 10, "id"))))
                .isEmpty();
        assertProblem(SiteContentKey.ABOUT, p -> fill(p, "sections", 11, "id"), "/sections");
        assertProblem(SiteContentKey.SKILLS, p -> fill(p, "groups", 13, "id"), "/groups");
        assertProblem(
                SiteContentKey.SKILLS,
                p -> fill((ObjectNode) p.get("groups").get(0), "items", 31, null),
                "/groups/0/items");
        assertProblem(SiteContentKey.NOW, p -> fill(p, "items", 21, null), "/items");
        assertProblem(SiteContentKey.TIMELINE, p -> fill(p, "entries", 31, null), "/entries");
        assertProblem(SiteContentKey.CONTACT, p -> fill(p, "social", 11, null), "/social");
        assertProblem(SiteContentKey.BLOGROLL, p -> fill(p, "entries", 51, null), "/entries");
        assertProblem(SiteContentKey.CASE_STUDIES, p -> fill(p, "items", 21, "slug"), "/items");
    }

    @Test
    void paragraph_lists_have_a_minimum_and_a_maximum() {
        assertProblem(
                SiteContentKey.ABOUT,
                p -> ((ObjectNode) p.get("sections").get(0)).putArray("body"),
                "/sections/0/body");
        assertProblem(
                SiteContentKey.ABOUT,
                p -> {
                    ArrayNode body = ((ObjectNode) p.get("sections").get(0)).putArray("body");
                    for (int i = 0; i < 7; i++) {
                        body.add("paragraph");
                    }
                },
                "/sections/0/body");
        assertProblem(
                SiteContentKey.ABOUT,
                p -> ((ArrayNode) p.get("sections").get(0).get("body")).add(repeat(1001)),
                "/sections/0/body/2");
        assertProblem(
                SiteContentKey.ABOUT,
                p -> ((ArrayNode) p.get("sections").get(0).get("body")).addNull(),
                "/sections/0/body/2");
    }

    // --- Case studies --------------------------------------------------------------------------------------

    private static ObjectNode study(ObjectNode payload) {
        return (ObjectNode) payload.get("items").get(0);
    }

    @Test
    void a_measurement_needs_its_source() {
        assertProblem(
                SiteContentKey.CASE_STUDIES,
                p -> ((ObjectNode) study(p).get("results").get(0)).remove("source"),
                "/items/0/results/0/source");
        assertProblem(
                SiteContentKey.CASE_STUDIES,
                p -> ((ObjectNode) study(p).get("results").get(0)).put("source", ""),
                "/items/0/results/0/source");
        assertProblem(
                SiteContentKey.CASE_STUDIES,
                p -> ((ObjectNode) study(p).get("results").get(0)).put("source", "   "),
                "/items/0/results/0/source");
        assertProblem(
                SiteContentKey.CASE_STUDIES,
                p -> ((ObjectNode) study(p).get("results").get(0)).put("source", repeat(301)),
                "/items/0/results/0/source");
    }

    @Test
    void what_i_would_do_differently_cannot_be_empty() {
        assertProblem(SiteContentKey.CASE_STUDIES, p -> study(p).putArray("ifRedone"), "/items/0/ifRedone");
        assertProblem(SiteContentKey.CASE_STUDIES, p -> study(p).remove("ifRedone"), "/items/0/ifRedone");
    }

    @Test
    void a_case_study_may_have_no_results_but_not_too_many_links() {
        assertThat(problems(
                        SiteContentKey.CASE_STUDIES,
                        edited(SiteContentKey.CASE_STUDIES, p -> study(p).putArray("results"))))
                .isEmpty();
        assertProblem(SiteContentKey.CASE_STUDIES, p -> fill(study(p), "readMore", 11, null), "/items/0/readMore");
        assertProblem(SiteContentKey.CASE_STUDIES, p -> study(p).put("summary", repeat(401)), "/items/0/summary");
        assertProblem(
                SiteContentKey.CASE_STUDIES,
                p -> ((ArrayNode) study(p).get("problem")).add(repeat(2001)),
                "/items/0/problem/1");
    }

    // --- The shape of a problem ----------------------------------------------------------------------------

    @Test
    void at_most_five_problems_are_reported_and_the_value_is_never_echoed() {
        ObjectNode payload = edited(SiteContentKey.PROFILE, p -> {
            p.put("name", "SECRET-VALUE\n");
            p.put("location", "SECRET-VALUE\n");
            p.put("role", "SECRET-VALUE\n");
            p.put("seeking", "SECRET-VALUE\n");
            p.put("galleryLead", "SECRET-VALUE\n");
            p.put("avatar", "SECRET-VALUE");
            ((ObjectNode) p.get("hero")).put("greeting", "SECRET-VALUE\n");
        });

        assertThatThrownBy(() -> schemas.validate(SiteContentKey.PROFILE, 1, payload))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.SITE_CONTENT_INVALID);
                    assertThat(e.getStatus().value()).isEqualTo(400);
                    assertThat(e.getMessage()).doesNotContain("SECRET");
                    assertThat(e.getMessage().split("; "))
                            .hasSize(5)
                            .allMatch(p -> p.startsWith("/") && p.contains(": "));
                });
    }

    @Test
    void the_stored_payload_never_carries_what_the_schema_does_not_know() {
        // Unknown properties are rejected, so the normalized form is the only thing that can reach the database.
        assertProblem(SiteContentKey.NOW, p -> p.put("script", "<script>"), "/script");
    }

    // --- Schema versions -----------------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(ints = {0, -1, 2, 99})
    void an_unknown_schema_version_is_rejected(int version) {
        SiteContentSchemas.Checked checked =
                schemas.check(SiteContentKey.SITE, version, fixture(SiteContentKey.SITE), "");

        assertThat(checked.problems()).containsExactly("/schemaVersion: is not a supported schema version");
    }

    @Test
    void a_missing_schema_version_is_rejected() {
        assertThat(schemas.check(SiteContentKey.SITE, null, fixture(SiteContentKey.SITE), "")
                        .problems())
                .containsExactly("/schemaVersion: is not a supported schema version");
    }

    @Test
    void an_import_prefix_is_put_in_front_of_every_pointer() {
        SiteContentSchemas.Checked checked = schemas.check(
                SiteContentKey.SITE, 1, edited(SiteContentKey.SITE, p -> p.put("name", repeat(81))), "/sections/site");

        assertThat(checked.problems())
                .singleElement()
                .satisfies(p -> assertThat(p).startsWith("/sections/site/name: "));
    }

    @Test
    void older_versions_go_through_the_chain_of_upgraders_one_step_at_a_time() {
        UnaryOperator<JsonNode> one = node -> ((ObjectNode) node).put("tagline", "from-one");
        UnaryOperator<JsonNode> two = node -> ((ObjectNode) node).put("positioning", "from-two");
        SiteContentUpgrades registry = new SiteContentUpgrades(
                Map.of(SiteContentKey.SITE, 3), Map.of(SiteContentKey.SITE, Map.of(1, one, 2, two)));
        SiteContentSchemas versioned = new SiteContentSchemas(VALIDATOR, registry);
        ObjectNode old = MAPPER.createObjectNode().put("name", "Old name");

        JsonNode fromOne = versioned.validate(SiteContentKey.SITE, 1, old.deepCopy());
        assertThat(fromOne.get("name").asString()).isEqualTo("Old name");
        assertThat(fromOne.get("tagline").asString()).isEqualTo("from-one");
        assertThat(fromOne.get("positioning").asString()).isEqualTo("from-two");

        // Version 2 skips the first step.
        ObjectNode twoOld = MAPPER.createObjectNode().put("name", "Two").put("tagline", "kept");
        JsonNode fromTwo = versioned.validate(SiteContentKey.SITE, 2, twoOld);
        assertThat(fromTwo.get("tagline").asString()).isEqualTo("kept");
        assertThat(fromTwo.get("positioning").asString()).isEqualTo("from-two");

        assertThat(versioned.currentVersion(SiteContentKey.SITE)).isEqualTo(3);
        assertThat(versioned.check(SiteContentKey.SITE, 4, old.deepCopy(), "").problems())
                .hasSize(1);
        assertThat(versioned.check(SiteContentKey.SITE, 0, old.deepCopy(), "").problems())
                .hasSize(1);
    }

    @Test
    void a_stored_row_is_upgraded_on_read_and_an_unknown_stored_version_is_an_error() {
        UnaryOperator<JsonNode> one = node -> ((ObjectNode) node).put("tagline", "from-one");
        SiteContentUpgrades registry =
                new SiteContentUpgrades(Map.of(SiteContentKey.SITE, 2), Map.of(SiteContentKey.SITE, Map.of(1, one)));
        SiteContentSchemas versioned = new SiteContentSchemas(VALIDATOR, registry);

        JsonNode upgraded = versioned.upgradeStored(
                SiteContentKey.SITE, 1, MAPPER.createObjectNode().put("name", "n"));

        assertThat(upgraded.get("tagline").asString()).isEqualTo("from-one");
        assertThatThrownBy(() -> versioned.upgradeStored(SiteContentKey.SITE, 3, MAPPER.createObjectNode()))
                .isInstanceOf(ApiException.class);
    }

    @Test
    void a_missing_step_in_the_chain_is_a_problem_and_not_a_crash() {
        SiteContentUpgrades registry = new SiteContentUpgrades(Map.of(SiteContentKey.SITE, 2), Map.of());
        SiteContentSchemas versioned = new SiteContentSchemas(VALIDATOR, registry);

        assertThat(versioned
                        .check(SiteContentKey.SITE, 1, fixture(SiteContentKey.SITE), "")
                        .problems())
                .containsExactly("/schemaVersion: cannot be upgraded to the current version");
    }

    @Test
    void a_failing_upgrader_is_a_problem_and_not_a_crash() {
        UnaryOperator<JsonNode> broken = node -> {
            throw new IllegalStateException("boom");
        };
        SiteContentUpgrades registry =
                new SiteContentUpgrades(Map.of(SiteContentKey.SITE, 2), Map.of(SiteContentKey.SITE, Map.of(1, broken)));
        SiteContentSchemas versioned = new SiteContentSchemas(VALIDATOR, registry);

        assertThat(versioned
                        .check(SiteContentKey.SITE, 1, fixture(SiteContentKey.SITE), "")
                        .valid())
                .isFalse();
    }

    @Test
    void the_size_cap_is_checked_on_the_normalized_payload() {
        ObjectNode payload = edited(SiteContentKey.CASE_STUDIES, p -> {
            ArrayNode items = (ArrayNode) p.get("items");
            ObjectNode template = (ObjectNode) items.get(0).deepCopy();
            ArrayNode problem = template.putArray("problem");
            for (int i = 0; i < 10; i++) {
                problem.add(repeat(2000));
            }
            template.set("constraints", problem.deepCopy());
            template.set("solution", problem.deepCopy());
            template.set("ifRedone", problem.deepCopy());
            while (items.size() < 20) {
                ObjectNode copy = template.deepCopy();
                copy.put("slug", "big-" + items.size());
                items.add(copy);
            }
        });

        assertThat(problems(SiteContentKey.CASE_STUDIES, payload)).containsExactly("/: is too large");
    }
}
