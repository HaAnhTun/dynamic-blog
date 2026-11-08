package com.blog.common.health;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

@AutoConfigureMockMvc
class HealthControllerIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void healthIsReachableWithoutATokenAndReportsTheDatabase() throws Exception {
        // No Authorization header, and that is the assertion that matters. The filter
        // chain's fallback is denyAll rather than authenticated, so a path nobody wrote an
        // explicit permitAll rule for answers 403 — and a health check that always answers
        // 403 is one a reverse proxy believes, which takes the whole site out of rotation on
        // the first deploy. Nothing but this test stands between that and production.
        mockMvc.perform(get("/api/v1/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("UP"))
                .andExpect(jsonPath("$.data.database").value("UP"));
    }

    @Test
    void healthCarriesTheProjectEnvelope() throws Exception {
        // Under `data`, like every other success response in this API. A monitoring endpoint
        // that invented its own shape would be the one thing a client has to special-case.
        mockMvc.perform(get("/api/v1/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").isMap())
                .andExpect(jsonPath("$.error").doesNotExist());
    }
}
