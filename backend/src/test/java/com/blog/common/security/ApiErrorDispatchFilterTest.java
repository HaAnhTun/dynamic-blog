package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * The container's error dispatch (issue 105): Tomcat refuses {@code TRACE} with a 405 before Spring sees it and dispatches the
 * request to {@code /error} without the caller's token, which the security chain answered with a 401. The filter answers it with the
 * API's envelope and the status the container chose, and the chain never runs.
 */
class ApiErrorDispatchFilterTest {

    private final ObjectMapper mapper = JsonMapper.builder().build();
    private final ApiErrorDispatchFilter filter = new ApiErrorDispatchFilter(mapper);

    private static MockHttpServletRequest errorDispatch(String method, Integer status) {
        MockHttpServletRequest request = new MockHttpServletRequest(method, "/error");
        request.setDispatcherType(DispatcherType.ERROR);
        if (status != null) {
            request.setAttribute(RequestDispatcher.ERROR_STATUS_CODE, status);
        }
        request.setAttribute(RequestDispatcher.ERROR_REQUEST_URI, "/api/v1/posts/a-slug-the-caller-chose");
        request.setAttribute(RequestDispatcher.ERROR_MESSAGE, "TRACE method is not allowed");
        return request;
    }

    private JsonNode error(MockHttpServletResponse response) throws Exception {
        return mapper.readTree(response.getContentAsString()).path("error");
    }

    /** A chain that counts its runs. */
    private static final class CountingChain extends MockFilterChain {
        final AtomicInteger runs = new AtomicInteger();

        @Override
        public void doFilter(ServletRequest request, ServletResponse response) {
            runs.incrementAndGet();
        }
    }

    @Test
    void trace_refused_by_the_container_is_a_405_envelope_and_not_a_401() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        CountingChain chain = new CountingChain();

        filter.doFilter(errorDispatch("TRACE", 405), response, chain);

        assertThat(response.getStatus()).isEqualTo(405);
        assertThat(response.getContentType()).startsWith("application/json");
        JsonNode error = error(response);
        assertThat(error.path("code").asString()).isEqualTo("VALIDATION_ERROR");
        assertThat(error.path("message").asString()).isEqualTo("The request could not be processed");
        assertThat(error.path("traceId").asString()).isNotBlank();
        // The container's message and the path the caller chose are not copied into the answer, and nothing was echoed.
        assertThat(response.getContentAsString()).doesNotContain("TRACE", "a-slug-the-caller-chose");
        assertThat(chain.runs).hasValue(0);
    }

    @Test
    void a_404_keeps_the_endpoint_not_found_code_and_a_5xx_is_a_generic_internal_error() throws Exception {
        MockHttpServletResponse notFound = new MockHttpServletResponse();
        filter.doFilter(errorDispatch("GET", 404), notFound, new CountingChain());
        assertThat(notFound.getStatus()).isEqualTo(404);
        assertThat(error(notFound).path("code").asString()).isEqualTo("ENDPOINT_NOT_FOUND");

        MockHttpServletResponse broken = new MockHttpServletResponse();
        filter.doFilter(errorDispatch("GET", 500), broken, new CountingChain());
        assertThat(broken.getStatus()).isEqualTo(500);
        assertThat(error(broken).path("code").asString()).isEqualTo("INTERNAL_ERROR");
        assertThat(error(broken).path("message").asString()).doesNotContain("TRACE");
    }

    @Test
    void a_missing_or_odd_status_counts_as_a_server_error() throws Exception {
        MockHttpServletResponse missing = new MockHttpServletResponse();
        filter.doFilter(errorDispatch("GET", null), missing, new CountingChain());
        assertThat(missing.getStatus()).isEqualTo(500);

        MockHttpServletResponse odd = new MockHttpServletResponse();
        filter.doFilter(errorDispatch("GET", 200), odd, new CountingChain());
        assertThat(odd.getStatus()).isEqualTo(500);
    }

    @Test
    void a_committed_response_is_left_alone() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        response.getWriter().write("already answered");
        response.flushBuffer();
        CountingChain chain = new CountingChain();

        filter.doFilter(errorDispatch("GET", 400), response, chain);

        assertThat(response.getContentAsString()).isEqualTo("already answered");
        assertThat(chain.runs).hasValue(0);
    }

    @Test
    void a_request_of_the_normal_dispatch_goes_through_to_the_chain() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/posts");
        MockHttpServletResponse response = new MockHttpServletResponse();
        CountingChain chain = new CountingChain();

        filter.doFilter(request, response, chain);

        assertThat(chain.runs).hasValue(1);
        assertThat(response.getContentAsString()).isEmpty();
    }

    @Test
    void the_registration_is_for_the_error_dispatch_only_and_ahead_of_the_security_chain() {
        FilterRegistrationBean<ApiErrorDispatchFilter> registration =
                new ApiErrorDispatchConfig().apiErrorDispatchFilter(mapper);

        assertThat(registration.getFilter()).isInstanceOf(ApiErrorDispatchFilter.class);
        assertThat(registration.getOrder()).isLessThan(-100);
        assertThat(registration.determineDispatcherTypes()).containsExactly(DispatcherType.ERROR);
    }
}
