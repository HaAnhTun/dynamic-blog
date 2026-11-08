package com.blog.series;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.fail;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.post.repository.PostRepository;
import com.blog.series.service.SeriesService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Series: the public page in reading order, admin only for ADMIN, and members are written ONLY through
 * {@code PUT /api/v1/admin/series/{id}/posts} (replaces the whole list, positions 1..n in the order sent).
 *
 * The public side only sees what is published: a series made only of unpublished posts does not exist for readers, and "Part
 * n/m" counts over the published parts instead of reading the stored position (positions have gaps).
 *
 * Every request goes through the real filter chain with a real token: series admin access is a URL rule, and a test that
 * presets a SecurityContext would pass even if that rule were deleted.
 *
 * The shared DB is never cleaned: every name has a random suffix; series lists (public and admin) are only
 * checked for "present"/"absent" and for relative order among the test's own series, never for length. Post
 * text avoids every word that PostSearchAndFeaturedIT searches for.
 */
@AutoConfigureMockMvc
class SeriesIT extends AbstractIntegrationTest {

    private static final String ADMIN_SERIES = "/api/v1/admin/series";
    private static final String PUBLIC_SERIES = "/api/v1/series";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private SeriesService seriesService;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private String admin;
    private String suffix;
    private UUID categoryId;

    /** A post of the test: the id to assign into a series; the slug and name to compare with what the series returns. */
    private record Fixture(UUID id, String slug, String title) {}

    @BeforeEach
    void setUp() throws Exception {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
        JsonNode category = data(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"Category series " + UUID.randomUUID() + "\"}"))
                .andExpect(status().isCreated()));
        categoryId = UUID.fromString(category.path("id").asString());
    }

    // --- Create, edit ------------------------------------------------------------------------------

    @Test
    void create_series_returns_201_slug_derived_from_name_and_new_series_without_posts_is_in_admin_list()
            throws Exception {
        String title = "Created Series " + suffix;

        JsonNode created = data(createSeries(Map.of("title", "  " + title + "  ", "description", "  Description.  "))
                .andExpect(status().isCreated()));

        UUID id = idOf(created);
        assertThat(created.path("title").asString()).isEqualTo(title);
        assertThat(created.path("slug").asString()).isEqualTo("created-series-" + suffix);
        assertThat(created.path("description").asString()).isEqualTo("Description.");
        assertThat(created.path("posts").isArray()).isTrue();
        assertThat(created.path("posts").size()).isZero();
        assertThat(Instant.parse(created.path("createdAt").asString())).isNotNull();
        assertThat(Instant.parse(created.path("updatedAt").asString())).isNotNull();

        JsonNode detail = adminSeries(id);
        assertThat(detail.path("title").asString()).isEqualTo(title);
        assertThat(detail.path("slug").asString()).isEqualTo("created-series-" + suffix);
        // The admin list also contains series that have no posts yet: that is the only place to add posts to it.
        assertThat(idsOf(data(mockMvc.perform(get(ADMIN_SERIES).header("Authorization", admin))
                        .andExpect(status().isOk()))))
                .contains(id.toString());
    }

    @Test
    void name_collision_ignoring_case_is_409_on_create_and_edit_but_changing_case_of_own_name_is_allowed()
            throws Exception {
        String title = "Duplicate Name " + suffix;
        UUID first = idOf(data(createSeries(Map.of("title", title)).andExpect(status().isCreated())));
        // Control: a different name can be created.
        UUID second =
                idOf(data(createSeries(Map.of("title", "Other Name " + suffix)).andExpect(status().isCreated())));

        assertError(createSeries(Map.of("title", title.toUpperCase(Locale.ROOT))), 409, "SERIES_ALREADY_EXISTS");
        assertError(
                updateSeries(second, Map.of("title", title.toLowerCase(Locale.ROOT))), 409, "SERIES_ALREADY_EXISTS");
        assertThat(adminSeries(second).path("title").asString()).isEqualTo("Other Name " + suffix);

        // Changing only the letter case of its own name does not collide with any other series.
        JsonNode renamed = data(updateSeries(first, Map.of("title", title.toUpperCase(Locale.ROOT)))
                .andExpect(status().isOk()));
        assertThat(renamed.path("title").asString()).isEqualTo(title.toUpperCase(Locale.ROOT));
    }

    @Test
    void sent_slug_is_normalized_collision_adds_suffix_and_blank_slug_on_edit_keeps_old_slug() throws Exception {
        String slug = "own-path-" + suffix;
        JsonNode created = data(createSeries(Map.of("title", "Own Slug " + suffix, "slug", "Own Path " + suffix))
                .andExpect(status().isCreated()));
        assertThat(created.path("slug").asString()).isEqualTo(slug);
        // The slug is already used by another series: add a suffix, no 409 (whether it collides is decided by the
        // name).
        JsonNode twin = data(createSeries(Map.of("title", "Same Slug " + suffix, "slug", slug))
                .andExpect(status().isCreated()));
        assertThat(twin.path("slug").asString()).isEqualTo(slug + "-2");

        UUID id = idOf(created);
        // PUT replaces the whole name and description; an empty or unsent slug keeps the old slug: renaming must not
        // change
        // the public URL /series/{slug}.
        Map<String, Object> blankSlug = new HashMap<>();
        blankSlug.put("title", "Edited Name " + suffix);
        blankSlug.put("slug", "  ");
        blankSlug.put("description", null);
        JsonNode updated = data(updateSeries(id, blankSlug).andExpect(status().isOk()));
        assertThat(updated.path("title").asString()).isEqualTo("Edited Name " + suffix);
        assertThat(updated.path("slug").asString()).isEqualTo(slug);
        assertThat(updated.path("description").isNull()).isTrue();

        JsonNode withoutSlug =
                data(updateSeries(id, Map.of("title", "Second Edit Name " + suffix, "description", "New description"))
                        .andExpect(status().isOk()));
        assertThat(withoutSlug.path("slug").asString()).isEqualTo(slug);
        assertThat(withoutSlug.path("description").asString()).isEqualTo("New description");

        // Control: a sent slug does change, after normalization. An unsent description means the description is cleared
        // (full replacement).
        JsonNode newSlug =
                data(updateSeries(id, Map.of("title", "Second Edit Name " + suffix, "slug", "New Slug " + suffix))
                        .andExpect(status().isOk()));
        assertThat(newSlug.path("slug").asString()).isEqualTo("new-slug-" + suffix);
        assertThat(newSlug.path("description").isNull()).isTrue();
        assertThat(adminSeries(id).path("slug").asString()).isEqualTo("new-slug-" + suffix);
    }

    @Test
    void invalid_request_body_is_400_VALIDATION_ERROR() throws Exception {
        assertError(createSeries(Map.of("title", "   ")), 400, "VALIDATION_ERROR");
        assertError(
                createSeries(Map.of("title", "Long description " + suffix, "description", "x".repeat(2001))),
                400,
                "VALIDATION_ERROR");

        UUID id =
                idOf(data(createSeries(Map.of("title", "Body check " + suffix)).andExpect(status().isCreated())));
        assertError(putPosts(id, "{}"), 400, "VALIDATION_ERROR");
        assertError(putPosts(id, "{\"postIds\":[null]}"), 400, "VALIDATION_ERROR");
        List<UUID> tooMany =
                IntStream.range(0, 101).mapToObj(i -> UUID.randomUUID()).toList();
        assertError(setPosts(id, tooMany), 400, "VALIDATION_ERROR");
        // Control: an empty list is valid (removes every post from the series).
        mockMvc.perform(put(ADMIN_SERIES + "/" + id + "/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"postIds\":[]}"))
                .andExpect(status().isOk());
    }

    @Test
    void nonexistent_series_is_404_SERIES_NOT_FOUND() throws Exception {
        UUID missing = UUID.randomUUID();

        assertError(
                mockMvc.perform(get(ADMIN_SERIES + "/" + missing).header("Authorization", admin)),
                404,
                "SERIES_NOT_FOUND");
        assertError(updateSeries(missing, Map.of("title", "Missing " + suffix)), 404, "SERIES_NOT_FOUND");
        assertError(setPosts(missing, List.of()), 404, "SERIES_NOT_FOUND");
        assertError(
                mockMvc.perform(delete(ADMIN_SERIES + "/" + missing).header("Authorization", admin)),
                404,
                "SERIES_NOT_FOUND");
        assertError(mockMvc.perform(get(PUBLIC_SERIES + "/khong-co-series-" + suffix)), 404, "SERIES_NOT_FOUND");
    }

    // --- Members -----------------------------------------------------------------------------------

    @Test
    void assign_posts_in_list_order_and_later_assignment_replaces_earlier_one_entirely() throws Exception {
        Fixture first = createPost("First part");
        Fixture second = createPost("Second part");
        Fixture third = createPost("Third part");
        publish(third);
        UUID series = idOf(data(createSeries(Map.of("title", "Order " + suffix)).andExpect(status().isCreated())));

        JsonNode assigned = data(setPosts(series, ids(second, first, third)).andExpect(status().isOk()));

        // The order is the order sent, not the creation order; every status is present.
        assertMembers(assigned, second, first, third);
        assertThat(positionsOf(assigned)).containsExactly(1, 2, 3);
        assertThat(statusesOf(assigned)).containsExactly("DRAFT", "DRAFT", "PUBLISHED");
        assertMembers(adminSeries(series), second, first, third);
        // The post side sees the same thing through the post read model.
        JsonNode ref = adminPost(first.id()).path("series");
        assertThat(ref.path("id").asString()).isEqualTo(series.toString());
        assertThat(ref.path("position").asInt()).isEqualTo(2);

        // A later assignment replaces the earlier one entirely: a post missing from the list is removed from the
        // series, the remaining ones are renumbered.
        JsonNode replaced = data(setPosts(series, ids(third, first)).andExpect(status().isOk()));
        assertMembers(replaced, third, first);
        assertThat(positionsOf(replaced)).containsExactly(1, 2);
        assertThat(adminPost(second.id()).path("series").isNull()).isTrue();
        assertThat(adminPost(third.id()).path("series").path("position").asInt())
                .isEqualTo(1);

        // An empty list removes every post; the series remains.
        assertMembers(data(setPosts(series, List.of()).andExpect(status().isOk())));
        assertThat(adminPost(first.id()).path("series").isNull()).isTrue();
        assertThat(adminPost(third.id()).path("series").isNull()).isTrue();
        assertThat(adminSeries(series).path("id").asString()).isEqualTo(series.toString());
    }

    @Test
    void assigning_post_from_another_series_moves_it_and_old_series_loses_it() throws Exception {
        Fixture moving = createPost("Part to move");
        Fixture staying = createPost("Part that stays");
        UUID from = idOf(
                data(createSeries(Map.of("title", "Source Series " + suffix)).andExpect(status().isCreated())));
        UUID to = idOf(
                data(createSeries(Map.of("title", "Target Series " + suffix)).andExpect(status().isCreated())));
        setPosts(from, ids(moving, staying)).andExpect(status().isOk());

        JsonNode target = data(setPosts(to, ids(moving)).andExpect(status().isOk()));

        assertMembers(target, moving);
        assertThat(adminPost(moving.id()).path("series").path("id").asString()).isEqualTo(to.toString());
        // The old series loses that post and keeps a gap at position 1: harmless, "Part n/m" is recounted at read time.
        JsonNode source = adminSeries(from);
        assertMembers(source, staying);
        assertThat(positionsOf(source)).containsExactly(2);
    }

    @Test
    void list_with_duplicate_id_is_400_and_members_stay_unchanged() throws Exception {
        Fixture member = createPost("Existing part");
        Fixture other = createPost("Part sent twice");
        UUID series = idOf(
                data(createSeries(Map.of("title", "Duplicate id " + suffix)).andExpect(status().isCreated())));
        setPosts(series, ids(member)).andExpect(status().isOk());

        assertError(setPosts(series, ids(other, other)), 400, "VALIDATION_ERROR");

        assertMembers(adminSeries(series), member);
        assertThat(adminPost(other.id()).path("series").isNull()).isTrue();
    }

    @Test
    void unknown_post_id_is_400_POST_NOT_FOUND_and_nothing_is_written_halfway() throws Exception {
        Fixture member = createPost("Existing part");
        Fixture other = createPost("Part sent with an unknown id");
        UUID series =
                idOf(data(createSeries(Map.of("title", "Unknown id " + suffix)).andExpect(status().isCreated())));
        setPosts(series, ids(member)).andExpect(status().isOk());

        // An unknown id at the END of the list: if the write is not wholly inside one transaction, by the time it is
        // reached the series has had
        // all its posts removed and the earlier post has already been assigned.
        assertError(setPosts(series, List.of(other.id(), UUID.randomUUID())), 400, "POST_NOT_FOUND");

        assertMembers(adminSeries(series), member);
        assertThat(adminPost(other.id()).path("series").isNull()).isTrue();
    }

    @Test
    void full_post_put_does_not_remove_post_from_series() throws Exception {
        Fixture first = createPost("First part kept");
        Fixture edited = createPost("Part to be edited");
        UUID series =
                idOf(data(createSeries(Map.of("title", "Edit post " + suffix)).andExpect(status().isCreated())));
        setPosts(series, ids(first, edited)).andExpect(status().isOk());

        // A full PUT body as the editor sends it: no key about the series, and a post PUT is still a full replacement.
        JsonNode before = adminPost(edited.id());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", before.path("title").asString() + " (edited)");
        body.put("excerpt", before.path("excerpt").asString());
        body.put("content", before.path("content").asString());
        body.put("categoryId", before.path("category").path("id").asString());
        body.put("tagIds", List.of());
        body.put("slug", before.path("slug").asString());
        JsonNode updated = data(mockMvc.perform(put("/api/v1/admin/posts/" + edited.id())
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk()));

        // Control: the PUT took effect...
        assertThat(updated.path("title").asString()).endsWith("(edited)");
        // ...and the post is still in the right series, at the right position.
        assertThat(updated.path("series").path("id").asString()).isEqualTo(series.toString());
        assertThat(updated.path("series").path("position").asInt()).isEqualTo(2);
        assertMembers(
                adminSeries(series),
                first,
                new Fixture(edited.id(), edited.slug(), updated.path("title").asString()));
    }

    @Test
    void assign_move_remove_post_and_delete_series_do_not_change_post_updatedAt_while_publish_does() throws Exception {
        Fixture part = createPost("Part keeping its edit date");
        UUID first = idOf(
                data(createSeries(Map.of("title", "Keep edit date A " + suffix)).andExpect(status().isCreated())));
        UUID second = idOf(
                data(createSeries(Map.of("title", "Keep edit date B " + suffix)).andExpect(status().isCreated())));
        Instant before = updatedAt(part);

        setPosts(first, ids(part)).andExpect(status().isOk());
        setPosts(second, ids(part)).andExpect(status().isOk());
        setPosts(second, List.of()).andExpect(status().isOk());
        setPosts(first, ids(part)).andExpect(status().isOk());
        mockMvc.perform(delete(ADMIN_SERIES + "/" + first).header("Authorization", admin))
                .andExpect(status().isNoContent());

        // Arranging a series is editorial work, not editing the post: updatedAt is the dateModified of ArticleJsonLd,
        // and must not jump every time the site owner assigns, moves or removes a part.
        assertThat(adminPost(part.id()).path("series").isNull()).isTrue();
        assertThat(updatedAt(part)).isEqualTo(before);

        // Control: a real post write does make updatedAt jump, so the comparison above is not comparing a field that
        // never changes.
        publish(part);
        assertThat(updatedAt(part)).isAfter(before);
    }

    // --- Public ------------------------------------------------------------------------------------

    @Test
    void public_list_has_only_series_with_published_parts_and_counts_only_those_parts() throws Exception {
        Fixture shortPart = createPost("Short part", words(10));
        Fixture hiddenPart = createPost("Unpublished part", words(10));
        Fixture longPart = createPost("Long part", words(300));
        String title = "Series With Published Parts " + suffix;
        UUID mixed = idOf(data(createSeries(Map.of("title", title, "description", "Three parts, two published."))
                .andExpect(status().isCreated())));
        setPosts(mixed, ids(shortPart, hiddenPart, longPart)).andExpect(status().isOk());
        JsonNode longPublished = publish(longPart);
        JsonNode shortPublished = publish(shortPart);

        Fixture onlyHidden = createPost("Only part not published");
        UUID unpublished = idOf(data(
                createSeries(Map.of("title", "Unpublished Series " + suffix)).andExpect(status().isCreated())));
        setPosts(unpublished, ids(onlyHidden)).andExpect(status().isOk());
        UUID empty = idOf(
                data(createSeries(Map.of("title", "Empty Series " + suffix)).andExpect(status().isCreated())));

        // No token: the /series page is public.
        JsonNode list = data(mockMvc.perform(get(PUBLIC_SERIES)).andExpect(status().isOk()));

        assertThat(idsOf(list)).contains(mixed.toString()).doesNotContain(unpublished.toString(), empty.toString());
        JsonNode entry = findById(list, mixed);
        assertThat(entry.path("title").asString()).isEqualTo(title);
        assertThat(entry.path("slug").asString())
                .isEqualTo(adminSeries(mixed).path("slug").asString());
        assertThat(entry.path("description").asString()).isEqualTo("Three parts, two published.");
        assertThat(entry.path("postCount").asInt()).isEqualTo(2);
        // The total reading time of the two published parts equals exactly the sum of the minutes each post records (2
        // + 1).
        assertThat(longPublished.path("readingMinutes").asInt()).isEqualTo(2);
        assertThat(shortPublished.path("readingMinutes").asInt()).isEqualTo(1);
        assertThat(entry.path("readingMinutes").asInt()).isEqualTo(3);
        // The last published part is the short one.
        assertThat(Instant.parse(entry.path("latestPublishedAt").asString()))
                .isEqualTo(Instant.parse(shortPublished.path("publishedAt").asString()));
        // The parts in reading order (position 1 then 3), with no unpublished part at position 2.
        List<String> partSlugs = new ArrayList<>();
        List<String> partTitles = new ArrayList<>();
        entry.path("parts").forEach(part -> {
            partSlugs.add(part.path("slug").asString());
            partTitles.add(part.path("title").asString());
        });
        assertThat(partSlugs).containsExactly(shortPart.slug(), longPart.slug());
        assertThat(partTitles).containsExactly(shortPart.title(), longPart.title());
    }

    @Test
    void public_list_puts_series_with_most_recent_published_part_first() throws Exception {
        Fixture olderPart = createPost("Part of the old series");
        Fixture newerPart = createPost("Part of the new series");
        Fixture laterPart = createPost("Extra part for the old series");
        // The order is reversed between the two checks while name and creation date stay the same: sorting by name or
        // by creation date (either
        // direction) turns one of the two checks red; only sorting by the most recent published part passes both.
        UUID older = idOf(
                data(createSeries(Map.of("title", "A series old " + suffix)).andExpect(status().isCreated())));
        UUID newer = idOf(
                data(createSeries(Map.of("title", "B series new " + suffix)).andExpect(status().isCreated())));
        setPosts(older, ids(olderPart, laterPart)).andExpect(status().isOk());
        setPosts(newer, ids(newerPart)).andExpect(status().isOk());
        publish(olderPart);
        publish(newerPart);
        // Fixed publish dates in the past, one day apart: the order does not depend on clock resolution, and
        // these posts sit at the end of every newest-posts list so they do not push other tests' posts off the first
        // page.
        setPublishedAt(olderPart, "2001-01-01T00:00:00Z");
        setPublishedAt(newerPart, "2001-01-02T00:00:00Z");

        List<String> before = idsOf(data(mockMvc.perform(get(PUBLIC_SERIES)).andExpect(status().isOk())));
        assertThat(before.indexOf(newer.toString())).isNotNegative().isLessThan(before.indexOf(older.toString()));

        // The older series has a newer part: it goes first.
        publish(laterPart);
        setPublishedAt(laterPart, "2001-01-03T00:00:00Z");

        List<String> after = idsOf(data(mockMvc.perform(get(PUBLIC_SERIES)).andExpect(status().isOk())));
        assertThat(after.indexOf(older.toString())).isNotNegative().isLessThan(after.indexOf(newer.toString()));
    }

    @Test
    void public_detail_has_only_published_parts_by_position_numbered_1_to_n() throws Exception {
        Fixture early = createPost("Part written first");
        Fixture hidden = createPost("Unpublished part in the middle");
        Fixture late = createPost("Part written later");
        publish(early);
        publish(late);
        JsonNode created =
                data(createSeries(Map.of("title", "Detail " + suffix, "description", "Detailed description."))
                        .andExpect(status().isCreated()));
        UUID id = idOf(created);
        // The reading order is the reverse of the writing order: the detail page must follow position, not publish
        // date.
        setPosts(id, ids(late, hidden, early)).andExpect(status().isOk());

        JsonNode detail = data(
                mockMvc.perform(get(PUBLIC_SERIES + "/" + created.path("slug").asString()))
                        .andExpect(status().isOk()));

        assertThat(detail.path("id").asString()).isEqualTo(id.toString());
        assertThat(detail.path("title").asString()).isEqualTo("Detail " + suffix);
        assertThat(detail.path("slug").asString())
                .isEqualTo(created.path("slug").asString());
        assertThat(detail.path("description").asString()).isEqualTo("Detailed description.");
        JsonNode posts = detail.path("posts");
        assertThat(idsOf(posts))
                .containsExactly(late.id().toString(), early.id().toString());
        // "Part n/m" counts over the published parts: positions 1 and 3 become part 1/2 and 2/2.
        for (int i = 0; i < posts.size(); i++) {
            JsonNode ref = posts.get(i).path("series");
            assertThat(ref.path("id").asString()).isEqualTo(id.toString());
            assertThat(ref.path("partNumber").asInt())
                    .as("partNumber of part %d", i)
                    .isEqualTo(i + 1);
            assertThat(ref.path("partCount").asInt())
                    .as("partCount of part %d", i)
                    .isEqualTo(2);
        }
        // The position a reader gets is the published ordinal too: the stored 3 would show that part 2 is not
        // published.
        assertThat(posts.get(0).path("series").path("position").asInt()).isEqualTo(1);
        assertThat(posts.get(1).path("series").path("position").asInt()).isEqualTo(2);
        // The post summary, like every list: it does not carry the post body.
        assertThat(posts.get(0).has("content")).isFalse();
        assertThat(posts.get(0).path("title").asString()).isEqualTo(late.title());
    }

    @Test
    void series_without_published_part_is_404_publicly_and_appears_when_a_part_is_published() throws Exception {
        Fixture part = createPost("Part awaiting publication");
        JsonNode created = data(
                createSeries(Map.of("title", "Awaiting Publication " + suffix)).andExpect(status().isCreated()));
        UUID id = idOf(created);
        String url = PUBLIC_SERIES + "/" + created.path("slug").asString();
        setPosts(id, ids(part)).andExpect(status().isOk());

        assertError(mockMvc.perform(get(url)), 404, "SERIES_NOT_FOUND");

        // Control: the same series, once it has a published part.
        publish(part);
        JsonNode detail = data(mockMvc.perform(get(url)).andExpect(status().isOk()));
        assertThat(idsOf(detail.path("posts"))).containsExactly(part.id().toString());

        // Unpublish the only part: the series disappears from the public side again.
        mockMvc.perform(post("/api/v1/admin/posts/" + part.id() + "/unpublish").header("Authorization", admin))
                .andExpect(status().isOk());
        assertError(mockMvc.perform(get(url)), 404, "SERIES_NOT_FOUND");
        assertThat(idsOf(data(mockMvc.perform(get(PUBLIC_SERIES)).andExpect(status().isOk()))))
                .doesNotContain(id.toString());
    }

    // --- Delete ------------------------------------------------------------------------------------

    @Test
    void delete_series_removes_all_its_posts_from_it_then_returns_204() throws Exception {
        Fixture unpublished = createPost("Unpublished part of the deleted series");
        Fixture published = createPost("Published part of the deleted series");
        publish(published);
        JsonNode created =
                data(createSeries(Map.of("title", "To Be Deleted " + suffix)).andExpect(status().isCreated()));
        UUID id = idOf(created);
        setPosts(id, ids(unpublished, published)).andExpect(status().isOk());

        mockMvc.perform(delete(ADMIN_SERIES + "/" + id).header("Authorization", admin))
                .andExpect(status().isNoContent());

        assertError(
                mockMvc.perform(get(ADMIN_SERIES + "/" + id).header("Authorization", admin)), 404, "SERIES_NOT_FOUND");
        assertError(
                mockMvc.perform(get(PUBLIC_SERIES + "/" + created.path("slug").asString())), 404, "SERIES_NOT_FOUND");
        // The post stays intact, it just belongs to no series any more: both columns become NULL (the V14 CHECK forces
        // them to be a pair).
        for (Fixture post : List.of(unpublished, published)) {
            assertThat(adminPost(post.id()).path("series").isNull())
                    .as(post.title())
                    .isTrue();
            Map<String, Object> row =
                    jdbcTemplate.queryForMap("SELECT series_id, series_position FROM posts WHERE id = ?", post.id());
            assertThat(row.get("series_id")).as(post.title()).isNull();
            assertThat(row.get("series_position")).as(post.title()).isNull();
        }
        mockMvc.perform(get("/api/v1/posts/" + published.slug())).andExpect(status().isOk());
        // Delete again: the series no longer exists.
        assertError(
                mockMvc.perform(delete(ADMIN_SERIES + "/" + id).header("Authorization", admin)),
                404,
                "SERIES_NOT_FOUND");
    }

    // --- Permissions -------------------------------------------------------------------------------

    @Test
    void only_admin_can_manage_series_author_gets_403_and_no_token_gets_401() throws Exception {
        String author = auth.bearerFor(auth.createAuthor("series-" + suffix + "@blog.local"));
        UUID id =
                idOf(data(createSeries(Map.of("title", "Permission " + suffix)).andExpect(status().isCreated())));
        String one = ADMIN_SERIES + "/" + id;

        // Control: the admin gets in.
        mockMvc.perform(get(ADMIN_SERIES).header("Authorization", admin)).andExpect(status().isOk());

        // A series spans the posts of every author, so AUTHOR cannot administer it even when the post inside is their
        // own.
        assertError(mockMvc.perform(get(ADMIN_SERIES).header("Authorization", author)), 403, "FORBIDDEN");
        assertError(
                mockMvc.perform(post(ADMIN_SERIES)
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Author own " + suffix + "\"}")),
                403,
                "FORBIDDEN");
        assertError(mockMvc.perform(get(one).header("Authorization", author)), 403, "FORBIDDEN");
        assertError(
                mockMvc.perform(put(one).header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Rename " + suffix + "\"}")),
                403,
                "FORBIDDEN");
        assertError(
                mockMvc.perform(put(one + "/posts")
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content("{\"postIds\":[]}")),
                403,
                "FORBIDDEN");
        assertError(mockMvc.perform(delete(one).header("Authorization", author)), 403, "FORBIDDEN");
        assertError(mockMvc.perform(get(ADMIN_SERIES)), 401, "UNAUTHENTICATED");

        // None of the calls above touched a series.
        assertThat(adminSeries(id).path("title").asString()).isEqualTo("Permission " + suffix);
    }

    // --- Assertions --------------------------------------------------------------------------------

    // --- Declared parts ------------------------------------------------------------------------------

    /** The declared part of a post as stored, null when nobody declared one. */
    private Integer partOf(Fixture post) {
        return jdbcTemplate.queryForObject("SELECT series_part FROM posts WHERE id = ?", Integer.class, post.id());
    }

    private Integer positionOf(Fixture post) {
        return jdbcTemplate.queryForObject("SELECT series_position FROM posts WHERE id = ?", Integer.class, post.id());
    }

    private UUID newSeries(String title) throws Exception {
        return idOf(data(createSeries(Map.of("title", title + " " + suffix)).andExpect(status().isCreated())));
    }

    @Test
    void the_database_keeps_a_part_with_its_series_unique_per_language_and_at_least_one() throws Exception {
        UUID series = newSeries("Part rules");
        Fixture en1 = createPost("English one", words(5), "en");
        Fixture en2 = createPost("English two", words(5), "en");
        Fixture vi1 = createPost("Vietnamese one", words(5), "vi");
        setPosts(series, ids(en1, en2, vi1)).andExpect(status().isOk());
        jdbcTemplate.update("UPDATE posts SET series_part = 3 WHERE id = ?", en1.id());

        // The same number in another language is a different part.
        jdbcTemplate.update("UPDATE posts SET series_part = 3 WHERE id = ?", vi1.id());
        assertThat(partOf(vi1)).isEqualTo(3);
        // The same number in the same language is not.
        assertThatThrownBy(() -> jdbcTemplate.update("UPDATE posts SET series_part = 3 WHERE id = ?", en2.id()))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbcTemplate.update("UPDATE posts SET series_part = 0 WHERE id = ?", en2.id()))
                .isInstanceOf(DataIntegrityViolationException.class);
        // A part without a series is nothing.
        Fixture alone = createPost("Alone", words(5), "en");
        assertThatThrownBy(() -> jdbcTemplate.update("UPDATE posts SET series_part = 1 WHERE id = ?", alone.id()))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void placing_parts_in_any_order_reads_in_part_order_and_keeps_every_declared_part() throws Exception {
        UUID series = newSeries("Any order");
        Fixture ten = createPost("Part ten", words(5), "en");
        Fixture one = createPost("Part one", words(5), "en");
        Fixture five = createPost("Part five", words(5), "en");
        Fixture seven = createPost("Part seven", words(5), "en");

        seriesService.placeByPart(series, ten.id(), 10);
        seriesService.placeByPart(series, one.id(), 1);
        seriesService.placeByPart(series, five.id(), 5);
        seriesService.placeByPart(series, seven.id(), 7);

        JsonNode members = adminSeries(series);
        assertMembers(members, one, five, seven, ten);
        assertThat(positionsOf(members)).containsExactly(1, 2, 3, 4);
        assertThat(List.of(partOf(one), partOf(five), partOf(seven), partOf(ten)))
                .containsExactly(1, 5, 7, 10);
    }

    @Test
    void placing_a_part_again_moves_the_post_to_its_place_and_a_new_part_number_replaces_the_old_one()
            throws Exception {
        UUID series = newSeries("Replace");
        Fixture a = createPost("Part a", words(5), "en");
        Fixture b = createPost("Part b", words(5), "en");
        Fixture c = createPost("Part c", words(5), "en");
        seriesService.placeByPart(series, a.id(), 1);
        seriesService.placeByPart(series, b.id(), 2);
        seriesService.placeByPart(series, c.id(), 3);

        seriesService.placeByPart(series, a.id(), 4);

        assertMembers(adminSeries(series), b, c, a);
        assertThat(List.of(partOf(b), partOf(c), partOf(a))).containsExactly(2, 3, 4);
    }

    @Test
    void parts_are_ordered_within_their_own_language_and_both_languages_may_use_the_same_number() throws Exception {
        UUID series = newSeries("Two languages");
        Fixture vi9 = createPost("Vietnamese nine", words(5), "vi");
        Fixture en1 = createPost("English one", words(5), "en");
        Fixture en5 = createPost("English five", words(5), "en");
        Fixture vi5 = createPost("Vietnamese five", words(5), "vi");

        seriesService.placeByPart(series, vi9.id(), 9);
        seriesService.placeByPart(series, en1.id(), 1);
        seriesService.placeByPart(series, en5.id(), 5);
        seriesService.placeByPart(series, vi5.id(), 5);

        List<String> order = idsOf(adminSeries(series).path("posts"));
        // Within a language the order follows the numbers, whatever the other language does.
        assertThat(order.indexOf(en1.id().toString()))
                .isLessThan(order.indexOf(en5.id().toString()));
        assertThat(order.indexOf(vi5.id().toString()))
                .isLessThan(order.indexOf(vi9.id().toString()));
        assertThat(partOf(en5)).isEqualTo(5);
        assertThat(partOf(vi5)).isEqualTo(5);
    }

    @Test
    void a_part_held_by_another_post_of_the_same_language_is_refused_and_nothing_changes() throws Exception {
        UUID series = newSeries("Taken part");
        Fixture first = createPost("First holder", words(5), "en");
        Fixture second = createPost("Second claimant", words(5), "en");
        seriesService.placeByPart(series, first.id(), 2);

        assertThatThrownBy(() -> seriesService.placeByPart(series, second.id(), 2))
                .isInstanceOf(DataIntegrityViolationException.class);

        assertMembers(adminSeries(series), first);
        assertThat(partOf(second)).isNull();
        assertThat(adminPost(second.id()).path("series").isNull()).isTrue();
    }

    @Test
    void members_without_a_declared_part_stay_where_they_are_and_a_new_part_goes_before_the_first_greater_one()
            throws Exception {
        UUID series = newSeries("Legacy members");
        Fixture legacyOne = createPost("Legacy one", words(5), "en");
        Fixture legacyTwo = createPost("Legacy two", words(5), "en");
        Fixture declared = createPost("Declared six", words(5), "en");
        Fixture early = createPost("Declared two", words(5), "en");
        setPosts(series, ids(legacyOne, legacyTwo)).andExpect(status().isOk());

        seriesService.placeByPart(series, declared.id(), 6);
        seriesService.placeByPart(series, early.id(), 2);

        assertMembers(adminSeries(series), legacyOne, legacyTwo, early, declared);
        assertThat(partOf(legacyOne)).isNull();
        assertThat(partOf(early)).isEqualTo(2);
    }

    @Test
    void declaring_the_part_of_a_hand_placed_member_does_not_move_it() throws Exception {
        UUID series = newSeries("Hand placed");
        Fixture p1 = createPost("Hand one", words(5), "en");
        Fixture p2 = createPost("Hand two", words(5), "en");
        Fixture p3 = createPost("Hand three", words(5), "en");
        setPosts(series, ids(p1, p2, p3)).andExpect(status().isOk());

        seriesService.placeByPart(series, p1.id(), 1);

        assertMembers(adminSeries(series), p1, p2, p3);
        assertThat(positionsOf(adminSeries(series))).containsExactly(1, 2, 3);
        assertThat(partOf(p1)).isEqualTo(1);
        assertThat(partOf(p2)).isNull();

        // The middle member too, with a number between its declared neighbours.
        seriesService.placeByPart(series, p3.id(), 3);
        seriesService.placeByPart(series, p2.id(), 2);

        assertMembers(adminSeries(series), p1, p2, p3);
        assertThat(List.of(partOf(p1), partOf(p2), partOf(p3))).containsExactly(1, 2, 3);
    }

    @Test
    void a_declared_part_that_the_declared_parts_around_a_member_contradict_moves_it() throws Exception {
        UUID series = newSeries("Out of order");
        Fixture p1 = createPost("Order one", words(5), "en");
        Fixture p2 = createPost("Order two", words(5), "en");
        Fixture p3 = createPost("Order three", words(5), "en");
        setPosts(series, ids(p1, p2, p3)).andExpect(status().isOk());
        seriesService.placeByPart(series, p3.id(), 3);

        // Declared 5 while p3 (declared 3) sits after it: it goes after p3.
        seriesService.placeByPart(series, p2.id(), 5);

        assertMembers(adminSeries(series), p1, p3, p2);
        assertThat(partOf(p2)).isEqualTo(5);
        assertThat(partOf(p3)).isEqualTo(3);
    }

    /** The PUT the editor sends, with the language named. */
    private ResultActions changeLanguage(Fixture post, String language) throws Exception {
        JsonNode before = adminPost(post.id());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", before.path("title").asString());
        body.put("excerpt", before.path("excerpt").asString());
        body.put("content", before.path("content").asString());
        body.put("categoryId", before.path("category").path("id").asString());
        body.put("tagIds", List.of());
        body.put("slug", before.path("slug").asString());
        body.put("language", language);
        return mockMvc.perform(put("/api/v1/admin/posts/" + post.id())
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private String languageOf(Fixture post) {
        return jdbcTemplate.queryForObject("SELECT language FROM posts WHERE id = ?", String.class, post.id());
    }

    @Test
    void changing_the_language_of_a_member_keeps_its_part_when_the_part_is_free_and_is_a_clean_409_when_it_is_taken()
            throws Exception {
        UUID series = newSeries("Language change");
        Fixture englishThree = createPost("English three", words(5), "en");
        Fixture vietnameseThree = createPost("Vietnamese three", words(5), "vi");
        Fixture englishSeven = createPost("English seven", words(5), "en");
        seriesService.placeByPart(series, englishThree.id(), 3);
        seriesService.placeByPart(series, vietnameseThree.id(), 3);
        seriesService.placeByPart(series, englishSeven.id(), 7);

        // Vietnamese part 3 is taken: the answer is a clear 409 with a fixed sentence and nothing changes.
        ResultActions refused = changeLanguage(englishThree, "vi");
        assertError(refused, 409, "SERIES_PART_CONFLICT");
        String body = refused.andReturn().getResponse().getContentAsString();
        assertThat(body)
                .contains("Another post of this series already has this part in that language")
                .doesNotContain(suffix)
                .doesNotContain("Vietnamese three");
        assertThat(languageOf(englishThree)).isEqualTo("en");
        assertThat(partOf(englishThree)).isEqualTo(3);

        // Vietnamese part 7 is free: the language changes and the part stays.
        changeLanguage(englishSeven, "vi").andExpect(status().isOk());
        assertThat(languageOf(englishSeven)).isEqualTo("vi");
        assertThat(partOf(englishSeven)).isEqualTo(7);
    }

    @Test
    void an_admin_reorder_keeps_the_declared_parts_of_posts_that_stay_and_clears_the_part_of_posts_that_leave()
            throws Exception {
        UUID series = newSeries("Reorder keeps");
        Fixture a = createPost("Part a", words(5), "en");
        Fixture b = createPost("Part b", words(5), "en");
        Fixture c = createPost("Part c", words(5), "en");
        seriesService.placeByPart(series, a.id(), 1);
        seriesService.placeByPart(series, b.id(), 2);
        seriesService.placeByPart(series, c.id(), 3);

        // Reverse the order and drop b.
        JsonNode saved = data(setPosts(series, ids(c, a)).andExpect(status().isOk()));

        assertMembers(saved, c, a);
        assertThat(positionsOf(saved)).containsExactly(1, 2);
        assertThat(partOf(c)).isEqualTo(3);
        assertThat(partOf(a)).isEqualTo(1);
        assertThat(partOf(b)).isNull();
        assertThat(adminPost(b.id()).path("series").isNull()).isTrue();
    }

    @Test
    void a_post_that_moves_to_another_series_by_an_admin_save_loses_its_part_in_the_old_one() throws Exception {
        UUID from = newSeries("Part leaves");
        UUID to = newSeries("Part arrives");
        Fixture moving = createPost("Moving part", words(5), "en");
        seriesService.placeByPart(from, moving.id(), 4);

        setPosts(to, ids(moving)).andExpect(status().isOk());

        assertThat(partOf(moving)).isNull();
        assertThat(adminPost(moving.id()).path("series").path("id").asString()).isEqualTo(to.toString());
    }

    @Test
    void deleting_a_series_clears_the_parts_of_its_posts() throws Exception {
        UUID series = newSeries("Part vanishes");
        Fixture member = createPost("Member", words(5), "en");
        seriesService.placeByPart(series, member.id(), 2);

        mockMvc.perform(delete(ADMIN_SERIES + "/" + series).header("Authorization", admin))
                .andExpect(status().isNoContent());

        assertThat(partOf(member)).isNull();
        assertThat(positionOf(member)).isNull();
    }

    @Test
    void a_series_save_waits_for_the_translation_writes_lock_before_it_touches_the_series_row() throws Exception {
        UUID series = newSeries("Lock order");
        Fixture member = createPost("Lock member", words(5), "en");
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction held = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForObject(
                        "select 1 from pg_advisory_xact_lock(" + PostRepository.TRANSLATION_LOCK_KEY + ")",
                        Integer.class))) {
            Future<Integer> saving = pool.submit(() ->
                    setPosts(series, ids(member)).andReturn().getResponse().getStatus());
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "pg_advisory_xact_lock", 1);
            // The save has not touched the series row yet: another writer can still lock it right now.
            assertThat(jdbcTemplate.queryForList(
                            "select id from series where id = ? for update nowait", UUID.class, series))
                    .containsExactly(series);

            held.commit();

            assertThat(saving.get(30, TimeUnit.SECONDS)).isEqualTo(200);
        } finally {
            pool.shutdownNow();
        }
        assertThat(positionOf(member)).isEqualTo(1);
    }

    // --- Languages ---------------------------------------------------------------------------------

    /** A series of three parts (vi long, en short, en draft) with an English title and description. */
    private record Bilingual(UUID id, String slug, Fixture vi, Fixture en, Fixture enDraft) {}

    private Bilingual bilingualSeries() throws Exception {
        Fixture vi = createPost("Vietnamese part", words(300), "vi");
        Fixture en = createPost("English part", words(10), "en");
        Fixture enDraft = createPost("English draft part", words(10), "en");
        Map<String, Object> translations =
                Map.of("en", Map.of("name", "English title " + suffix, "description", "English description."));
        Map<String, Object> body = new HashMap<>();
        body.put("title", "Bilingual Series " + suffix);
        body.put("description", "Base description.");
        body.put("translations", translations);
        JsonNode created = data(createSeries(body).andExpect(status().isCreated()));
        UUID id = idOf(created);
        setPosts(id, ids(vi, en, enDraft)).andExpect(status().isOk());
        publish(vi);
        publish(en);
        return new Bilingual(id, created.path("slug").asString(), vi, en, enDraft);
    }

    @Test
    void public_list_with_lang_has_series_with_a_published_part_in_it_counted_and_titled_in_that_language()
            throws Exception {
        Bilingual series = bilingualSeries();

        JsonNode english = findById(
                data(mockMvc.perform(get(PUBLIC_SERIES).param("lang", "en")).andExpect(status().isOk())), series.id());
        assertThat(english.path("title").asString()).isEqualTo("English title " + suffix);
        assertThat(english.path("description").asString()).isEqualTo("English description.");
        // The unpublished English part and the Vietnamese part are not counted.
        assertThat(english.path("postCount").asInt()).isEqualTo(1);
        assertThat(english.path("readingMinutes").asInt()).isEqualTo(1);
        assertThat(english.path("parts")).hasSize(1);
        assertThat(english.path("parts").get(0).path("slug").asString())
                .isEqualTo(series.en().slug());

        JsonNode vietnamese = findById(
                data(mockMvc.perform(get(PUBLIC_SERIES).param("lang", "vi")).andExpect(status().isOk())), series.id());
        // No Vietnamese translation: the base title and description.
        assertThat(vietnamese.path("title").asString()).isEqualTo("Bilingual Series " + suffix);
        assertThat(vietnamese.path("description").asString()).isEqualTo("Base description.");
        assertThat(vietnamese.path("postCount").asInt()).isEqualTo(1);
        assertThat(vietnamese.path("readingMinutes").asInt()).isEqualTo(2);

        JsonNode every = findById(data(mockMvc.perform(get(PUBLIC_SERIES)).andExpect(status().isOk())), series.id());
        assertThat(every.path("postCount").asInt()).isEqualTo(2);
        assertThat(every.path("title").asString()).isEqualTo("Bilingual Series " + suffix);
        assertThat(every.has("translations")).isFalse();
    }

    @Test
    void public_list_with_lang_hides_a_series_whose_only_part_in_that_language_is_unpublished() throws Exception {
        Fixture vi = createPost("Vietnamese only part", words(10), "vi");
        Fixture enDraft = createPost("English draft only part", words(10), "en");
        UUID id = idOf(
                data(createSeries(Map.of("title", "Language Leak " + suffix)).andExpect(status().isCreated())));
        setPosts(id, ids(vi, enDraft)).andExpect(status().isOk());
        publish(vi);

        assertThat(idsOf(data(
                        mockMvc.perform(get(PUBLIC_SERIES).param("lang", "vi")).andExpect(status().isOk()))))
                .contains(id.toString());
        assertThat(idsOf(data(
                        mockMvc.perform(get(PUBLIC_SERIES).param("lang", "en")).andExpect(status().isOk()))))
                .doesNotContain(id.toString());
    }

    @Test
    void public_detail_with_lang_localizes_and_filters_the_parts_but_keeps_any_language_visibility() throws Exception {
        Bilingual series = bilingualSeries();
        String url = PUBLIC_SERIES + "/" + series.slug();

        JsonNode english = data(mockMvc.perform(get(url).param("lang", "en")).andExpect(status().isOk()));
        assertThat(english.path("title").asString()).isEqualTo("English title " + suffix);
        assertThat(english.path("description").asString()).isEqualTo("English description.");
        assertThat(idsOf(english.path("posts")))
                .containsExactly(series.en().id().toString());
        assertThat(english.path("posts").get(0).path("series").path("partCount").asInt())
                .isEqualTo(1);

        JsonNode vietnamese = data(mockMvc.perform(get(url).param("lang", "vi")).andExpect(status().isOk()));
        assertThat(vietnamese.path("title").asString()).isEqualTo("Bilingual Series " + suffix);
        assertThat(idsOf(vietnamese.path("posts")))
                .containsExactly(series.vi().id().toString());

        assertThat(idsOf(data(mockMvc.perform(get(url)).andExpect(status().isOk()))
                        .path("posts")))
                .containsExactly(series.vi().id().toString(), series.en().id().toString());
    }

    @Test
    void public_detail_with_a_language_that_has_no_published_part_is_200_with_no_posts_not_404() throws Exception {
        Fixture vi = createPost("Vietnamese part of the one language series", words(10), "vi");
        JsonNode created = data(createSeries(Map.of(
                        "title",
                        "One Language " + suffix,
                        "translations",
                        Map.of("en", Map.of("name", "English one " + suffix))))
                .andExpect(status().isCreated()));
        setPosts(idOf(created), ids(vi)).andExpect(status().isOk());
        publish(vi);

        JsonNode detail = data(
                mockMvc.perform(get(PUBLIC_SERIES + "/" + created.path("slug").asString())
                                .param("lang", "en"))
                        .andExpect(status().isOk()));
        assertThat(detail.path("title").asString()).isEqualTo("English one " + suffix);
        assertThat(detail.path("posts")).isEmpty();
    }

    @Test
    void an_unknown_lang_is_a_validation_error_on_the_public_series_endpoints() throws Exception {
        Bilingual series = bilingualSeries();

        assertError(mockMvc.perform(get(PUBLIC_SERIES).param("lang", "fr")), 400, "VALIDATION_ERROR");
        assertError(
                mockMvc.perform(get(PUBLIC_SERIES + "/" + series.slug()).param("lang", "fr")), 400, "VALIDATION_ERROR");
    }

    @Test
    void admin_series_translations_round_trip_are_normalised_and_the_admin_screens_are_not_language_filtered()
            throws Exception {
        Fixture enDraft = createPost("English draft only", words(10), "en");
        Map<String, Object> translations = new HashMap<>();
        translations.put("en", Map.of("name", "  English name  ", "description", "  English text  "));
        translations.put("vi", Map.of("name", " ", "description", ""));
        Map<String, Object> body = new HashMap<>();
        body.put("title", "Admin Translations " + suffix);
        body.put("translations", translations);

        JsonNode created = data(createSeries(body).andExpect(status().isCreated()));
        UUID id = idOf(created);
        assertThat(created.path("translations").has("vi")).isFalse();
        assertThat(created.path("translations").path("en").path("name").asString())
                .isEqualTo("English name");
        assertThat(created.path("translations").path("en").path("description").asString())
                .isEqualTo("English text");

        setPosts(id, ids(enDraft)).andExpect(status().isOk());
        // Absent keeps the stored map; the unpublished English part still shows on the admin screen.
        JsonNode kept = data(updateSeries(id, Map.of("title", "Admin Translations " + suffix))
                .andExpect(status().isOk()));
        assertThat(kept.path("translations").path("en").path("name").asString()).isEqualTo("English name");
        assertThat(adminSeries(id).path("posts")).hasSize(1);
        assertThat(findById(
                                data(mockMvc.perform(get(ADMIN_SERIES).header("Authorization", admin))
                                        .andExpect(status().isOk())),
                                id)
                        .path("translations")
                        .path("en")
                        .path("name")
                        .asString())
                .isEqualTo("English name");

        JsonNode cleared =
                data(updateSeries(id, Map.of("title", "Admin Translations " + suffix, "translations", Map.of()))
                        .andExpect(status().isOk()));
        assertThat(cleared.path("translations").size()).isZero();
    }

    @Test
    void admin_series_translations_reject_an_unknown_locale_and_an_overlong_title() throws Exception {
        UUID id = idOf(data(createSeries(Map.of("title", "Translation Validation " + suffix))
                .andExpect(status().isCreated())));

        assertError(
                updateSeries(
                        id,
                        Map.of(
                                "title",
                                "Translation Validation " + suffix,
                                "translations",
                                Map.of("fr", Map.of("name", "Titre")))),
                400,
                "VALIDATION_ERROR");
        assertError(
                updateSeries(
                        id,
                        Map.of(
                                "title",
                                "Translation Validation " + suffix,
                                "translations",
                                Map.of("en", Map.of("name", "x".repeat(256))))),
                400,
                "VALIDATION_ERROR");
        assertError(
                createSeries(Map.of(
                        "title",
                        "Translation Validation Create " + suffix,
                        "translations",
                        Map.of("fr", Map.of("name", "Titre")))),
                400,
                "VALIDATION_ERROR");
        assertThat(adminSeries(id).path("translations").size()).isZero();
    }

    /** The series's post list is exactly these posts, in this order, with their names and slugs. */
    private static void assertMembers(JsonNode series, Fixture... expected) {
        JsonNode posts = series.path("posts");
        assertThat(idsOf(posts))
                .containsExactly(
                        Arrays.stream(expected).map(f -> f.id().toString()).toArray(String[]::new));
        for (int i = 0; i < expected.length; i++) {
            assertThat(posts.get(i).path("title").asString()).isEqualTo(expected[i].title());
            assertThat(posts.get(i).path("slug").asString()).isEqualTo(expected[i].slug());
        }
    }

    private static List<Integer> positionsOf(JsonNode series) {
        List<Integer> positions = new ArrayList<>();
        series.path("posts").forEach(post -> positions.add(post.path("position").asInt()));
        return positions;
    }

    private static List<String> statusesOf(JsonNode series) {
        List<String> statuses = new ArrayList<>();
        series.path("posts").forEach(post -> statuses.add(post.path("status").asString()));
        return statuses;
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        JsonNode error = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("error");
        assertThat(error.path("code").asString()).isEqualTo(code);
    }

    // --- Reading -----------------------------------------------------------------------------------

    private JsonNode adminSeries(UUID id) throws Exception {
        return data(mockMvc.perform(get(ADMIN_SERIES + "/" + id).header("Authorization", admin))
                .andExpect(status().isOk()));
    }

    private JsonNode adminPost(UUID id) throws Exception {
        return data(mockMvc.perform(get("/api/v1/admin/posts/" + id).header("Authorization", admin))
                .andExpect(status().isOk()));
    }

    /** Read back from the DB through the admin page, not taken from the write's response (an in-memory value, not yet rounded). */
    private Instant updatedAt(Fixture post) throws Exception {
        return Instant.parse(adminPost(post.id()).path("updatedAt").asString());
    }

    private static List<String> idsOf(JsonNode array) {
        List<String> ids = new ArrayList<>();
        array.forEach(node -> ids.add(node.path("id").asString()));
        return ids;
    }

    private static JsonNode findById(JsonNode array, UUID id) {
        for (JsonNode node : array) {
            if (id.toString().equals(node.path("id").asString())) {
                return node;
            }
        }
        return fail("Series %s not found in the list", id);
    }

    private static UUID idOf(JsonNode node) {
        return UUID.fromString(node.path("id").asString());
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }

    // --- Ghi ---------------------------------------------------------------------------------------

    private ResultActions createSeries(Map<String, ?> body) throws Exception {
        return mockMvc.perform(post(ADMIN_SERIES)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private ResultActions updateSeries(UUID id, Map<String, ?> body) throws Exception {
        return mockMvc.perform(put(ADMIN_SERIES + "/" + id)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private ResultActions setPosts(UUID id, List<UUID> postIds) throws Exception {
        return putPosts(id, objectMapper.writeValueAsString(Map.of("postIds", postIds)));
    }

    private ResultActions putPosts(UUID id, String json) throws Exception {
        return mockMvc.perform(put(ADMIN_SERIES + "/" + id + "/posts")
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(json));
    }

    private static List<UUID> ids(Fixture... posts) {
        return Arrays.stream(posts).map(Fixture::id).toList();
    }

    private Fixture createPost(String title) throws Exception {
        return createPost(title, words(12));
    }

    private Fixture createPost(String title, String content) throws Exception {
        return createPost(title, content, null);
    }

    private Fixture createPost(String title, String content, String language) throws Exception {
        Map<String, Object> fields = new HashMap<>();
        fields.put("title", title + " " + suffix);
        fields.put("excerpt", "Summary " + suffix);
        fields.put("content", content);
        fields.put("categoryId", categoryId.toString());
        if (language != null) {
            fields.put("language", language);
        }
        String payload = objectMapper.writeValueAsString(fields);
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated()));
        return new Fixture(
                idOf(created),
                created.path("slug").asString(),
                created.path("title").asString());
    }

    private JsonNode publish(Fixture post) throws Exception {
        return data(mockMvc.perform(
                        post("/api/v1/admin/posts/" + post.id() + "/publish").header("Authorization", admin))
                .andExpect(status().isOk()));
    }

    private void setPublishedAt(Fixture post, String instant) {
        assertThat(jdbcTemplate.update(
                        "UPDATE posts SET published_at = ? WHERE id = ?",
                        Timestamp.from(Instant.parse(instant)),
                        post.id()))
                .isEqualTo(1);
    }

    /** Content of exactly {@code n} words, so the reading time is known in advance: 200 words per minute. */
    private static String words(int n) {
        return String.join(" ", Collections.nCopies(n, "word"));
    }
}
