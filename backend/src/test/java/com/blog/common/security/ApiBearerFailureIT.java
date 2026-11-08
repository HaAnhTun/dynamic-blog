package com.blog.common.security;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;

/** DB failure while checking the authority of an ADMIN/AUTHOR claim: 503 with an error envelope, not an error escaping the filter chain. */
@AutoConfigureMockMvc
class ApiBearerFailureIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @MockitoSpyBean
    private UserRepository userRepository;

    @Test
    void unreadable_current_access_gives_503_with_envelope_for_every_role() throws Exception {
        String admin = auth.bearerForAdmin();
        String reader = auth.bearerFor(auth.createReader(auth.nextGithubId(), "doc-gia-503"));
        doThrow(new DataAccessResourceFailureException("database down"))
                .when(userRepository)
                .findAccessById(any());

        mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", admin))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.error.code").value("INTERNAL_ERROR"))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());

        // A reader is checked against the database too (revocation): fail closed, never trust the claim alone.
        mockMvc.perform(get("/api/v1/posts").header("Authorization", reader))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.error.code").value("INTERNAL_ERROR"));
    }
}
