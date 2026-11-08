package com.blog.contact.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

/** The retention setting bound the way the application binds it. */
class ContactRetentionPropertiesTest {

    private static ContactRetentionProperties bound(Map<String, Object> keys) {
        return new Binder(new MapConfigurationPropertySource(keys))
                .bindOrCreate("app.contact.retention", ContactRetentionProperties.class);
    }

    @Test
    void the_default_is_a_year_and_a_number_sets_it() {
        assertThat(bound(Map.of()).days()).isEqualTo(365);
        assertThat(bound(Map.of("app.contact.retention.days", "30")).days()).isEqualTo(30);
        assertThat(bound(Map.of("app.contact.retention.days", "0")).days()).isZero();
    }

    @Test
    void a_setting_left_empty_means_the_default() {
        // CONTACT_RETENTION_DAYS= in a .env file outside Docker Compose reaches the application as an empty value.
        assertThat(bound(Map.of("app.contact.retention.days", "")).days()).isEqualTo(365);
    }
}
