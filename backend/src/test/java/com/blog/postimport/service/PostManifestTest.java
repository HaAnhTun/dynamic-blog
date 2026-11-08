package com.blog.postimport.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.postimport.service.PostManifest.Item;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/** The manifest of an apply: what it accepts, and that every refusal is the same code and holds nothing of the input. */
class PostManifestTest {

    private static final ObjectMapper MAPPER = JsonMapper.builder().build();
    private static final String SHA = "a".repeat(64);

    @Test
    void reads_one_item_per_file_in_order_with_the_selection_and_the_state() {
        String json = "[{\"sha256\":\"" + SHA + "\",\"selected\":true,\"state\":\"abc\"}," + "{\"sha256\":\""
                + "b".repeat(64) + "\",\"selected\":false,\"state\":null}]";

        List<Item> items = PostManifest.parse(MAPPER, json, 2);

        assertThat(items).containsExactly(new Item(SHA, true, "abc"), new Item("b".repeat(64), false, null));
    }

    @Test
    void an_absent_state_is_the_same_as_a_null_one() {
        assertThat(PostManifest.parse(MAPPER, "[{\"sha256\":\"" + SHA + "\",\"selected\":true}]", 1))
                .containsExactly(new Item(SHA, true, null));
    }

    @Test
    void refuses_a_manifest_that_is_missing_malformed_or_does_not_match_the_files() {
        String secret = "secret-marker";
        for (String json : new String[] {
            null,
            "",
            "   ",
            "not json " + secret,
            "{}",
            "[]",
            "[1]",
            "[{}]",
            "[{\"sha256\":\"" + secret + "\",\"selected\":true}]",
            "[{\"sha256\":\"" + SHA.toUpperCase() + "\",\"selected\":true}]",
            "[{\"sha256\":\"" + SHA + "\"}]",
            "[{\"sha256\":\"" + SHA + "\",\"selected\":\"yes\"}]",
            "[{\"sha256\":\"" + SHA + "\",\"selected\":true,\"state\":7}]",
            "[{\"sha256\":\"" + SHA + "\",\"selected\":true,\"state\":\"" + "x".repeat(600) + "\"}]",
            "[{\"sha256\":\"" + SHA + "\",\"selected\":true},{\"sha256\":\"" + SHA + "\",\"selected\":true}]",
            " ".repeat(PostManifest.MAX_CHARS + 1)
        }) {
            assertThatThrownBy(() -> PostManifest.parse(MAPPER, json, 1))
                    .isInstanceOfSatisfying(ApiException.class, e -> {
                        assertThat(e.getCode()).isEqualTo(ErrorCode.POST_IMPORT_INVALID_FILE);
                        assertThat(e.getStatus().value()).isEqualTo(400);
                        assertThat(e.getMessage()).doesNotContain(secret);
                    });
        }
    }
}
