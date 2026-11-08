package com.blog.common.util;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/** What of a request a log line may repeat: a bounded prefix of the path, without the query and without control characters. */
class LogTextTest {

    @Test
    void a_short_path_is_logged_as_it_is_and_the_query_is_left_out() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/posts/hello");
        request.setQueryString("q=secret-search");

        assertThat(LogText.path(request)).isEqualTo("/api/v1/posts/hello");
    }

    @Test
    void a_path_over_the_cap_is_cut_and_says_so() {
        String path = "/api/v1/" + "a".repeat(8000);
        MockHttpServletRequest request = new MockHttpServletRequest("GET", path);

        String logged = LogText.path(request);

        assertThat(logged)
                .hasSize(LogText.PATH_MAX + 3)
                .startsWith("/api/v1/aaa")
                .endsWith("...");
        assertThat(logged).doesNotContain("a".repeat(LogText.PATH_MAX));
    }

    @Test
    void control_characters_cannot_forge_a_second_line() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/x\r\nWARN forged line\u0000");

        assertThat(LogText.path(request))
                .doesNotContain("\r")
                .doesNotContain("\n")
                .doesNotContain("\u0000");
    }

    @Test
    void a_method_token_is_capped_too() {
        assertThat(LogText.method(new MockHttpServletRequest("GET", "/x"))).isEqualTo("GET");
        assertThat(LogText.method(new MockHttpServletRequest("M".repeat(500), "/x")))
                .hasSizeLessThanOrEqualTo(LogText.METHOD_MAX + 3);
    }
}
