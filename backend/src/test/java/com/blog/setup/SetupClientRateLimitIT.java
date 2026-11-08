package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.common.ratelimit.ClientAddressResolver;
import com.blog.support.AbstractIntegrationTest;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

/**
 * The first-run setup is limited per client address as well as for the whole process, and the per-client count comes first:
 * a caller who has used up its own attempts is refused (the right code included, so the answer is no oracle) without taking
 * a turn of the process-wide count, and another reader is not blocked by it. A caller who only writes the address header,
 * without the shared secret, gets no fresh count.
 */
@TestPropertySource(
        properties = {
            "app.client-ip.token=" + SetupClientRateLimitIT.TOKEN,
            "app.rate-limit.setup-client.per-minute=2",
            "app.rate-limit.setup.per-minute=100"
        })
class SetupClientRateLimitIT extends SetupIntegrationTest {

    static final String TOKEN = "setup-it-client-ip-token-not-a-real-secret";
    private static final Path DATA_DIR = temporaryDirectory("setup-client-rate-limit-it");

    @DynamicPropertySource
    static void isolated(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "setup_client_rate_limit_it");
        registry.add("app.setup.data-dir", DATA_DIR::toString);
    }

    private MockHttpServletResponse attempt(MockHttpServletRequestBuilder request, String code) throws Exception {
        Map<String, Object> body = Map.of(
                "setupCode", code, "email", "owner@example.test", "password", STRONG_PASSWORD, "displayName", "Owner");
        return mockMvc.perform(request.contentType(APPLICATION_JSON).content(objectMapper.writeValueAsString(body)))
                .andReturn()
                .getResponse();
    }

    private static MockHttpServletRequestBuilder forwarded(String reader) {
        return post("/api/v1/setup")
                .header(ClientAddressResolver.ADDRESS_HEADER, reader)
                .header(ClientAddressResolver.TOKEN_HEADER, TOKEN);
    }

    private static MockHttpServletRequestBuilder direct(String socket, String claimedReader) {
        return post("/api/v1/setup")
                .header(ClientAddressResolver.ADDRESS_HEADER, claimedReader)
                .with(r -> {
                    r.setRemoteAddr(socket);
                    return r;
                });
    }

    @Test
    void a_client_over_its_own_limit_is_refused_even_with_the_right_code_while_another_reader_can_still_claim()
            throws Exception {
        String code = readCode(DATA_DIR);
        for (int i = 0; i < 2; i++) {
            assertError(attempt(forwarded("192.0.2.91"), "wrong-" + i), 403, "SETUP_CODE_INVALID");
        }

        assertError(attempt(forwarded("192.0.2.91"), "wrong-2"), 429, "RATE_LIMITED");
        assertError(attempt(forwarded("192.0.2.91"), code), 429, "RATE_LIMITED");
        assertThat(setupCompletedInDatabase()).isFalse();

        // Writing an address without the secret changes nothing: the socket address is what counts.
        for (int i = 0; i < 2; i++) {
            assertError(
                    attempt(direct("198.51.100.92", "192.0.2." + (100 + i)), "wrong-" + i), 403, "SETUP_CODE_INVALID");
        }
        assertError(attempt(direct("198.51.100.92", "192.0.2.150"), "wrong-2"), 429, "RATE_LIMITED");

        // The owner, from another address, claims the instance.
        MockHttpServletResponse claimed = attempt(forwarded("192.0.2.93"), code);
        assertThat(claimed.getStatus()).as(claimed.getContentAsString()).isEqualTo(201);
        assertThat(setupCompletedInDatabase()).isTrue();
    }
}
