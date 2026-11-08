package com.blog.post.entity;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.text.ReadingTime;
import org.junit.jupiter.api.Test;

/** The body and the reading time that is stored with it are set together (issue 013), so a list can show the figure without the body. */
class PostTest {

    @Test
    void setting_the_body_sets_the_reading_time_with_the_function_of_the_whole_site() {
        Post post = new Post();

        post.setContent("word ".repeat(450));

        assertThat(post.getReadingMinutes()).isEqualTo(3).isEqualTo(ReadingTime.minutes(post.getContent()));
    }

    @Test
    void a_new_body_replaces_the_figure_and_an_empty_one_is_one_minute() {
        Post post = new Post();
        post.setContent("word ".repeat(450));

        post.setContent("short");
        assertThat(post.getReadingMinutes()).isEqualTo(1);

        post.setContent("");
        assertThat(post.getReadingMinutes()).isEqualTo(1);
    }

    @Test
    void a_card_has_no_way_to_reach_a_body() {
        // PostHead is the type every list works with; it has no getContent.
        assertThat(PostHead.class.getMethods())
                .noneMatch(method -> method.getName().equals("getContent"));
        assertThat(PostCard.class.getMethods())
                .noneMatch(method -> method.getName().equals("getContent"));
    }
}
