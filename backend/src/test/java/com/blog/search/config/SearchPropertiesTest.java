package com.blog.search.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

/**
 * {@code app.search.meili.*}: defaults when nothing is set, the index name must fall inside the {@code content_*}
 * scope of the search key, and {@code toString} never prints the master key or the address.
 */
class SearchPropertiesTest {

    private static SearchProperties bind(Map<String, String> values) {
        return new Binder(new MapConfigurationPropertySource(values))
                .bindOrCreate("app.search", SearchProperties.class);
    }

    @Test
    void defaults_are_postgres_unconfigured_and_the_contract_timeouts() {
        SearchProperties properties = bind(Map.of());
        assertThat(properties.engine()).isEqualTo(SearchProperties.Engine.POSTGRES);
        assertThat(properties.meili().configured()).isFalse();
        assertThat(properties.meili().indexName()).isEqualTo("content_v1");
        assertThat(properties.meili().connectTimeout()).isEqualTo(Duration.ofMillis(500));
        assertThat(properties.meili().searchTimeout()).isEqualTo(Duration.ofMillis(800));
        assertThat(properties.meili().adminTimeout()).isEqualTo(Duration.ofSeconds(10));
    }

    @Test
    void full_configuration_and_toString_does_not_print_the_key() {
        String master = "khoa-chinh-rat-bi-mat-0123456789abcdef";
        SearchProperties properties = bind(Map.of(
                "app.search.engine",
                "meilisearch",
                "app.search.meili.url",
                "http://meili.internal:7700",
                "app.search.meili.master-key",
                master,
                "app.search.meili.index-name",
                "content_e2e_v1"));
        assertThat(properties.meili().configured()).isTrue();
        assertThat(properties.meili().indexName()).isEqualTo("content_e2e_v1");
        assertThat(properties.toString())
                .doesNotContain(master, "meili.internal")
                .contains("<set>");
    }

    @Test
    void index_name_outside_content_is_rejected() {
        for (String name : new String[] {"blog_v1", "content_", "content_v1/../keys", "content v1"}) {
            assertThatThrownBy(() -> new SearchProperties.Meili(
                            "", "", name, Duration.ofMillis(500), Duration.ofMillis(800), Duration.ofSeconds(10)))
                    .as(name)
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }
}
