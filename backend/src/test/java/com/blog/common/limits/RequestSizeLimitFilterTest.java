package com.blog.common.limits;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.util.unit.DataSize;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * The size filter on its own (issues 118 and 036): the declared length, the streamed count, the two ceilings and the path
 * that picks one. Plain unit test with a ceiling of 100 bytes for the public paths and 1000 for the admin ones.
 */
class RequestSizeLimitFilterTest {

    private static final long PUBLIC = 100;
    private static final long ADMIN = 1000;

    private final ObjectMapper mapper = JsonMapper.builder().build();
    private final RequestSizeLimitFilter filter = new RequestSizeLimitFilter(PUBLIC, ADMIN, mapper);

    private static MockHttpServletRequest post(String path, int bytes) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", path);
        request.setServletPath(path);
        request.setContentType("application/json");
        request.setContent(new byte[bytes]);
        return request;
    }

    /** A request whose length is not declared, like a chunked one: the mock would otherwise report the content length. */
    private static MockHttpServletRequest chunked(String path, int bytes) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", path) {
            @Override
            public long getContentLengthLong() {
                return -1;
            }

            @Override
            public int getContentLength() {
                return -1;
            }
        };
        request.setServletPath(path);
        request.setContentType("application/json");
        request.setContent(new byte[bytes]);
        return request;
    }

    /** Counts the calls that reach the controller side and, if asked, reads the whole body there. */
    private static final class Probe extends MockFilterChain {
        final AtomicInteger calls = new AtomicInteger();
        final AtomicReference<HttpServletRequest> seen = new AtomicReference<>();

        @Override
        public void doFilter(ServletRequest request, ServletResponse response) {
            calls.incrementAndGet();
            seen.set((HttpServletRequest) request);
        }
    }

    @Test
    void a_declared_length_over_the_public_ceiling_is_a_413_envelope_and_the_chain_never_runs() throws Exception {
        MockHttpServletRequest request = post("/api/v1/auth/login", 101);
        MockHttpServletResponse response = new MockHttpServletResponse();
        Probe chain = new Probe();

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(413);
        assertThat(response.getContentType()).startsWith("application/json");
        JsonNode error = mapper.readTree(response.getContentAsString()).path("error");
        assertThat(error.path("code").asString()).isEqualTo("VALIDATION_ERROR");
        assertThat(error.path("message").asString()).isEqualTo("The request body is too large");
        assertThat(error.path("traceId").asString()).isNotBlank();
        assertThat(chain.calls).hasValue(0);
    }

    @Test
    void a_declared_length_at_the_ceiling_passes() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        Probe chain = new Probe();

        filter.doFilter(post("/api/v1/auth/login", 100), response, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(chain.calls).hasValue(1);
    }

    @Test
    void the_admin_paths_have_the_larger_ceiling() throws Exception {
        Probe admin = new Probe();
        MockHttpServletResponse adminResponse = new MockHttpServletResponse();
        filter.doFilter(post("/api/v1/admin/posts", 1000), adminResponse, admin);
        assertThat(adminResponse.getStatus()).isEqualTo(200);
        assertThat(admin.calls).hasValue(1);

        MockHttpServletResponse tooBig = new MockHttpServletResponse();
        Probe none = new Probe();
        filter.doFilter(post("/api/v1/admin/posts", 1001), tooBig, none);
        assertThat(tooBig.getStatus()).isEqualTo(413);
        assertThat(none.calls).hasValue(0);

        // The same 1000 bytes on a public path are far over its ceiling.
        MockHttpServletResponse publicResponse = new MockHttpServletResponse();
        filter.doFilter(post("/api/v1/contact/messages", 1000), publicResponse, new Probe());
        assertThat(publicResponse.getStatus()).isEqualTo(413);
    }

    @Test
    void the_normalised_servlet_path_decides_not_the_raw_request_line() throws Exception {
        // The container resolves the dot segments before it maps the request: this one reaches the login, so it must
        // not
        // borrow the admin ceiling.
        MockHttpServletRequest request = post("/api/v1/auth/login", 500);
        request.setRequestURI("/api/v1/admin/../auth/login");
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new Probe());

        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test
    void a_path_without_a_servlet_path_is_classified_by_its_request_line() throws Exception {
        // MockMvc leaves the servlet path empty.
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/v1/admin/posts");
        request.setContentType("application/json");
        request.setContent(new byte[500]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        Probe chain = new Probe();

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(chain.calls).hasValue(1);
    }

    @Test
    void a_body_that_does_not_declare_its_length_is_counted_as_it_is_read() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        Probe chain = new Probe();

        filter.doFilter(chunked("/api/v1/contact/messages", 101), response, chain);

        // The request reaches the controller side, which only finds out when it reads past the ceiling.
        assertThat(chain.calls).hasValue(1);
        assertThatThrownBy(() -> chain.seen.get().getInputStream().readAllBytes())
                .isInstanceOf(RequestBodyTooLargeException.class);
    }

    // --- A filter that reads the body before any controller does
    // ---------------------------------------------------------

    /** What Spring's FormContentFilter does with a PUT form: it drains the body inside the chain, outside of any controller. */
    private static final FilterChain DRAINS_THE_BODY =
            (request, response) -> request.getInputStream().readAllBytes();

    @Test
    void a_chunked_body_over_the_ceiling_that_a_downstream_filter_reads_is_the_413_envelope_not_an_exception()
            throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(chunked("/api/v1/contact/messages", 101), response, DRAINS_THE_BODY);

        assertThat(response.getStatus()).isEqualTo(413);
        assertThat(response.getContentType()).startsWith("application/json");
        JsonNode error = mapper.readTree(response.getContentAsString()).path("error");
        assertThat(error.path("code").asString()).isEqualTo("VALIDATION_ERROR");
        assertThat(error.path("message").asString()).isEqualTo("The request body is too large");
        assertThat(error.path("traceId").asString()).isNotBlank();
    }

    @Test
    void the_413_is_also_written_when_the_container_wraps_the_exception() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain wrapping = (request, servletResponse) -> {
            try {
                request.getInputStream().readAllBytes();
            } catch (RequestBodyTooLargeException e) {
                throw new ServletException("could not read the body", new IllegalStateException(e));
            }
        };

        filter.doFilter(chunked("/api/v1/contact/messages", 101), response, wrapping);

        assertThat(response.getStatus()).isEqualTo(413);
    }

    @Test
    void a_413_replaces_what_the_chain_had_buffered_but_not_sent() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain writesThenReads = (request, servletResponse) -> {
            servletResponse.getOutputStream().write("partial".getBytes(StandardCharsets.UTF_8));
            request.getInputStream().readAllBytes();
        };

        filter.doFilter(chunked("/api/v1/contact/messages", 101), response, writesThenReads);

        assertThat(response.getStatus()).isEqualTo(413);
        assertThat(response.getContentAsString()).doesNotContain("partial").contains("VALIDATION_ERROR");
    }

    @Test
    void an_exception_that_is_not_about_the_size_is_not_swallowed() {
        FilterChain failing = (request, response) -> {
            throw new IOException("the client went away");
        };

        assertThatThrownBy(() ->
                        filter.doFilter(chunked("/api/v1/contact/messages", 5), new MockHttpServletResponse(), failing))
                .isInstanceOf(IOException.class)
                .hasMessage("the client went away");
    }

    @Test
    void a_response_that_is_already_sent_cannot_become_a_413_so_the_exception_goes_on() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain sendsThenReads = (request, servletResponse) -> {
            servletResponse.getOutputStream().write("sent".getBytes(StandardCharsets.UTF_8));
            servletResponse.flushBuffer();
            request.getInputStream().readAllBytes();
        };

        assertThatThrownBy(() -> filter.doFilter(chunked("/api/v1/contact/messages", 101), response, sendsThenReads))
                .isInstanceOf(RequestBodyTooLargeException.class);
        assertThat(response.getContentAsString()).isEqualTo("sent");
    }

    @Test
    void a_chunked_body_at_the_ceiling_is_read_whole() throws Exception {
        Probe chain = new Probe();

        filter.doFilter(chunked("/api/v1/contact/messages", 100), new MockHttpServletResponse(), chain);

        assertThat(chain.seen.get().getInputStream().readAllBytes()).hasSize(100);
    }

    @Test
    void a_chunked_body_read_through_the_reader_is_counted_too() throws Exception {
        MockHttpServletRequest request = chunked("/api/v1/contact/messages", 0);
        request.setContent("x".repeat(101).getBytes(StandardCharsets.UTF_8));
        request.setCharacterEncoding("UTF-8");
        Probe chain = new Probe();

        filter.doFilter(request, new MockHttpServletResponse(), chain);

        assertThatThrownBy(() -> {
                    try (var reader = chain.seen.get().getReader()) {
                        reader.transferTo(Writer.nullWriter());
                    }
                })
                .isInstanceOf(RequestBodyTooLargeException.class);
    }

    @Test
    void the_body_cannot_be_read_both_as_a_stream_and_as_a_reader() throws Exception {
        Probe chain = new Probe();
        filter.doFilter(chunked("/api/v1/contact/messages", 5), new MockHttpServletResponse(), chain);

        chain.seen.get().getInputStream();
        assertThatThrownBy(() -> chain.seen.get().getReader()).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void a_multipart_upload_is_left_to_its_own_limits() throws Exception {
        MockHttpServletRequest request = post("/api/v1/admin/media", 5000);
        request.setContentType("multipart/form-data; boundary=x");
        MockHttpServletResponse response = new MockHttpServletResponse();
        Probe chain = new Probe();

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(chain.calls).hasValue(1);
        assertThat(chain.seen.get()).isSameAs(request);
    }

    @Test
    void a_request_without_a_body_passes_untouched() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/posts");
        request.setServletPath("/api/v1/posts");
        request.setContent(new byte[0]);
        Probe chain = new Probe();

        filter.doFilter(request, new MockHttpServletResponse(), chain);

        assertThat(chain.calls).hasValue(1);
        // No length declared and nothing to count: the wrapper is harmless, and reading yields nothing.
        assertThat(chain.seen.get().getInputStream().readAllBytes()).isEmpty();
    }

    @Test
    void the_bounds_of_the_properties_are_checked_at_start() {
        DataSize ok = DataSize.ofKilobytes(64);
        assertThat(new RequestLimitProperties(ok, ok).publicBody()).isEqualTo(ok);

        assertThatThrownBy(() -> new RequestLimitProperties(DataSize.ofBytes(10), ok))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.request-limit.public-body");
        assertThatThrownBy(() -> new RequestLimitProperties(ok, DataSize.ofMegabytes(9)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.request-limit.admin-body");
        assertThatThrownBy(() -> new RequestLimitProperties(null, ok)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void the_defaults_are_64_kib_and_6_mib() {
        RequestLimitProperties defaults = new Binder(new MapConfigurationPropertySource())
                .bindOrCreate("app.request-limit", RequestLimitProperties.class);

        assertThat(defaults.publicBody().toBytes()).isEqualTo(64 * 1024);
        assertThat(defaults.adminBody().toBytes()).isEqualTo(6 * 1024 * 1024);
    }
}
