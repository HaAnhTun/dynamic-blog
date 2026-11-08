package com.blog.common.limits;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.web.filter.FormContentFilter;
import tools.jackson.core.exc.StreamConstraintsException;
import tools.jackson.databind.ObjectMapper;

/**
 * The request-size ceilings through the real filter chain and the real JSON reader (issues 118 and 036): a body over the
 * ceiling of its path is a 413 before any controller runs, a field over its {@code @Size} is a clean 400, and the JSON reader
 * itself refuses a string over a million characters.
 */
@AutoConfigureMockMvc
class RequestLimitsIT extends AbstractIntegrationTest {

    private static final String TOO_LARGE = "The request body is too large";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ApplicationContext applicationContext;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private ResultActions postJson(String path, Object body) throws Exception {
        return mockMvc.perform(post(path).contentType(APPLICATION_JSON).content(objectMapper.writeValueAsString(body)));
    }

    // --- The JSON reader ----------------------------------------------------------------------------------------

    @Test
    void the_json_reader_refuses_a_string_over_one_million_characters() {
        // The Jackson 3 default is 100 million. This is the mapper every request body goes through.
        String atTheLimit = "\"" + "a".repeat(1_000_000) + "\"";
        String overTheLimit = "\"" + "a".repeat(1_000_001) + "\"";

        assertThat(objectMapper.readTree(atTheLimit).asString()).hasSize(1_000_000);
        assertThatThrownBy(() -> objectMapper.readTree(overTheLimit)).isInstanceOf(StreamConstraintsException.class);
    }

    @Test
    void the_json_reader_refuses_a_document_over_eight_mebibytes() {
        // Many small strings, none over the string limit: only the document ceiling can stop this one.
        String element = "\"" + "a".repeat(1000) + "\"";
        String document = "[" + String.join(",", Collections.nCopies(8_500, element)) + "]";
        assertThat(document.length()).isGreaterThan(8 * 1024 * 1024);

        assertThatThrownBy(() -> objectMapper.readTree(document)).isInstanceOf(StreamConstraintsException.class);
    }

    // --- The anonymous endpoints --------------------------------------------------------------------------------

    @Test
    void a_login_body_over_the_public_ceiling_is_413_before_anything_reads_it() throws Exception {
        postJson("/api/v1/auth/login", Map.of("email", "owner@example.com", "password", "x".repeat(70_000)))
                .andExpect(status().isContentTooLarge())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"))
                .andExpect(jsonPath("$.error.message").value(TOO_LARGE))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());
    }

    @Test
    void a_login_password_or_email_over_its_bound_is_a_400_validation_error() throws Exception {
        postJson("/api/v1/auth/login", Map.of("email", "owner@example.com", "password", "x".repeat(513)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        postJson("/api/v1/auth/login", Map.of("email", "a".repeat(250) + "@example.com", "password", "whatever-123"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        postJson("/api/v1/auth/refresh", Map.of("refreshToken", "t".repeat(513)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void a_contact_body_over_the_public_ceiling_is_413_and_stores_nothing() throws Exception {
        int before = rows("contact_messages");

        postJson(
                        "/api/v1/contact/messages",
                        Map.of(
                                "name", "Reader",
                                "email", "reader@example.com",
                                "message", "m".repeat(70_000)))
                .andExpect(status().isContentTooLarge())
                .andExpect(jsonPath("$.error.message").value(TOO_LARGE));

        assertThat(rows("contact_messages")).isEqualTo(before);
    }

    @Test
    void a_contact_field_far_over_its_limit_is_a_generic_400_and_stores_nothing() throws Exception {
        int before = rows("contact_messages");

        postJson(
                        "/api/v1/contact/messages",
                        Map.of(
                                "name", "n".repeat(201),
                                "email", "reader@example.com",
                                "message", "A message of a reasonable length."))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"))
                .andExpect(jsonPath("$.error.message").value("Invalid contact message"));
        postJson(
                        "/api/v1/contact/messages",
                        Map.of(
                                "name", "Reader",
                                "email", "reader@example.com",
                                "message", "m".repeat(5001)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value("Invalid contact message"));

        assertThat(rows("contact_messages")).isEqualTo(before);
    }

    @Test
    void a_newsletter_address_over_254_characters_is_a_400() throws Exception {
        postJson("/api/v1/newsletter/subscriptions", Map.of("email", "a".repeat(300) + "@example.com"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void a_newsletter_or_setup_body_over_the_public_ceiling_is_413() throws Exception {
        postJson("/api/v1/newsletter/confirm", Map.of("token", "t".repeat(70_000)))
                .andExpect(status().isContentTooLarge())
                .andExpect(jsonPath("$.error.message").value(TOO_LARGE));
        postJson("/api/v1/setup", Map.of("setupCode", "c".repeat(70_000)))
                .andExpect(status().isContentTooLarge())
                .andExpect(jsonPath("$.error.message").value(TOO_LARGE));
    }

    /**
     * Spring Boot's FormContentFilter reads the whole body of a PUT, PATCH or DELETE form before the security chain. Nothing in
     * the API takes a form, so it is off; if it were on, a chunked form body past the ceiling would throw out of the filter
     * chain (the container logs that at ERROR with a stack trace and answers 500) instead of being refused.
     */
    @Test
    void no_filter_reads_a_put_form_body_so_an_oversized_chunked_one_is_no_error() throws Exception {
        assertThat(applicationContext.getBeanNamesForType(FormContentFilter.class))
                .isEmpty();

        for (String method : new String[] {"PUT", "PATCH", "DELETE"}) {
            mockMvc.perform(request(HttpMethod.valueOf(method), "/api/v1/auth/login")
                            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                            .content(("a=" + "x".repeat(70_000)).getBytes(StandardCharsets.UTF_8))
                            .with(withoutDeclaredLength()))
                    .andExpect(status().is4xxClientError());
        }
    }

    /** Makes the mock request report no content length, like a chunked one. */
    private static RequestPostProcessor withoutDeclaredLength() {
        return request -> {
            MockHttpServletRequest chunked =
                    new MockHttpServletRequest(
                            request.getServletContext(), request.getMethod(), request.getRequestURI()) {
                        @Override
                        public long getContentLengthLong() {
                            return -1;
                        }

                        @Override
                        public int getContentLength() {
                            return -1;
                        }
                    };
            chunked.setContentType(request.getContentType());
            chunked.setContent(request.getContentAsByteArray());
            return chunked;
        };
    }

    // --- The admin endpoints ------------------------------------------------------------------------------------

    @Test
    void an_admin_body_over_six_mebibytes_is_413_even_with_a_valid_token() throws Exception {
        String token = auth.bearerForAdmin();

        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", token)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("title", "Too big", "content", "c".repeat(6 * 1024 * 1024 + 1)))))
                .andExpect(status().isContentTooLarge())
                .andExpect(jsonPath("$.error.message").value(TOO_LARGE));
    }

    @Test
    void an_admin_post_that_fits_the_ceiling_but_not_the_post_limit_is_still_a_400() throws Exception {
        // 600,000 characters: far above the 500,000 of a post, far below the 6 MiB of the admin ceiling. The ceiling
        // only
        // protects memory; the post limit keeps its own clean answer.
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("title", "Long", "content", "c".repeat(600_000)))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    private int rows(String table) {
        Integer count = jdbcTemplate.queryForObject("select count(*) from " + table, Integer.class);
        return count == null ? 0 : count;
    }
}
