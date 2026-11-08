package com.blog.comment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.ObjectMapper;

/**
 * Rate limit and duplicate-submission guard for comments, with default
 * values: create and reply share 5 per minute (and 30 per hour), edit and delete share 20 per 10 minutes, per
 * person.
 *
 * The limiter lives in the memory of the shared context and is never cleaned: each test uses its own reader,
 * so the slots spent here do not spill into other tests. The calls run back to back within a few hundred
 * milliseconds, far under a minute. The window boundaries are tested in RateLimiterTest with a fake clock,
 * not here.
 */
@AutoConfigureMockMvc
class CommentRateLimitIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private CommentFixtures f;

    @BeforeEach
    void setUp() {
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    // --- Rate limit ------------------------------------------------------------------------------------

    @Test
    void sixth_create_within_a_minute_is_429_counting_replies_and_writes_nothing() throws Exception {
        Post post = f.publishedPost("Comment limit");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID root = f.createdId(f.create(binh, post, "Ben's root"));
        List<UUID> anComments = new ArrayList<>();
        for (int i = 1; i <= 3; i++) {
            anComments.add(f.createdId(f.create(an, post, "Comment number " + i + " by An")));
        }
        f.createdId(f.reply(an, root, "Reply number 1 by An"));
        f.createdId(f.reply(an, root, "Reply number 2 by An"));

        ResultActions sixth = f.create(an, post, "Sixth comment by An");
        f.assertError(sixth, 429, "RATE_LIMITED");
        // No Retry-After, and the message mentions nobody.
        assertThat(sixth.andReturn().getResponse().getHeader("Retry-After")).isNull();
        assertThat(sixth.andReturn().getResponse().getContentAsString())
                .doesNotContain(an.id().toString());
        f.assertError(f.reply(an, root, "Third reply by An"), 429, "RATE_LIMITED");
        assertThat(f.countComments("user_id = ?", an.id())).isEqualTo(5);

        // Each person has their own counter: others can still comment.
        f.createdId(f.create(binh, post, "Ben can still comment"));
        // Edit and delete are a different limit: a person who just ran out of comments can still edit their
        // own comment.
        f.edit(an, anComments.getFirst(), "Editing still works when the comment quota is used up")
                .andExpect(status().isOk());
    }

    @Test
    void edit_and_delete_share_20_per_10_minutes_limit() throws Exception {
        Post post = f.publishedPost("Comment edit limit");
        Reader an = f.reader("an");
        UUID edited = f.createdId(f.create(an, post, "Comment to be edited many times"));
        UUID removed = f.createdId(f.create(an, post, "Comment to be deleted"));

        for (int i = 1; i <= 19; i++) {
            f.edit(an, edited, "Edit number " + i).andExpect(status().isOk());
        }
        f.remove(an, removed).andExpect(status().isNoContent());

        f.assertError(f.edit(an, edited, "Twenty-first edit"), 429, "RATE_LIMITED");
        f.assertError(f.remove(an, edited), 429, "RATE_LIMITED");
        assertThat(f.row(edited).get("content")).isEqualTo("Edit number 19");
        assertThat(f.row(edited).get("status")).isEqualTo("VISIBLE");
        // Creating comments is a different limit.
        f.createdId(f.create(an, post, "New comment after the edits ran out"));
    }

    // --- Duplicate-submission guard --------------------------------------------------------------------

    @Test
    void same_user_resubmitting_same_content_to_same_post_within_10_minutes_is_409() throws Exception {
        Post post = f.publishedPost("Duplicate comment submission");
        Post other = f.publishedPost("Other post for the same text");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        f.createdId(f.create(an, post, "This post is great!"));

        f.assertError(f.create(an, post, "This post is great!"), 409, "COMMENT_DUPLICATE");
        // Compared on sanitized content: differing surrounding whitespace or line ending style is still a
        // duplicate.
        f.assertError(f.create(an, post, "  This post is great!\r\n"), 409, "COMMENT_DUPLICATE");
        assertThat(f.countComments("user_id = ? AND post_id = ?", an.id(), post.id()))
                .isEqualTo(1);

        // Another post, different content, or another person: not a duplicate.
        f.createdId(f.create(an, other, "This post is great!"));
        f.createdId(f.create(an, post, "This post is great!!"));
        f.createdId(f.create(binh, post, "This post is great!"));
    }

    @Test
    void same_reply_text_to_two_different_comments_is_accepted_for_both() throws Exception {
        Post post = f.publishedPost("Reply with the same text");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Instant earlier = Instant.now().minusSeconds(60);
        UUID first = f.insertComment(post, an.id(), null, "First question", "VISIBLE", earlier);
        UUID second = f.insertComment(post, an.id(), null, "Second question", "VISIBLE", earlier.plusSeconds(1));

        f.createdId(f.reply(binh, first, "Thank you!"));
        f.createdId(f.reply(binh, second, "Thank you!"));
        f.assertError(f.reply(binh, first, "Thank you!"), 409, "COMMENT_DUPLICATE");
        // A root comment with that same text is no duplicate of the two replies either: different parent.
        f.createdId(f.create(binh, post, "Thank you!"));

        assertThat(f.countComments("user_id = ?", binh.id())).isEqualTo(3);
    }

    @Test
    void deleted_or_older_than_10_minutes_comment_does_not_block_resubmit_but_hidden_one_does() throws Exception {
        Post post = f.publishedPost("Resubmit comment");
        Reader an = f.reader("an");
        String content = "Resubmit the same text";
        UUID first = f.createdId(f.create(an, post, content));
        f.remove(an, first).andExpect(status().isNoContent());

        UUID second = f.createdId(f.create(an, post, content));
        // Push the second submission back 11 minutes: out of the duplicate window.
        jdbcTemplate.update("UPDATE comments SET created_at = created_at - INTERVAL '11 minutes' WHERE id = ?", second);
        UUID third = f.createdId(f.create(an, post, content));

        // A hidden comment still counts as a duplicate: resubmitting is no way around moderation.
        f.setCommentStatus(third, "HIDDEN");
        f.assertError(f.create(an, post, content), 409, "COMMENT_DUPLICATE");
        assertThat(f.countComments("user_id = ? AND post_id = ?", an.id(), post.id()))
                .isEqualTo(3);
    }

    @Test
    void many_simultaneous_submissions_of_same_content_create_only_one_comment() throws Exception {
        Post post = f.publishedPost("Submit clicked many times");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");

        List<Integer> roots = parallel(
                4,
                () -> f.create(an, post, "Submit clicked four times at once")
                        .andReturn()
                        .getResponse()
                        .getStatus());
        assertThat(roots).containsExactlyInAnyOrder(201, 409, 409, 409);
        assertThat(f.countComments("user_id = ? AND post_id = ?", an.id(), post.id()))
                .isEqualTo(1);

        UUID root = f.insertComment(
                post,
                an.id(),
                null,
                "Root to reply to",
                "VISIBLE",
                Instant.now().minusSeconds(5));
        List<Integer> replies = parallel(
                4,
                () -> f.reply(binh, root, "Reply clicked four times at once")
                        .andReturn()
                        .getResponse()
                        .getStatus());
        assertThat(replies).containsExactlyInAnyOrder(201, 409, 409, 409);
        assertThat(f.countComments("parent_id = ?", root)).isEqualTo(1);
    }

    /** Runs the same call on several threads, released together; returns the status code of each run. */
    private static List<Integer> parallel(int calls, Callable<Integer> call) throws Exception {
        CountDownLatch go = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(calls);
        try {
            List<Future<Integer>> results = new ArrayList<>();
            for (int i = 0; i < calls; i++) {
                results.add(pool.submit(() -> {
                    go.await();
                    return call.call();
                }));
            }
            go.countDown();
            List<Integer> statuses = new ArrayList<>();
            for (Future<Integer> result : results) {
                statuses.add(result.get(60, TimeUnit.SECONDS));
            }
            return statuses;
        } finally {
            pool.shutdownNow();
        }
    }
}
