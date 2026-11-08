package com.blog.auth.oauth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.GithubLoginFlow;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

/**
 * The backend has no {@code GITHUB_*} at all: it still starts, password login still works, and the OAuth paths
 * return 404 ENDPOINT_NOT_FOUND, which Next turns into {@code /login?error=disabled}.
 *
 * A separate context (different property set), exactly the real shape: GITHUB_* is only read at startup. Overriding with
 * {@code @TestPropertySource} works because AbstractIntegrationTest sets these values there, not in
 * {@code @DynamicPropertySource}; the callback and SITE_URL are also empty, to prove startup does not need them.
 */
@AutoConfigureMockMvc
@TestPropertySource(
        properties = {
            "app.oauth.github.client-id=",
            "app.oauth.github.client-secret=",
            "app.oauth.github.redirect-uri=",
            "app.oauth.github.site-url="
        })
class GithubOAuthDisabledIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private ObjectProvider<ClientRegistrationRepository> registrations;

    @Autowired
    private GithubOAuthProperties properties;

    @Test
    void without_any_GITHUB_property_still_starts_and_has_no_registration() {
        assertThat(properties.enabled()).isFalse();
        assertThat(registrations.getIfAvailable()).isNull();
    }

    @Test
    void github_login_start_and_callback_return_404_ENDPOINT_NOT_FOUND() throws Exception {
        assertNotFound(
                mockMvc.perform(get(GithubLoginFlow.START_PATH)).andReturn().getResponse());
        assertNotFound(mockMvc.perform(get(GithubLoginFlow.CALLBACK_PATH)
                        .queryParam("code", "mot-code")
                        .queryParam("state", "mot-state"))
                .andReturn()
                .getResponse());
    }

    @Test
    void password_login_still_works() throws Exception {
        // The password is accepted as the first factor (202, the second step is due): GitHub being off changes nothing.
        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"admin@blog.local\",\"password\":\"admin12345\"}"))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.data.challenge").isNotEmpty());
    }

    private void assertNotFound(MockHttpServletResponse response) throws Exception {
        String body = response.getContentAsString();
        assertThat(response.getStatus()).as(body).isEqualTo(404);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .isEqualTo("ENDPOINT_NOT_FOUND");
        // No half measures: no blob, no redirect anywhere.
        assertThat(response.getHeader("Location")).isNull();
        assertThat(response.getHeaders("Set-Cookie")).isEmpty();
    }
}
