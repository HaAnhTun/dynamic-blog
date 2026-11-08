package com.blog.postimport;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.reset;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.post.dto.PostCreateRequest;
import com.blog.post.repository.PostRepository;
import com.blog.series.dto.SeriesRequest;
import com.blog.series.service.SeriesService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import com.blog.support.LogAssertions;
import com.blog.support.ZipPackages;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Series from post files through the HTTP API of the post import, with the real filter chain and a real database: a series
 * is created by its name and a post joins it at the part its file declares, in any order, one file or many at a time; the
 * rules of names, parts and authors; the locks against a second import and against the series editor; and that nothing about a
 * series reaches the log or an answer to somebody who may not see it.
 *
 * Every test has its own accounts and puts a random token into every slug and name: the database is shared and never cleaned.
 */
@AutoConfigureMockMvc
class PostImportSeriesIT extends AbstractIntegrationTest {

    private static final String BASE = "/api/v1/admin/post-import";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PostRepository postRepository;

    @Autowired
    private com.blog.post.service.PostService postService;

    // A spy: the failure tests make it throw once; everything else runs the real service.
    @MockitoSpyBean
    private SeriesService seriesService;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private User adminUser;
    private User authorUser;
    private String admin;
    private String author;
    private String token;
    private String seriesName;

    @BeforeEach
    void setUp() {
        token = UUID.randomUUID().toString().substring(0, 8);
        seriesName = "Queues in practice " + token;
        adminUser = auth.createAccount("series-import-admin-" + token + "@blog.local", UserRole.ADMIN);
        admin = auth.bearerFor(adminUser);
        authorUser = auth.createAuthor("series-import-author-" + token + "@blog.local");
        author = auth.bearerFor(authorUser);
    }

    // --- Any order ------------------------------------------------------------------------------------------

    @Test
    void parts_imported_one_at_a_time_in_any_order_make_one_series_that_reads_in_part_order() throws Exception {
        MockMultipartFile ten = part("ten", 10);
        MockMultipartFile one = part("one", 1);
        MockMultipartFile five = part("five", 5);

        JsonNode firstPreview = preview(admin, ten);
        JsonNode file = firstPreview.path("files").get(0);
        assertThat(file.path("state").asString()).isEqualTo("new");
        assertThat(codes(file.path("notes"))).contains("series_will_be_created");
        assertThat(file.path("newSeries").size()).isEqualTo(1);
        assertThat(file.path("newSeries").get(0).asString()).isEqualTo(seriesName);
        assertThat(file.path("changes").path("series").path("after").asString()).isEqualTo(seriesName);
        assertThat(file.path("changes").path("seriesPart").path("after").asInt())
                .isEqualTo(10);
        assertThat(firstPreview.path("newSeriesCount").asInt()).isEqualTo(1);
        apply(admin, manifest(firstPreview, true), ten).andExpect(status().isOk());

        JsonNode secondPreview = preview(admin, one);
        assertThat(codes(secondPreview.path("files").get(0).path("notes"))).doesNotContain("series_will_be_created");
        assertThat(secondPreview.path("newSeriesCount").asInt()).isZero();
        apply(admin, manifest(secondPreview, true), one).andExpect(status().isOk());
        apply(admin, manifest(preview(admin, five), true), five).andExpect(status().isOk());

        assertThat(seriesCount(seriesName)).isEqualTo(1);
        UUID series = seriesId(seriesName);
        assertThat(jdbcTemplate.queryForObject("select slug from series where id = ?", String.class, series))
                .isEqualTo(slugOf(seriesName));
        assertThat(memberSlugsInOrder(series)).containsExactly("one-" + token, "five-" + token, "ten-" + token);
        assertThat(partsInOrder(series)).containsExactly(1, 5, 10);
        assertThat(positionsInOrder(series)).containsExactly(1, 2, 3);
        assertThat(seriesOf("one-" + token)).isEqualTo(series);
        assertThat(seriesOf("five-" + token)).isEqualTo(series);
        assertThat(seriesOf("ten-" + token)).isEqualTo(series);
        assertThat(statusOf("ten-" + token)).isEqualTo("DRAFT");
    }

    @Test
    void three_files_in_one_batch_join_one_new_series_in_reverse_order_and_in_forward_order() throws Exception {
        MockMultipartFile[] reverse = {part("c", 3), part("b", 2), part("a", 1)};
        JsonNode preview = preview(admin, reverse);
        assertThat(preview.path("newSeriesCount").asInt()).isEqualTo(1);
        // Only the first file to name the series announces its creation.
        assertThat(codes(preview.path("files").get(0).path("notes"))).contains("series_will_be_created");
        assertThat(codes(preview.path("files").get(1).path("notes"))).doesNotContain("series_will_be_created");
        assertThat(codes(preview.path("files").get(2).path("notes"))).doesNotContain("series_will_be_created");
        JsonNode applied =
                data(apply(admin, manifest(preview, true, true, true), reverse).andExpect(status().isOk()));
        assertThat(applied.path("created").asInt()).isEqualTo(3);

        UUID series = seriesId(seriesName);
        assertThat(seriesCount(seriesName)).isEqualTo(1);
        assertThat(memberSlugsInOrder(series)).containsExactly("a-" + token, "b-" + token, "c-" + token);
        assertThat(partsInOrder(series)).containsExactly(1, 2, 3);

        String forwardName = "Forward " + seriesName;
        MockMultipartFile[] forward = {
            named(forwardName, "x", 1, null), named(forwardName, "y", 2, null), named(forwardName, "z", 3, null)
        };
        data(apply(admin, manifest(preview(admin, forward), true, true, true), forward)
                .andExpect(status().isOk()));
        assertThat(seriesCount(forwardName)).isEqualTo(1);
        assertThat(memberSlugsInOrder(seriesId(forwardName))).containsExactly("x-" + token, "y-" + token, "z-" + token);
    }

    @Test
    void importing_the_same_package_again_is_unchanged_with_no_write_and_no_log_row() throws Exception {
        MockMultipartFile[] files = {part("a", 1), part("b", 2), part("c", 3)};
        apply(admin, manifest(preview(admin, files), true, true, true), files).andExpect(status().isOk());
        UUID series = seriesId(seriesName);
        long logsBefore = logCount(adminUser);
        List<Object> before = jdbcTemplate.queryForList(
                "select concat_ws(',', id, series_id, series_position, series_part, updated_at) from posts where slug in (?, ?, ?) order by slug",
                Object.class,
                "a-" + token,
                "b-" + token,
                "c-" + token);

        JsonNode second = preview(admin, files);
        for (JsonNode file : second.path("files")) {
            assertThat(file.path("state").asString()).isEqualTo("unchanged");
            assertThat(file.path("previewState").isNull()).isTrue();
        }
        JsonNode applied =
                data(apply(admin, manifest(second, true, true, true), files).andExpect(status().isOk()));

        assertThat(applied.path("unchanged").asInt()).isEqualTo(3);
        assertThat(applied.path("importId").isNull()).isTrue();
        assertThat(logCount(adminUser)).isEqualTo(logsBefore);
        assertThat(seriesCount(seriesName)).isEqualTo(1);
        assertThat(seriesId(seriesName)).isEqualTo(series);
        assertThat(jdbcTemplate.queryForList(
                        "select concat_ws(',', id, series_id, series_position, series_part, updated_at) from posts where slug in (?, ?, ?) order by slug",
                        Object.class,
                        "a-" + token,
                        "b-" + token,
                        "c-" + token))
                .isEqualTo(before);
    }

    @Test
    void a_file_with_the_series_but_no_part_keeps_the_place_of_a_post_that_is_already_in_it() throws Exception {
        MockMultipartFile first = part("keeps", 4);
        apply(admin, manifest(preview(admin, first), true), first).andExpect(status().isOk());

        MockMultipartFile again = markdown(
                "keeps.md", file("title: Part keeps " + token, "slug: keeps-" + token, "series: " + seriesName));
        JsonNode preview = preview(admin, again);

        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("unchanged");
        assertThat(preview.path("files").get(0).path("problems").size()).isZero();
    }

    @Test
    void importing_the_file_of_part_one_for_a_series_ordered_by_hand_keeps_the_order_and_writes_the_part()
            throws Exception {
        UUID series =
                seriesService.create(new SeriesRequest(seriesName, null, null)).id();
        UUID one = createPost(adminUser, "Part one " + token, "one-" + token);
        UUID two = createPost(adminUser, "Part two " + token, "two-" + token);
        UUID three = createPost(adminUser, "Part three " + token, "three-" + token);
        seriesService.setPosts(series, List.of(one, two, three));
        MockMultipartFile file = markdown(
                "one.md",
                file("title: Part one " + token, "slug: one-" + token, "series: " + seriesName, "series_part: 1"));

        JsonNode preview = preview(admin, file);
        JsonNode planned = preview.path("files").get(0);
        assertThat(planned.path("state").asString()).isEqualTo("will_change");
        assertThat(planned.path("changes").path("seriesPart").path("after").asInt())
                .isEqualTo(1);
        apply(admin, manifest(preview, true), file).andExpect(status().isOk());

        assertThat(memberSlugsInOrder(series)).containsExactly("one-" + token, "two-" + token, "three-" + token);
        assertThat(positionsInOrder(series)).containsExactly(1, 2, 3);
        assertThat(partsInOrder(series)).containsExactly(1, null, null);
    }

    // --- Two files, one new series --------------------------------------------------------------------------

    @Test
    void two_files_that_create_the_same_new_series_make_one_series_and_the_first_description_wins() throws Exception {
        MockMultipartFile[] files = {
            named(seriesName, "first", 1, "The first description."),
            named(seriesName, "second", 2, "The second description.")
        };
        JsonNode preview = preview(admin, files);
        assertThat(codes(preview.path("files").get(1).path("notes"))).contains("series_description_ignored");

        apply(admin, manifest(preview, true, true), files).andExpect(status().isOk());

        assertThat(seriesCount(seriesName)).isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject(
                        "select description from series where id = ?", String.class, seriesId(seriesName)))
                .isEqualTo("The first description.");
    }

    @Test
    void a_description_is_never_written_to_a_series_that_exists() throws Exception {
        UUID existing = seriesService
                .create(new SeriesRequest(seriesName, null, "The admin description."))
                .id();
        MockMultipartFile file = named(seriesName, "late", 2, "A description from a file.");

        JsonNode preview = preview(admin, file);
        assertThat(codes(preview.path("files").get(0).path("notes"))).contains("series_description_ignored");
        apply(admin, manifest(preview, true), file).andExpect(status().isOk());

        assertThat(jdbcTemplate.queryForObject("select description from series where id = ?", String.class, existing))
                .isEqualTo("The admin description.");
    }

    // --- The description of a series: filled when empty, never overwritten ---------------------------------

    @Test
    void a_description_from_a_file_fills_the_empty_description_of_a_series_that_exists() throws Exception {
        UUID existing =
                seriesService.create(new SeriesRequest(seriesName, null, null)).id();
        MockMultipartFile file = named(seriesName, "late", 2, "A description from a file.");

        JsonNode preview = preview(admin, file);
        List<String> notes = codes(preview.path("files").get(0).path("notes"));
        assertThat(notes).contains("series_description_will_be_set").doesNotContain("series_description_ignored");
        apply(admin, manifest(preview, true), file).andExpect(status().isOk());

        assertThat(descriptionOf(existing)).isEqualTo("A description from a file.");
        assertThat(memberSlugsInOrder(existing)).containsExactly("late-" + token);
    }

    @Test
    void the_first_description_stored_wins_when_part_three_is_imported_before_part_one() throws Exception {
        MockMultipartFile three = named(seriesName, "three", 3, "The description of part three.");
        apply(admin, manifest(preview(admin, three), true), three).andExpect(status().isOk());
        UUID series = seriesId(seriesName);
        MockMultipartFile one = named(seriesName, "one", 1, "The description of part one.");

        JsonNode preview = preview(admin, one);
        List<String> notes = codes(preview.path("files").get(0).path("notes"));
        assertThat(notes).contains("series_description_ignored").doesNotContain("series_description_will_be_set");
        apply(admin, manifest(preview, true), one).andExpect(status().isOk());

        assertThat(seriesCount(seriesName)).isEqualTo(1);
        assertThat(descriptionOf(series)).isEqualTo("The description of part three.");
        assertThat(memberSlugsInOrder(series)).containsExactly("one-" + token, "three-" + token);
    }

    @Test
    void a_part_without_a_description_creates_the_series_and_a_later_part_with_one_fills_it() throws Exception {
        MockMultipartFile three = part("three", 3);
        apply(admin, manifest(preview(admin, three), true), three).andExpect(status().isOk());
        UUID series = seriesId(seriesName);
        assertThat(descriptionOf(series)).isNull();
        MockMultipartFile one = named(seriesName, "one", 1, "The description of part one.");

        JsonNode preview = preview(admin, one);
        assertThat(codes(preview.path("files").get(0).path("notes"))).contains("series_description_will_be_set");
        apply(admin, manifest(preview, true), one).andExpect(status().isOk());

        assertThat(descriptionOf(series)).isEqualTo("The description of part one.");
        assertThat(seriesCount(seriesName)).isEqualTo(1);
    }

    @Test
    void a_batch_in_reverse_order_with_the_same_description_in_every_part_makes_one_series_with_one_description()
            throws Exception {
        MockMultipartFile[] files = {
            named(seriesName, "c", 3, "One shared description."),
            named(seriesName, "b", 2, "One shared description."),
            named(seriesName, "a", 1, "One shared description.")
        };
        JsonNode preview = preview(admin, files);
        assertThat(codes(preview.path("files").get(0).path("notes")))
                .doesNotContain("series_description_will_be_set", "series_description_ignored");
        assertThat(codes(preview.path("files").get(1).path("notes"))).contains("series_description_ignored");
        assertThat(codes(preview.path("files").get(2).path("notes"))).contains("series_description_ignored");

        apply(admin, manifest(preview, true, true, true), files).andExpect(status().isOk());

        assertThat(seriesCount(seriesName)).isEqualTo(1);
        UUID series = seriesId(seriesName);
        assertThat(descriptionOf(series)).isEqualTo("One shared description.");
        assertThat(memberSlugsInOrder(series)).containsExactly("a-" + token, "b-" + token, "c-" + token);
    }

    @Test
    void in_a_batch_the_first_file_with_a_description_fills_a_series_that_an_earlier_file_created_without_one()
            throws Exception {
        MockMultipartFile[] files = {
            named(seriesName, "c", 3, null),
            named(seriesName, "b", 2, "The description of part two."),
            named(seriesName, "a", 1, "The description of part one.")
        };
        JsonNode preview = preview(admin, files);
        assertThat(preview.path("newSeriesCount").asInt()).isEqualTo(1);
        assertThat(codes(preview.path("files").get(1).path("notes")))
                .contains("series_description_will_be_set")
                .doesNotContain("series_will_be_created");
        assertThat(codes(preview.path("files").get(2).path("notes"))).contains("series_description_ignored");

        apply(admin, manifest(preview, true, true, true), files).andExpect(status().isOk());

        assertThat(seriesCount(seriesName)).isEqualTo(1);
        assertThat(descriptionOf(seriesId(seriesName))).isEqualTo("The description of part two.");
    }

    @Test
    void an_empty_description_value_in_a_file_writes_nothing_and_says_nothing() throws Exception {
        UUID empty =
                seriesService.create(new SeriesRequest(seriesName, null, null)).id();
        String keptName = "Kept " + seriesName;
        UUID kept = seriesService
                .create(new SeriesRequest(keptName, null, "The description of the administrator."))
                .id();
        MockMultipartFile intoEmpty = markdown(
                "e.md",
                file(
                        "title: Part e " + token,
                        "slug: e-" + token,
                        "series: " + seriesName,
                        "series_part: 1",
                        "series_description:"));
        MockMultipartFile intoKept = markdown(
                "k.md",
                file(
                        "title: Part k " + token,
                        "slug: k-" + token,
                        "series: " + keptName,
                        "series_part: 1",
                        "series_description:   "));

        JsonNode preview = preview(admin, intoEmpty, intoKept);
        for (JsonNode planned : preview.path("files")) {
            assertThat(codes(planned.path("notes")))
                    .doesNotContain("series_description_will_be_set", "series_description_ignored");
        }
        apply(admin, manifest(preview, true, true), intoEmpty, intoKept).andExpect(status().isOk());

        assertThat(descriptionOf(empty)).isNull();
        assertThat(descriptionOf(kept)).isEqualTo("The description of the administrator.");
    }

    @Test
    void a_post_in_place_whose_file_only_adds_the_description_will_change_and_then_reads_unchanged() throws Exception {
        MockMultipartFile bare = part("inplace", 2);
        apply(admin, manifest(preview(admin, bare), true), bare).andExpect(status().isOk());
        UUID series = seriesId(seriesName);
        String postBefore = jdbcTemplate.queryForObject(
                "select concat_ws(',', series_id, series_position, series_part, updated_at) from posts where slug = ?",
                String.class,
                "inplace-" + token);
        int revisionsBefore = jdbcTemplate.queryForObject(
                "select count(*) from post_revisions where post_id = ?", Integer.class, postId("inplace-" + token));
        MockMultipartFile described = named(seriesName, "inplace", 2, "A description that is new.");

        JsonNode preview = preview(admin, described);
        JsonNode planned = preview.path("files").get(0);
        assertThat(planned.path("state").asString()).isEqualTo("will_change");
        assertThat(codes(planned.path("notes"))).contains("series_description_will_be_set");
        assertThat(planned.path("changes").path("series").isNull()).isTrue();
        assertThat(planned.path("changes").path("seriesPart").isNull()).isTrue();
        JsonNode applied = data(apply(admin, manifest(preview, true), described).andExpect(status().isOk()));

        assertThat(applied.path("updated").asInt()).isEqualTo(1);
        assertThat(descriptionOf(series)).isEqualTo("A description that is new.");
        assertThat(jdbcTemplate.queryForObject(
                        "select concat_ws(',', series_id, series_position, series_part, updated_at) from posts where slug = ?",
                        String.class,
                        "inplace-" + token))
                .isEqualTo(postBefore);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from post_revisions where post_id = ?",
                        Integer.class,
                        postId("inplace-" + token)))
                .isEqualTo(revisionsBefore);
        assertThat(preview(admin, described).path("files").get(0).path("state").asString())
                .isEqualTo("unchanged");
    }

    @Test
    void a_member_whose_file_names_the_series_without_a_part_still_fills_the_empty_description() throws Exception {
        MockMultipartFile bare = part("keeps", 4);
        apply(admin, manifest(preview(admin, bare), true), bare).andExpect(status().isOk());
        MockMultipartFile described = markdown(
                "keeps.md",
                file(
                        "title: Part keeps " + token,
                        "slug: keeps-" + token,
                        "series: " + seriesName,
                        "series_description: Written next to no part."));

        JsonNode preview = preview(admin, described);
        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("will_change");
        apply(admin, manifest(preview, true), described).andExpect(status().isOk());

        assertThat(descriptionOf(seriesId(seriesName))).isEqualTo("Written next to no part.");
        assertThat(partOf("keeps-" + token)).isEqualTo(4);
    }

    @Test
    void an_author_never_fills_the_description_of_a_series() throws Exception {
        UUID existing =
                seriesService.create(new SeriesRequest(seriesName, null, null)).id();
        MockMultipartFile file = named(seriesName, "authored", 1, "A description from an author.");

        JsonNode preview = preview(author, file);
        List<String> notes = codes(preview.path("files").get(0).path("notes"));
        assertThat(notes)
                .contains("series_ignored_author")
                .doesNotContain("series_description_will_be_set", "series_description_ignored");
        apply(author, manifest(preview, true), file).andExpect(status().isOk());

        assertThat(descriptionOf(existing)).isNull();
        assertThat(memberSlugsInOrder(existing)).isEmpty();
    }

    @Test
    void filling_a_description_leaves_it_out_of_the_answers_the_import_log_and_the_log_lines() throws Exception {
        String marker = "Okapi-Marker-" + token;
        UUID existing =
                seriesService.create(new SeriesRequest(seriesName, null, null)).id();
        MockMultipartFile file = named(seriesName, "filled", 1, "Description " + marker);
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Logger imports = (Logger) LoggerFactory.getLogger("com.blog.postimport");
        Level previous = imports.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        imports.setLevel(Level.DEBUG);
        String previewed;
        String applied;
        try {
            previewed = responseBody(previewCall(admin, file));
            applied = responseBody(
                    apply(admin, manifest(objectMapper.readTree(previewed).path("data"), true), file)
                            .andExpect(status().isOk()));
        } finally {
            root.detachAppender(logs);
            imports.setLevel(previous);
        }

        assertThat(descriptionOf(existing)).isEqualTo("Description " + marker);
        String items = jdbcTemplate.queryForObject(
                "select cast(items as text) from post_import_log where id = ?",
                String.class,
                objectMapper.readTree(applied).path("data").path("importId").asLong());
        assertThat(previewed).doesNotContain(marker);
        assertThat(applied).doesNotContain(marker);
        assertThat(items).doesNotContain(marker);
        LogAssertions.assertNoValues(logs.list, marker, marker.toLowerCase(Locale.ROOT));
    }

    @Test
    void the_same_name_with_other_letter_case_or_accents_is_the_same_series_and_never_a_second_one_with_a_dash_2_slug()
            throws Exception {
        String accented = "Caf\u00e9 notes " + token;
        MockMultipartFile first = named(accented, "one", 1, null);
        apply(admin, manifest(preview(admin, first), true), first).andExpect(status().isOk());

        MockMultipartFile upper = named(("CAF\u00c9 NOTES " + token), "two", 2, null);
        MockMultipartFile plain = named("cafe notes " + token, "three", 3, null);
        JsonNode preview = preview(admin, upper, plain);
        // Found by name, not created, and the stored title is kept: the file only differs in how it writes it.
        assertThat(codes(preview.path("files").get(0).path("notes"))).contains("series_title_differs");
        assertThat(codes(preview.path("files").get(1).path("notes"))).contains("series_title_differs");
        assertThat(preview.path("newSeriesCount").asInt()).isZero();
        apply(admin, manifest(preview, true, true), upper, plain).andExpect(status().isOk());

        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from series where slug like ?", Integer.class, "cafe-notes-" + token + "%"))
                .isEqualTo(1);
        UUID series = seriesId(accented);
        assertThat(memberSlugsInOrder(series)).containsExactly("one-" + token, "two-" + token, "three-" + token);
        assertThat(jdbcTemplate.queryForObject("select title from series where id = ?", String.class, series))
                .isEqualTo(accented);
    }

    @Test
    void a_new_series_named_three_ways_in_one_batch_is_created_once_with_the_title_of_the_first_file()
            throws Exception {
        String accented = "Caf\u00e9 notes " + token;
        MockMultipartFile[] files = {
            named(accented, "one", 1, null),
            named("CAF\u00c9 NOTES " + token, "two", 2, null),
            named("cafe notes " + token, "three", 3, null)
        };

        JsonNode preview = preview(admin, files);

        assertThat(preview.path("newSeriesCount").asInt()).isEqualTo(1);
        assertThat(codes(preview.path("files").get(0).path("notes"))).contains("series_will_be_created");
        assertThat(codes(preview.path("files").get(1).path("notes"))).doesNotContain("series_will_be_created");
        assertThat(codes(preview.path("files").get(2).path("notes"))).doesNotContain("series_will_be_created");
        for (JsonNode file : preview.path("files")) {
            assertThat(file.path("problems").size()).isZero();
        }
        apply(admin, manifest(preview, true, true, true), files).andExpect(status().isOk());

        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from series where slug like ?", Integer.class, "cafe-notes-" + token + "%"))
                .isEqualTo(1);
        // No second series with a numbered slug such as cafe-notes-<token>-2.
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from series where slug like ?", Integer.class, "cafe-notes-" + token + "-%"))
                .isZero();
        UUID series =
                jdbcTemplate.queryForObject("select id from series where slug = ?", UUID.class, "cafe-notes-" + token);
        assertThat(jdbcTemplate.queryForObject("select title from series where id = ?", String.class, series))
                .isEqualTo(accented);
        assertThat(memberSlugsInOrder(series)).containsExactly("one-" + token, "two-" + token, "three-" + token);
    }

    // --- Parts -----------------------------------------------------------------------------------------------

    @Test
    void a_part_that_another_post_of_the_series_and_language_holds_is_a_problem_with_numbers_only() throws Exception {
        MockMultipartFile holder = part("holder", 3);
        apply(admin, manifest(preview(admin, holder), true), holder).andExpect(status().isOk());

        MockMultipartFile claimant = part("claimant", 3);
        JsonNode preview = preview(admin, claimant);
        JsonNode file = preview.path("files").get(0);

        assertThat(file.path("state").asString()).isEqualTo("error");
        assertThat(file.path("problems").get(0).path("key").asString()).isEqualTo("series_part");
        assertThat(file.path("problems").get(0).path("message").asString())
                .isEqualTo("part 3 of this series is already used by another post");
        ResultActions result = apply(admin, manifest(preview, true), claimant);
        assertError(result, 400, "POST_IMPORT_INVALID");
        assertThat(message(result)).doesNotContain(seriesName).doesNotContain("claimant");
        assertThat(postCount("claimant-" + token)).isZero();
    }

    @Test
    void a_part_given_by_two_files_of_one_batch_is_a_problem_on_the_second_and_a_swap_is_one_too() throws Exception {
        MockMultipartFile[] files = {part("p", 2), part("q", 2)};

        JsonNode preview = preview(admin, files);

        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("new");
        JsonNode second = preview.path("files").get(1);
        assertThat(second.path("state").asString()).isEqualTo("error");
        assertThat(second.path("problems").get(0).path("message").asString())
                .isEqualTo("part 2 of this series is also given by file 1");
        assertThat(second.path("problems").get(0).path("key").asString()).isEqualTo("series_part");

        // A swap: two posts already hold 1 and 2 and the files give them 2 and 1.
        apply(admin, manifest(preview(admin, part("s1", 1)), true), part("s1", 1))
                .andExpect(status().isOk());
        apply(admin, manifest(preview(admin, part("s2", 2)), true), part("s2", 2))
                .andExpect(status().isOk());
        JsonNode swap = preview(admin, part("s1", 2), part("s2", 1));
        assertThat(swap.path("files").get(0).path("state").asString()).isEqualTo("error");
        assertThat(swap.path("files").get(1).path("state").asString()).isEqualTo("error");
        assertThat(swap.path("files")
                        .get(0)
                        .path("problems")
                        .get(0)
                        .path("message")
                        .asString())
                .isEqualTo("part 2 of this series is already used by another post");
    }

    @Test
    void a_new_member_without_a_part_is_a_problem_and_a_part_without_a_series_is_one_too() throws Exception {
        MockMultipartFile noPart =
                markdown("n.md", file("title: N " + token, "slug: n-" + token, "series: " + seriesName));
        MockMultipartFile noSeries = markdown("m.md", file("title: M " + token, "slug: m-" + token, "series_part: 2"));

        JsonNode preview = preview(admin, noPart, noSeries);

        assertThat(preview.path("files")
                        .get(0)
                        .path("problems")
                        .get(0)
                        .path("message")
                        .asString())
                .isEqualTo("series needs series_part");
        assertThat(preview.path("files")
                        .get(0)
                        .path("problems")
                        .get(0)
                        .path("key")
                        .asString())
                .isEqualTo("series");
        assertThat(preview.path("files")
                        .get(1)
                        .path("problems")
                        .get(0)
                        .path("message")
                        .asString())
                .isEqualTo("series_part needs series");
    }

    @Test
    void a_part_that_is_not_a_valid_number_is_reported_once_and_not_as_a_missing_part() throws Exception {
        MockMultipartFile zero = markdown(
                "z.md", file("title: Z " + token, "slug: z-" + token, "series: " + seriesName, "series_part: 0"));
        MockMultipartFile word = markdown(
                "w.md", file("title: W " + token, "slug: w-" + token, "series: " + seriesName, "series_part: first"));

        JsonNode preview = preview(admin, zero, word);

        for (JsonNode planned : preview.path("files")) {
            assertThat(planned.path("problemsTotal").asInt()).isEqualTo(1);
            assertThat(planned.path("problems").get(0).path("key").asString()).isEqualTo("series_part");
            assertThat(planned.path("problems").get(0).path("message").asString())
                    .isEqualTo("series_part is not a whole number from 1 to 1000");
        }
    }

    @Test
    void a_member_whose_file_gives_another_free_part_moves_to_the_place_of_that_part() throws Exception {
        MockMultipartFile[] files = {part("a", 1), part("b", 2), part("c", 3)};
        apply(admin, manifest(preview(admin, files), true, true, true), files).andExpect(status().isOk());

        MockMultipartFile moved = part("a", 9);
        JsonNode preview = preview(admin, moved);
        JsonNode file = preview.path("files").get(0);
        assertThat(file.path("state").asString()).isEqualTo("will_change");
        assertThat(file.path("changes").path("seriesPart").path("before").asInt())
                .isEqualTo(1);
        assertThat(file.path("changes").path("seriesPart").path("after").asInt())
                .isEqualTo(9);
        data(apply(admin, manifest(preview, true), moved).andExpect(status().isOk()));

        assertThat(memberSlugsInOrder(seriesId(seriesName))).containsExactly("b-" + token, "c-" + token, "a-" + token);
        assertThat(partsInOrder(seriesId(seriesName))).containsExactly(2, 3, 9);
    }

    @Test
    void the_same_part_in_two_languages_is_allowed_and_each_language_reads_in_its_own_order() throws Exception {
        MockMultipartFile english = named(seriesName, "en-three", 3, null, "en");
        MockMultipartFile vietnamese = named(seriesName, "vi-three", 3, null, "vi");
        MockMultipartFile englishOne = named(seriesName, "en-one", 1, null, "en");

        JsonNode preview = preview(admin, english, vietnamese, englishOne);
        for (JsonNode file : preview.path("files")) {
            assertThat(file.path("state").asString()).isEqualTo("new");
        }
        apply(admin, manifest(preview, true, true, true), english, vietnamese, englishOne)
                .andExpect(status().isOk());

        UUID series = seriesId(seriesName);
        assertThat(partOf("en-three-" + token)).isEqualTo(3);
        assertThat(partOf("vi-three-" + token)).isEqualTo(3);
        List<String> order = memberSlugsInOrder(series);
        assertThat(order.indexOf("en-one-" + token)).isLessThan(order.indexOf("en-three-" + token));
    }

    // --- Names -----------------------------------------------------------------------------------------------

    @Test
    void a_name_that_two_series_answer_to_is_a_problem_and_nothing_is_created() throws Exception {
        String shared = "Shared name " + token;
        seriesService.create(new SeriesRequest("Other title " + token, slugOf(shared), null));
        seriesService.create(new SeriesRequest(shared, null, null));
        MockMultipartFile file = named(shared, "ambiguous", 1, null);

        JsonNode preview = preview(admin, file);

        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("error");
        assertThat(preview.path("files")
                        .get(0)
                        .path("problems")
                        .get(0)
                        .path("message")
                        .asString())
                .isEqualTo("more than one series has this name");
        assertThat(postCount("ambiguous-" + token)).isZero();
    }

    @Test
    void an_import_creates_at_most_ten_new_series_and_the_file_that_goes_over_has_the_problem() throws Exception {
        MockMultipartFile[] files = new MockMultipartFile[11];
        for (int i = 0; i < files.length; i++) {
            files[i] = named("Many " + i + " " + token, "many-" + i, 1, null);
        }

        JsonNode preview = preview(admin, files);

        for (int i = 0; i < 10; i++) {
            assertThat(preview.path("files").get(i).path("state").asString()).isEqualTo("new");
        }
        JsonNode eleventh = preview.path("files").get(10);
        assertThat(eleventh.path("state").asString()).isEqualTo("error");
        assertThat(eleventh.path("problems").get(0).path("message").asString())
                .isEqualTo("this import would create more than 10 new series");
        assertThat(preview.path("newSeriesCount").asInt()).isEqualTo(10);
    }

    @Test
    void a_series_longer_than_the_cap_is_a_problem_without_the_name() throws Exception {
        MockMultipartFile file = markdown(
                "long.md",
                file("title: Long " + token, "slug: long-" + token, "series: " + "s".repeat(256), "series_part: 1"));

        JsonNode preview = preview(admin, file);

        assertThat(preview.path("files")
                        .get(0)
                        .path("problems")
                        .get(0)
                        .path("message")
                        .asString())
                .isEqualTo("the series is longer than 255 characters");
    }

    // --- Who may use series ----------------------------------------------------------------------------------

    @Test
    void for_an_author_the_series_keys_are_read_and_ignored_with_a_note_and_nothing_is_looked_up_or_written()
            throws Exception {
        String hidden = "Hidden saga " + token;
        // A series with that very name exists: the author's answer must not reveal it.
        seriesService.create(new SeriesRequest(hidden, null, null));
        MockMultipartFile file = named(hidden, "mine", 1, "A secret description.");

        ResultActions previewCall = previewCall(author, file);
        String body = responseBody(previewCall);
        JsonNode preview = objectMapper.readTree(body).path("data");
        JsonNode planned = preview.path("files").get(0);

        assertThat(planned.path("state").asString()).isEqualTo("new");
        assertThat(codes(planned.path("notes")).stream().filter(code -> code.startsWith("series_")))
                .containsExactly("series_ignored_author");
        assertThat(planned.path("changes").path("series").isNull()).isTrue();
        assertThat(planned.path("changes").path("seriesPart").isNull()).isTrue();
        assertThat(planned.path("newSeries").size()).isZero();
        assertThat(preview.path("newSeriesCount").asInt()).isZero();
        assertThat(body).doesNotContain(hidden).doesNotContain("A secret description.");

        String applied =
                responseBody(apply(author, manifest(preview, true), file).andExpect(status().isOk()));

        assertThat(applied).doesNotContain(hidden);
        assertThat(seriesCount(hidden)).isEqualTo(1);
        assertThat(seriesOf("mine-" + token)).isNull();
        assertThat(partOf("mine-" + token)).isNull();
        assertThat(jdbcTemplate.queryForObject(
                        "select author_id from posts where slug = ?", UUID.class, "mine-" + token))
                .isEqualTo(authorUser.getId());
    }

    @Test
    void an_author_who_updates_a_post_with_only_series_keys_changes_nothing() throws Exception {
        UUID mine = createPost(authorUser, "Mine " + token, "own-" + token);
        MockMultipartFile file = markdown(
                "own.md",
                file("title: Mine " + token, "slug: own-" + token, "series: " + seriesName, "series_part: 2"));

        JsonNode planned = preview(author, file).path("files").get(0);

        assertThat(planned.path("state").asString()).isEqualTo("unchanged");
        assertThat(codes(planned.path("notes"))).containsExactly("series_ignored_author", "category_missing");
        assertThat(seriesOf("own-" + token)).isNull();
        assertThat(mine).isNotNull();
    }

    // --- Draft members, moving, ownership ----------------------------------------------------------------------

    @Test
    void a_draft_member_joins_and_the_public_series_endpoints_hide_it_until_it_is_published() throws Exception {
        MockMultipartFile file = part("draft", 1);
        apply(admin, manifest(preview(admin, file), true), file).andExpect(status().isOk());
        String slug =
                jdbcTemplate.queryForObject("select slug from series where id = ?", String.class, seriesId(seriesName));

        mockMvc.perform(get("/api/v1/series/" + slug)).andExpect(status().isNotFound());
        assertThat(responseBody(mockMvc.perform(get("/api/v1/series")).andExpect(status().isOk())))
                .doesNotContain(slug);
        JsonNode adminDetail = data(mockMvc.perform(
                        get("/api/v1/admin/series/" + seriesId(seriesName)).header("Authorization", admin))
                .andExpect(status().isOk()));
        assertThat(adminDetail.path("posts").size()).isEqualTo(1);
        assertThat(adminDetail.path("posts").get(0).path("status").asString()).isEqualTo("DRAFT");

        publish("draft-" + token);

        JsonNode publicDetail =
                data(mockMvc.perform(get("/api/v1/series/" + slug)).andExpect(status().isOk()));
        assertThat(publicDetail.path("posts").size()).isEqualTo(1);
    }

    @Test
    void a_post_moves_to_another_series_and_the_log_keeps_where_it_was_as_ids_and_numbers() throws Exception {
        String otherName = "Other " + seriesName;
        MockMultipartFile inFirst = part("mover", 2);
        apply(admin, manifest(preview(admin, inFirst), true), inFirst).andExpect(status().isOk());
        UUID first = seriesId(seriesName);

        MockMultipartFile inOther = named(otherName, "mover", 1, null);
        JsonNode preview = preview(admin, inOther);
        JsonNode planned = preview.path("files").get(0);
        assertThat(planned.path("state").asString()).isEqualTo("will_change");
        assertThat(planned.path("changes").path("series").path("before").asString())
                .isEqualTo(seriesName);
        assertThat(planned.path("changes").path("series").path("after").asString())
                .isEqualTo(otherName);
        JsonNode applied = data(apply(admin, manifest(preview, true), inOther).andExpect(status().isOk()));

        UUID other = seriesId(otherName);
        assertThat(seriesOf("mover-" + token)).isEqualTo(other);
        assertThat(partOf("mover-" + token)).isEqualTo(1);
        assertThat(memberSlugsInOrder(first)).isEmpty();
        JsonNode item = logItem(applied.path("importId").asLong());
        assertThat(item.path("seriesId").asString()).isEqualTo(other.toString());
        assertThat(item.path("seriesCreated").asBoolean()).isTrue();
        assertThat(item.path("previousSeriesId").asString()).isEqualTo(first.toString());
        assertThat(item.path("previousSeriesPosition").asInt()).isEqualTo(1);
        assertThat(item.path("previousSeriesPart").asInt()).isEqualTo(2);
    }

    @Test
    void an_admin_import_into_the_post_of_an_author_keeps_the_owner() throws Exception {
        createPost(authorUser, "Owned " + token, "owned-" + token);
        MockMultipartFile file = markdown(
                "owned.md",
                file("title: Owned " + token, "slug: owned-" + token, "series: " + seriesName, "series_part: 1"));

        apply(admin, manifest(preview(admin, file), true), file).andExpect(status().isOk());

        assertThat(jdbcTemplate.queryForObject(
                        "select author_id from posts where slug = ?", UUID.class, "owned-" + token))
                .isEqualTo(authorUser.getId());
        assertThat(seriesOf("owned-" + token)).isEqualTo(seriesId(seriesName));
    }

    @Test
    void a_series_only_change_writes_no_revision_and_leaves_the_text_and_the_update_time_alone() throws Exception {
        createPost(adminUser, "Plain " + token, "plain-" + token);
        UUID id = postId("plain-" + token);
        String before = jdbcTemplate.queryForObject(
                "select concat_ws('|', title, content, updated_at) from posts where id = ?", String.class, id);
        MockMultipartFile file = markdown(
                "plain.md",
                file("title: Plain " + token, "slug: plain-" + token, "series: " + seriesName, "series_part: 4"));

        JsonNode preview = preview(admin, file);
        JsonNode planned = preview.path("files").get(0);
        assertThat(planned.path("state").asString()).isEqualTo("will_change");
        assertThat(planned.path("changes").path("contentDiffers").asBoolean()).isFalse();
        JsonNode applied = data(apply(admin, manifest(preview, true), file).andExpect(status().isOk()));

        assertThat(applied.path("updated").asInt()).isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from post_revisions where post_id = ?", Integer.class, id))
                .isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "select concat_ws('|', title, content, updated_at) from posts where id = ?", String.class, id))
                .isEqualTo(before);
        assertThat(partOf("plain-" + token)).isEqualTo(4);
        assertThat(logItem(applied.path("importId").asLong())
                        .path("previousRevisionId")
                        .isNull())
                .isTrue();
    }

    // --- Nothing about a series in a log or a refusal ---------------------------------------------------------

    @Test
    void the_log_and_the_answers_of_an_apply_hold_no_series_name() throws Exception {
        MockMultipartFile file = named(seriesName, "logged", 1, "A description for the log.");
        JsonNode preview = preview(admin, file);
        ResultActions result = apply(admin, manifest(preview, true), file);

        String applied = responseBody(result);
        JsonNode body = objectMapper.readTree(applied).path("data");
        String items = jdbcTemplate.queryForObject(
                "select cast(items as text) from post_import_log where id = ?",
                String.class,
                body.path("importId").asLong());
        String hashes = jdbcTemplate.queryForObject(
                "select cast(file_hashes as text) from post_import_log where id = ?",
                String.class,
                body.path("importId").asLong());

        assertThat(applied).doesNotContain(seriesName).doesNotContain("A description for the log.");
        assertThat(items).doesNotContain(seriesName).doesNotContain("A description for the log.");
        assertThat(hashes).doesNotContain(seriesName);
        JsonNode item = logItem(body.path("importId").asLong());
        assertThat(item.path("seriesId").asString())
                .isEqualTo(seriesId(seriesName).toString());
        assertThat(item.path("seriesCreated").asBoolean()).isTrue();
        assertThat(item.path("previousSeriesId").isNull()).isTrue();
        assertThat(responseBody(statusCall(admin))).doesNotContain(seriesName);
    }

    @Test
    void a_file_without_series_keys_is_imported_as_before_and_reads_no_series() throws Exception {
        MockMultipartFile file =
                markdown("plain-new.md", file("title: Plain new " + token, "slug: plain-new-" + token));

        JsonNode preview = preview(admin, file);
        JsonNode planned = preview.path("files").get(0);

        assertThat(planned.path("state").asString()).isEqualTo("new");
        assertThat(planned.path("changes").path("series").isNull()).isTrue();
        assertThat(planned.path("changes").path("seriesPart").isNull()).isTrue();
        assertThat(planned.path("newSeries").size()).isZero();
        assertThat(codes(planned.path("notes")).stream().filter(code -> code.startsWith("series_")))
                .isEmpty();
        apply(admin, manifest(preview, true), file).andExpect(status().isOk());
        assertThat(seriesOf("plain-new-" + token)).isNull();
        // An update of a post that is in a series, by a file without series keys, leaves it where it is.
        MockMultipartFile member = part("stays", 5);
        apply(admin, manifest(preview(admin, member), true), member).andExpect(status().isOk());
        MockMultipartFile edited =
                markdown("stays.md", file("title: Stays " + token + " edited", "slug: stays-" + token));
        apply(admin, manifest(preview(admin, edited), true), edited).andExpect(status().isOk());
        assertThat(partOf("stays-" + token)).isEqualTo(5);
        assertThat(seriesOf("stays-" + token)).isEqualTo(seriesId(seriesName));
    }

    @Test
    void a_refusal_of_the_series_service_leaves_no_series_text_in_an_answer_a_log_line_or_the_import_log()
            throws Exception {
        String marker = "Okapi-Marker-" + token;
        String lower = marker.toLowerCase(Locale.ROOT);
        String name = "Series " + marker;
        MockMultipartFile file = named(name, "refused", 1, "Description " + marker);
        String manifest = manifest(preview(admin, file), true);
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Logger imports = (Logger) LoggerFactory.getLogger("com.blog.postimport");
        Level previous = imports.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        imports.setLevel(Level.DEBUG);
        List<String> answers = new ArrayList<>();
        String success;
        try {
            // The service refuses to create the series, with the name in its own message.
            doThrow(new ApiException(ErrorCode.SERIES_ALREADY_EXISTS, HttpStatus.CONFLICT, marker))
                    .when(seriesService)
                    .create(any(SeriesRequest.class));
            ResultActions create = apply(admin, manifest, file);
            assertError(create, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
            answers.add(responseBody(create));
            reset(seriesService);

            // The series is created, then the service refuses to place the post.
            doThrow(new ApiException(ErrorCode.SERIES_NOT_FOUND, HttpStatus.NOT_FOUND, marker))
                    .when(seriesService)
                    .placeByPart(any(UUID.class), any(UUID.class), anyInt());
            ResultActions place = apply(admin, manifest, file);
            assertError(place, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
            answers.add(responseBody(place));
            reset(seriesService);

            // Nothing of either attempt stayed.
            assertThat(seriesCount(name)).isZero();
            assertThat(postCount("refused-" + token)).isZero();

            success = responseBody(apply(admin, manifest, file).andExpect(status().isOk()));
        } finally {
            root.detachAppender(logs);
            imports.setLevel(previous);
        }

        assertThat(logs.list.stream()
                        .filter(event -> event.getFormattedMessage().startsWith("post import write refused code=")))
                .hasSize(2);
        LogAssertions.assertNoValues(logs.list, marker, lower);
        for (String body : answers) {
            assertThat(body).isNotEmpty().doesNotContain(marker, lower);
        }
        assertThat(success).doesNotContain(marker, lower);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from post_import_log where cast(items as text) ilike ? or cast(file_hashes as text) ilike ?",
                        Integer.class,
                        "%" + marker + "%",
                        "%" + marker + "%"))
                .isZero();
        assertThat(seriesCount(name)).isEqualTo(1);
    }

    // --- The demo packages ------------------------------------------------------------------------------------

    private static final Path DEMO_FIXTURES = Path.of("..", "fixtures", "article-packages");
    private static final Path DEMO_ACCENT_FIXTURES = Path.of("..", "fixtures", "vi", "article-packages");
    private static final List<String> DEMO_SLUGS = List.of(
            "blocks-demo-series-queues-1",
            "blocks-demo-series-queues-2",
            "blocks-demo-series-queues-3",
            "blocks-demo-series-queues-accents");
    private static final String DEMO_SERIES_SLUG = "queues-in-practice";

    private static MockMultipartFile demoPackage(Path folder) throws IOException {
        byte[] archive = ZipPackages.zip()
                .add("article.md", Files.readAllBytes(folder.resolve("article.md")))
                .build();
        return new MockMultipartFile("file", folder.getFileName() + ".zip", "application/zip", archive);
    }

    /** The demo posts have fixed slugs and one fixed series: the shared database must not keep them between runs. */
    private void removeDemoPosts() {
        DEMO_SLUGS.forEach(slug -> jdbcTemplate.update("delete from posts where slug = ?", slug));
        jdbcTemplate.update("delete from series where slug = ?", DEMO_SERIES_SLUG);
        jdbcTemplate.update("delete from post_import_log where created_by = ?", adminUser.getId());
    }

    @Test
    void the_demo_series_packages_imported_as_part_3_1_2_then_the_accented_one_make_one_series_in_part_order()
            throws Exception {
        removeDemoPosts();
        try {
            List<MockMultipartFile> order = List.of(
                    demoPackage(DEMO_FIXTURES.resolve("series-queues-part-3")),
                    demoPackage(DEMO_FIXTURES.resolve("series-queues-part-1")),
                    demoPackage(DEMO_FIXTURES.resolve("series-queues-part-2")),
                    demoPackage(DEMO_ACCENT_FIXTURES.resolve("series-queues-accents")));
            for (int i = 0; i < order.size(); i++) {
                JsonNode preview = preview(admin, order.get(i));
                JsonNode planned = preview.path("files").get(0);
                assertThat(planned.path("state").asString()).isEqualTo("new");
                assertThat(planned.path("problems").size()).isZero();
                // Only the first file to arrive announces the series.
                assertThat(codes(planned.path("notes")).contains("series_will_be_created"))
                        .isEqualTo(i == 0);
                apply(admin, manifest(preview, true), order.get(i)).andExpect(status().isOk());
            }

            assertThat(jdbcTemplate.queryForObject(
                            "select count(*) from series where slug = ?", Integer.class, DEMO_SERIES_SLUG))
                    .isEqualTo(1);
            assertThat(jdbcTemplate.queryForObject(
                            "select count(*) from series where slug = ?", Integer.class, DEMO_SERIES_SLUG + "-2"))
                    .isZero();
            UUID series =
                    jdbcTemplate.queryForObject("select id from series where slug = ?", UUID.class, DEMO_SERIES_SLUG);
            assertThat(memberSlugsInOrder(series))
                    .containsExactly(
                            "blocks-demo-series-queues-1",
                            "blocks-demo-series-queues-2",
                            "blocks-demo-series-queues-3",
                            "blocks-demo-series-queues-accents");
            assertThat(partsInOrder(series)).containsExactly(1, 2, 3, 4);
        } finally {
            removeDemoPosts();
        }
    }

    // --- The preview and the apply agree ----------------------------------------------------------------------

    @Test
    void a_series_that_appears_after_the_preview_made_it_is_a_conflict_and_nothing_is_written() throws Exception {
        MockMultipartFile file = part("raced", 1);
        JsonNode preview = preview(admin, file);
        assertThat(codes(preview.path("files").get(0).path("notes"))).contains("series_will_be_created");
        seriesService.create(new SeriesRequest(seriesName, null, null));

        ResultActions result = apply(admin, manifest(preview, true), file);

        assertError(result, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(postCount("raced-" + token)).isZero();
    }

    @Test
    void an_admin_reorder_after_the_preview_makes_the_update_a_conflict() throws Exception {
        MockMultipartFile[] files = {part("a", 1), part("b", 2)};
        apply(admin, manifest(preview(admin, files), true, true), files).andExpect(status().isOk());
        MockMultipartFile edited = markdown(
                "a.md",
                file(
                        "title: Part a " + token + " changed",
                        "slug: a-" + token,
                        "series: " + seriesName,
                        "series_part: 1"));
        JsonNode preview = preview(admin, edited);
        UUID series = seriesId(seriesName);
        mockMvc.perform(put("/api/v1/admin/series/" + series + "/posts")
                        .header("Authorization", admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("postIds", List.of(postId("b-" + token), postId("a-" + token))))))
                .andExpect(status().isOk());

        assertError(apply(admin, manifest(preview, true), edited), 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");

        // The admin's reorder kept the declared parts.
        assertThat(partsInOrder(series)).containsExactly(2, 1);
    }

    // --- Locks -----------------------------------------------------------------------------------------------

    @Test
    void two_imports_of_the_same_new_series_at_once_one_wins_and_the_other_is_a_clean_conflict() throws Exception {
        MockMultipartFile first = part("race-a", 1);
        MockMultipartFile second = part("race-b", 2);
        String firstManifest = manifest(preview(admin, first), true);
        String secondManifest = manifest(preview(admin, second), true);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Integer> statuses = new ArrayList<>();
        try (HeldTransaction held = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForObject(
                        "select 1 from pg_advisory_xact_lock(hashtextextended('post-import', 0))", Integer.class))) {
            Future<Integer> a = pool.submit(() ->
                    apply(admin, firstManifest, first).andReturn().getResponse().getStatus());
            Future<Integer> b = pool.submit(() -> apply(admin, secondManifest, second)
                    .andReturn()
                    .getResponse()
                    .getStatus());
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "pg_advisory_xact_lock", 2);

            held.commit();

            statuses.add(a.get(60, TimeUnit.SECONDS));
            statuses.add(b.get(60, TimeUnit.SECONDS));
        } finally {
            pool.shutdownNow();
        }

        assertThat(statuses).containsExactlyInAnyOrder(200, 409);
        assertThat(seriesCount(seriesName)).isEqualTo(1);
        assertThat(postCount("race-a-" + token) + postCount("race-b-" + token)).isEqualTo(1);
        UUID series = seriesId(seriesName);
        assertThat(memberSlugsInOrder(series)).hasSize(1);
    }

    @Test
    void an_import_racing_an_admin_series_save_waits_for_the_same_first_lock_and_neither_deadlocks() throws Exception {
        UUID series =
                seriesService.create(new SeriesRequest(seriesName, null, null)).id();
        UUID member = createPost(adminUser, "Member " + token, "member-" + token);
        seriesService.placeByPart(series, member, 1);
        MockMultipartFile file = part("joiner", 2);
        String manifest = manifest(preview(admin, file), true);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Integer> statuses = new ArrayList<>();
        try (HeldTransaction held = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForObject(
                        "select 1 from pg_advisory_xact_lock(" + PostRepository.TRANSLATION_LOCK_KEY + ")",
                        Integer.class))) {
            Future<Integer> importing = pool.submit(
                    () -> apply(admin, manifest, file).andReturn().getResponse().getStatus());
            Future<Integer> saving = pool.submit(() -> mockMvc.perform(put("/api/v1/admin/series/" + series + "/posts")
                            .header("Authorization", admin)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of("postIds", List.of(member)))))
                    .andReturn()
                    .getResponse()
                    .getStatus());
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "pg_advisory_xact_lock", 2);

            held.commit();

            statuses.add(importing.get(60, TimeUnit.SECONDS));
            statuses.add(saving.get(60, TimeUnit.SECONDS));
        } finally {
            pool.shutdownNow();
        }

        assertThat(statuses).containsExactly(200, 200);
        assertThat(postCount("joiner-" + token)).isEqualTo(1);
        assertThat(memberSlugsInOrder(series)).contains("member-" + token);
    }

    @Test
    void an_apply_takes_the_series_row_after_the_two_advisory_locks_and_before_any_post_row() throws Exception {
        UUID series =
                seriesService.create(new SeriesRequest(seriesName, null, null)).id();
        createPost(adminUser, "Target " + token, "target-" + token);
        UUID target = postId("target-" + token);
        MockMultipartFile file = markdown(
                "target.md",
                file("title: Target " + token, "slug: target-" + token, "series: " + seriesName, "series_part: 2"));
        String manifest = manifest(preview(admin, file), true);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction held = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForObject("select id from series where id = ? for update", UUID.class, series))) {
            Future<Integer> running = pool.submit(
                    () -> apply(admin, manifest, file).andReturn().getResponse().getStatus());
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "from series", 1);

            // Stopped at the series row: both advisory locks are the apply's already, and no post row is.
            assertThat(jdbcTemplate.queryForObject(
                            "select pg_try_advisory_xact_lock(" + PostRepository.TRANSLATION_LOCK_KEY + ")",
                            Boolean.class))
                    .isFalse();
            assertThat(jdbcTemplate.queryForObject(
                            "select pg_try_advisory_xact_lock(hashtextextended('post-import', 0))", Boolean.class))
                    .isFalse();
            assertThat(jdbcTemplate.queryForList(
                            "select id from posts where id = ? for update nowait", UUID.class, target))
                    .containsExactly(target);
            assertThat(running.isDone()).isFalse();

            held.commit();

            assertThat(running.get(60, TimeUnit.SECONDS)).isEqualTo(200);
        } finally {
            pool.shutdownNow();
        }
        assertThat(seriesOf("target-" + token)).isEqualTo(series);
        assertThat(partOf("target-" + token)).isEqualTo(2);
    }

    @Test
    void a_zip_package_joins_a_series_like_a_markdown_file_and_its_images_are_stored() throws Exception {
        byte[] bytes = ZipPackages.zip()
                .add(
                        "article.md",
                        ZipPackages.article(
                                "![Alt](assets/one.png)\n",
                                "title: Packed " + token,
                                "slug: packed-" + token,
                                "series: " + seriesName,
                                "series_part: 3"))
                .add("assets/one.png", ZipPackages.image("opaque.png"))
                .build();
        MockMultipartFile upload = new MockMultipartFile("file", "packed.zip", "application/zip", bytes);

        JsonNode preview = preview(admin, upload);
        assertThat(codes(preview.path("files").get(0).path("notes"))).contains("series_will_be_created");
        apply(admin, manifest(preview, true), upload).andExpect(status().isOk());

        UUID series = seriesId(seriesName);
        assertThat(seriesOf("packed-" + token)).isEqualTo(series);
        assertThat(partOf("packed-" + token)).isEqualTo(3);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from media where post_id = ?", Integer.class, postId("packed-" + token)))
                .isEqualTo(1);
    }

    @Test
    void a_series_description_alone_is_ignored_with_a_note_for_an_admin_and_for_an_author() throws Exception {
        MockMultipartFile file = markdown(
                "d.md",
                file("title: D " + token, "slug: d-" + token, "series_description: A description with no series."));

        for (String bearer : List.of(admin, author)) {
            JsonNode planned = preview(bearer, file).path("files").get(0);
            assertThat(planned.path("state").asString()).isEqualTo("new");
            assertThat(codes(planned.path("notes")).stream().filter(code -> code.startsWith("series_")))
                    .hasSize(1);
        }
        assertThat(codes(preview(admin, file).path("files").get(0).path("notes")))
                .contains("series_description_ignored");
        assertThat(codes(preview(author, file).path("files").get(0).path("notes")))
                .contains("series_ignored_author");
    }

    @Test
    void a_file_that_names_another_series_without_a_part_is_a_problem_even_for_a_member() throws Exception {
        MockMultipartFile member = part("member", 2);
        apply(admin, manifest(preview(admin, member), true), member).andExpect(status().isOk());
        String other = "Elsewhere " + seriesName;
        seriesService.create(new SeriesRequest(other, null, null));
        MockMultipartFile file =
                markdown("member.md", file("title: Part member " + token, "slug: member-" + token, "series: " + other));

        JsonNode planned = preview(admin, file).path("files").get(0);

        assertThat(planned.path("state").asString()).isEqualTo("error");
        assertThat(planned.path("problems").get(0).path("message").asString()).isEqualTo("series needs series_part");
    }

    // --- Helpers ---------------------------------------------------------------------------------------------

    /** A file for the test's series with the slug {@code name-token}, at the given part. */
    private MockMultipartFile part(String name, int part) {
        return named(seriesName, name, part, null);
    }

    private MockMultipartFile named(String series, String name, int part, String description) {
        return named(series, name, part, description, null);
    }

    private MockMultipartFile named(String series, String name, int part, String description, String language) {
        List<String> lines = new ArrayList<>(
                List.of("title: Part " + name + " " + token, "slug: " + name + "-" + token, "series: " + series));
        lines.add("series_part: " + part);
        if (description != null) {
            lines.add("series_description: " + description);
        }
        if (language != null) {
            lines.add("language: " + language);
        }
        return markdown(name + ".md", file(lines.toArray(String[]::new)));
    }

    private static String slugOf(String name) {
        return com.blog.common.util.SlugGenerator.slugify(name);
    }

    private int seriesCount(String name) {
        return jdbcTemplate.queryForObject(
                "select count(*) from series where lower(title) = lower(?)", Integer.class, name);
    }

    private UUID seriesId(String name) {
        return jdbcTemplate.queryForObject("select id from series where lower(title) = lower(?)", UUID.class, name);
    }

    private String descriptionOf(UUID series) {
        return jdbcTemplate.queryForObject("select description from series where id = ?", String.class, series);
    }

    private List<String> memberSlugsInOrder(UUID series) {
        return jdbcTemplate.queryForList(
                "select slug from posts where series_id = ? order by series_position", String.class, series);
    }

    private List<Integer> partsInOrder(UUID series) {
        return jdbcTemplate.queryForList(
                "select series_part from posts where series_id = ? order by series_position", Integer.class, series);
    }

    private List<Integer> positionsInOrder(UUID series) {
        return jdbcTemplate.queryForList(
                "select series_position from posts where series_id = ? order by series_position",
                Integer.class,
                series);
    }

    private UUID seriesOf(String slug) {
        return jdbcTemplate.queryForObject("select series_id from posts where slug = ?", UUID.class, slug);
    }

    private Integer partOf(String slug) {
        return jdbcTemplate.queryForObject("select series_part from posts where slug = ?", Integer.class, slug);
    }

    private String statusOf(String slug) {
        return jdbcTemplate.queryForObject("select status from posts where slug = ?", String.class, slug);
    }

    private void publish(String slug) {
        jdbcTemplate.update("update posts set status = 'PUBLISHED', published_at = now() where slug = ?", slug);
    }

    private UUID createPost(User owner, String title, String slug) {
        return postService
                .create(
                        owner.getId(),
                        new PostCreateRequest(title, null, "The stored body.\n", null, Set.of(), slug, null))
                .id();
    }

    private int postCount(String slug) {
        return jdbcTemplate.queryForObject("select count(*) from posts where slug = ?", Integer.class, slug);
    }

    private UUID postId(String slug) {
        return jdbcTemplate.queryForObject("select id from posts where slug = ?", UUID.class, slug);
    }

    private long logCount(User user) {
        return jdbcTemplate.queryForObject(
                "select count(*) from post_import_log where created_by = ?", Long.class, user.getId());
    }

    private JsonNode logItem(long importId) throws Exception {
        String items = jdbcTemplate.queryForObject(
                "select cast(items as text) from post_import_log where id = ?", String.class, importId);
        return objectMapper.readTree(items).get(0);
    }

    private static List<String> codes(JsonNode notes) {
        List<String> codes = new ArrayList<>();
        notes.forEach(note -> codes.add(note.path("code").asString()));
        return codes;
    }

    /** A file whose first argument ends with a line break is given that body; the default body otherwise. */
    private static String file(String... frontMatter) {
        return "---\n" + String.join("\n", Arrays.asList(frontMatter)) + "\n---\n\nThe stored body.\n";
    }

    private static MockMultipartFile markdown(String name, String text) {
        return new MockMultipartFile("file", name, "text/markdown", text.getBytes(UTF_8));
    }

    private ResultActions previewCall(String bearer, MockMultipartFile... files) throws Exception {
        MockMultipartHttpServletRequestBuilder request = multipart(BASE + "/preview");
        for (MockMultipartFile file : files) {
            request.file(file);
        }
        request.header("Authorization", bearer);
        return mockMvc.perform(request).andExpect(status().isOk());
    }

    private JsonNode preview(String bearer, MockMultipartFile... files) throws Exception {
        return data(previewCall(bearer, files));
    }

    /** The manifest the page builds from a preview: the hash, the selection and the opaque state of every file. */
    private String manifest(JsonNode preview, boolean... selected) {
        ArrayNode items = objectMapper.createArrayNode();
        for (int i = 0; i < preview.path("files").size(); i++) {
            JsonNode file = preview.path("files").get(i);
            ObjectNode item = items.addObject();
            item.put("sha256", file.path("sha256").asString());
            item.put("selected", selected[i]);
            if (file.path("previewState").isNull()) {
                item.putNull("state");
            } else {
                item.put("state", file.path("previewState").asString());
            }
        }
        return objectMapper.writeValueAsString(items);
    }

    private ResultActions apply(String bearer, String manifest, MockMultipartFile... files) throws Exception {
        MockMultipartHttpServletRequestBuilder request = multipart(BASE + "/apply");
        for (MockMultipartFile file : files) {
            request.file(file);
        }
        request.param("manifest", manifest);
        request.header("Authorization", bearer);
        return mockMvc.perform(request);
    }

    private ResultActions statusCall(String bearer) throws Exception {
        return mockMvc.perform(get(BASE + "/status").header("Authorization", bearer));
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
}
