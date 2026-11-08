package com.blog.common.config;

import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpMethod;
import org.springframework.test.web.servlet.MockMvc;

/**
 * A request that the Spring Security firewall refuses (a matrix parameter, a method outside the standard ones) is a malformed request, so it
 * is answered with the API's 400 envelope by {@code ApiRequestRejectedHandler} (issue 105). Before, the container
 * dispatched it again to {@code /error} without the caller's token and the answer was a 401 "Authentication required".
 * Nothing in these variants ever reached an ADMIN handler; the point is the status code and the body shape.
 */
@AutoConfigureMockMvc
class SecurityFirewallRejectionIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Test
    void a_matrix_parameter_on_an_admin_path_is_a_400_envelope_for_an_author() throws Exception {
        User author = auth.createAuthor("firewall-author-matrix@blog.local");

        mockMvc.perform(get("/api/v1/admin/users;x=1").header("Authorization", auth.bearerFor(author)))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(APPLICATION_JSON))
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"))
                .andExpect(jsonPath("$.error.message").value("Malformed request"))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());
    }

    @Test
    void a_double_slash_is_not_refused_by_the_firewall_and_never_reaches_an_admin_handler() throws Exception {
        // The firewall accepts a literal double slash; the path rules and MVC then treat the path like any other. The
        // author is
        // denied (403) and an unknown public path is a plain 404: neither is a 2xx, and neither is the 401 of an error
        // dispatch.
        User author = auth.createAuthor("firewall-author-slash@blog.local");

        mockMvc.perform(get("/api/v1/admin//users").header("Authorization", auth.bearerFor(author)))
                .andExpect(status().isForbidden());
        mockMvc.perform(get("/api/v1/posts//x"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").isNotEmpty());
    }

    @Test
    void an_unknown_http_method_on_an_admin_path_is_a_400_envelope_for_an_author() throws Exception {
        // The firewall allows the standard methods of a REST API only. (TRACE never gets this far on a real server:
        // Tomcat refuses it
        // first, and ApiErrorDispatchFilterTest covers that answer.)
        User author = auth.createAuthor("firewall-author-method@blog.local");

        mockMvc.perform(request(HttpMethod.valueOf("FOO"), "/api/v1/admin/users")
                        .header("Authorization", auth.bearerFor(author)))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(APPLICATION_JSON))
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void the_same_malformed_requests_are_a_400_without_a_token_too_not_a_401() throws Exception {
        mockMvc.perform(get("/api/v1/admin/users;x=1"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        mockMvc.perform(get("/api/v1/posts/x;y=1"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        mockMvc.perform(request(HttpMethod.valueOf("FOO"), "/api/v1/admin/users"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void a_well_formed_request_is_still_denied_as_before() throws Exception {
        // The control: the handler changes the answer to malformed requests only.
        User author = auth.createAuthor("firewall-author-control@blog.local");

        mockMvc.perform(get("/api/v1/admin/users")).andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", auth.bearerFor(author)))
                .andExpect(status().isForbidden());
    }
}
