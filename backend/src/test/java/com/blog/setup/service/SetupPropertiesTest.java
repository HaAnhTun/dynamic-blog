package com.blog.setup.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.setup.config.SetupProperties;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class SetupPropertiesTest {

    @Test
    void a_blank_token_means_the_generated_file_and_a_set_token_is_stripped() {
        assertThat(new SetupProperties(null, null, true).configuredToken()).isNull();
        assertThat(new SetupProperties("   ", null, true).configuredToken()).isNull();
        assertThat(new SetupProperties(" abcdefghijklmnopqrstuvwx \n", null, true).configuredToken())
                .isEqualTo("abcdefghijklmnopqrstuvwx");
    }

    @Test
    void a_short_token_stops_the_start_without_showing_its_value() {
        String shortToken = "only-23-characters-long";
        assertThat(shortToken).hasSize(23);

        assertThatThrownBy(() -> new SetupProperties(shortToken, null, true).configuredToken())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("SETUP_TOKEN")
                .hasMessageNotContaining(shortToken);
        assertThatThrownBy(() -> new SetupCodeStore(new SetupProperties(shortToken, null, true)))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void the_code_file_lives_in_the_data_directory_which_defaults_to_data() {
        assertThat(new SetupProperties(null, "/srv/blog-data", true).codeFile())
                .isEqualTo(Path.of("/srv/blog-data").toAbsolutePath().resolve("setup-code"));
        assertThat(new SetupProperties(null, " ", true).codeFile())
                .isEqualTo(Path.of("data").toAbsolutePath().resolve("setup-code"));
    }
}
