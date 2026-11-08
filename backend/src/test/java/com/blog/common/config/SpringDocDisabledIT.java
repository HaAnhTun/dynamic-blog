package com.blog.common.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.blog.support.AbstractIntegrationTest;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

/**
 * Swagger off, as the default of the jar and the Docker image: every other IT runs with it ON (AbstractIntegrationTest),
 * so this separate context is the only place that sees the off branch run for real.
 *
 * SecurityConfig is still {@code permitAll} on the Swagger paths: when off the request reaches the DispatcherServlet and gets 404
 * {@code ENDPOINT_NOT_FOUND} like any path that does not exist, not 401 or 403, which would tell the caller something is there.
 */
@AutoConfigureMockMvc
@TestPropertySource(properties = {"springdoc.api-docs.enabled=false", "springdoc.swagger-ui.enabled=false"})
class SpringDocDisabledIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void when_off_api_docs_and_swagger_ui_are_404_ENDPOINT_NOT_FOUND() throws Exception {
        for (String path :
                List.of("/v3/api-docs", "/v3/api-docs/swagger-config", "/swagger-ui.html", "/swagger-ui/index.html")) {
            MockHttpServletResponse response =
                    mockMvc.perform(get(path)).andReturn().getResponse();
            String body = response.getContentAsString();
            assertThat(response.getStatus()).as("%s: %s", path, body).isEqualTo(404);
            assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                    .as(path)
                    .isEqualTo("ENDPOINT_NOT_FOUND");
        }
    }

    @Test
    void rest_of_the_API_still_works() throws Exception {
        // Control: the 404 above is because Swagger is off, not because this context is broken.
        assertThat(mockMvc.perform(get("/api/v1/health"))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(200);
    }
}
