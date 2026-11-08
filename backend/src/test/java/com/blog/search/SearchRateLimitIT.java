package com.blog.search;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Global cap of {@code GET /api/v1/search} ({@code RateLimiter.SEARCH}, one key for the whole process). Own context
 * with a limit of 2/minute: exhausting the 1200 cap of the shared context would block search for every other test
 * class for a minute.
 */
@AutoConfigureMockMvc
@TestPropertySource(properties = "app.rate-limit.search.per-minute=2")
class SearchRateLimitIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void exceeding_global_cap_is_429_rate_limited_and_blank_q_costs_no_request() throws Exception {
        mockMvc.perform(get("/api/v1/search")).andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/search").param("q", "mot")).andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/search").param("q", "hai").param("type", "topic"))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/search").param("q", "ba"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        // Nothing to search: answered at once, does not touch the cap.
        mockMvc.perform(get("/api/v1/search").param("q", " ")).andExpect(status().isOk());
    }
}
