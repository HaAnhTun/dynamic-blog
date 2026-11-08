package com.blog.common.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

/**
 * The per-client-address limits through the real filter chain, controllers, services and database, in a context of its
 * own with the real numbers scaled down (the shared test configuration lifts them): contact, newsletter signup, confirm,
 * login, the second step of a sign-in, refresh and search. Every test uses addresses of its own, because the limiter is shared by the whole context.
 *
 * What it proves beyond the unit tests: the forwarded address is believed only with the secret (the headers of a caller
 * who reaches the backend directly change nothing), rotating the email address or the forwarded address does not give a
 * fresh quota, and one client over its limit does not block another.
 */
@AutoConfigureMockMvc
@TestPropertySource(
        properties = {
            "app.client-ip.token=" + ClientAddressLimitsIT.TOKEN,
            "app.rate-limit.contact-client.per-hour=5",
            "app.rate-limit.newsletter-signup-client.per-hour=2",
            "app.rate-limit.newsletter-token-client.per-hour=2",
            "app.rate-limit.login-client.per-ten-minutes=3",
            "app.rate-limit.mfa-client.per-ten-minutes=3",
            "app.rate-limit.refresh-client.per-ten-minutes=2",
            "app.rate-limit.search-client.per-minute=2"
        })
class ClientAddressLimitsIT extends AbstractIntegrationTest {

    static final String TOKEN = "limits-it-client-ip-token-not-a-real-secret";
    private static final String ADMIN_LOGIN =
            "{\"email\":\"admin@blog.local\",\"password\":\"" + SeedAdmin.DEV_PASSWORD + "\"}";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    /** A request the way Next sends it: the reader's address and the shared secret. */
    private static MockHttpServletRequestBuilder forwarded(MockHttpServletRequestBuilder request, String reader) {
        return request.header(ClientAddressResolver.ADDRESS_HEADER, reader)
                .header(ClientAddressResolver.TOKEN_HEADER, TOKEN);
    }

    /** A request that reaches the backend directly from this socket address. */
    private static MockHttpServletRequestBuilder from(MockHttpServletRequestBuilder request, String socket) {
        return request.with(r -> {
            r.setRemoteAddr(socket);
            return r;
        });
    }

    private ResultActions json(MockHttpServletRequestBuilder request, String body) throws Exception {
        return mockMvc.perform(request.contentType(APPLICATION_JSON).content(body));
    }

    private ResultActions contact(MockHttpServletRequestBuilder request, String email) throws Exception {
        return json(request, """
                {"name":"Visitor","email":"%s","subject":"Hello","message":"A message long enough to be accepted."}""".formatted(email));
    }

    private int storedMessages(String emailPrefix) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM contact_messages WHERE email LIKE ?", Integer.class, emailPrefix + "%");
        return count == null ? 0 : count;
    }

    // --- Contact ----------------------------------------------------------------------------------------

    @Test
    void
            contact_from_one_forwarded_address_stops_at_the_limit_whatever_the_email_address_and_the_other_reader_is_not_blocked()
                    throws Exception {
        String prefix = "limits-it-contact-a-";
        for (int i = 0; i < 5; i++) {
            contact(forwarded(post("/api/v1/contact/messages"), "192.0.2.11"), prefix + i + "@example.com")
                    .andExpect(status().isAccepted());
        }

        contact(forwarded(post("/api/v1/contact/messages"), "192.0.2.11"), prefix + "5@example.com")
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        assertThat(storedMessages(prefix)).isEqualTo(5);

        contact(forwarded(post("/api/v1/contact/messages"), "192.0.2.12"), prefix + "other@example.com")
                .andExpect(status().isAccepted());
    }

    @Test
    void contact_a_caller_who_writes_the_address_header_without_the_secret_cannot_rotate_its_key() throws Exception {
        String prefix = "limits-it-contact-b-";
        for (int i = 0; i < 5; i++) {
            contact(
                            from(post("/api/v1/contact/messages"), "198.51.100.21")
                                    .header(ClientAddressResolver.ADDRESS_HEADER, "192.0.2." + (100 + i)),
                            prefix + i + "@example.com")
                    .andExpect(status().isAccepted());
        }

        // A new forged address each time and a wrong secret: the socket address is still what counts.
        contact(
                        from(post("/api/v1/contact/messages"), "198.51.100.21")
                                .header(ClientAddressResolver.ADDRESS_HEADER, "192.0.2.150")
                                .header(ClientAddressResolver.TOKEN_HEADER, "a-wrong-secret"),
                        prefix + "5@example.com")
                .andExpect(status().isTooManyRequests());
        assertThat(storedMessages(prefix)).isEqualTo(5);

        contact(from(post("/api/v1/contact/messages"), "198.51.100.22"), prefix + "other@example.com")
                .andExpect(status().isAccepted());
    }

    // --- Newsletter -------------------------------------------------------------------------------------

    @Test
    void newsletter_signups_from_one_forwarded_address_queue_at_most_the_limit_and_every_call_gets_the_same_answer()
            throws Exception {
        String prefix = "limits-it-nl-";
        String firstBody = null;
        for (int i = 0; i < 5; i++) {
            String body = json(
                            forwarded(post("/api/v1/newsletter/subscriptions"), "192.0.2.31"),
                            "{\"email\":\"" + prefix + i + "@example.com\"}")
                    .andExpect(status().isAccepted())
                    .andReturn()
                    .getResponse()
                    .getContentAsString();
            firstBody = firstBody == null ? body : firstBody;
            assertThat(body).isEqualTo(firstBody);
        }

        Integer queued = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM newsletter_subscribers WHERE email LIKE ?", Integer.class, prefix + "%");
        assertThat(queued).isEqualTo(2);
    }

    @Test
    void newsletter_confirm_and_unsubscribe_share_a_per_client_limit_that_answers_429() throws Exception {
        String token = "A".repeat(43);
        json(forwarded(post("/api/v1/newsletter/confirm"), "192.0.2.41"), "{\"token\":\"" + token + "\"}")
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("NEWSLETTER_TOKEN_INVALID"));
        json(forwarded(post("/api/v1/newsletter/unsubscribe"), "192.0.2.41"), "{\"token\":\"" + token + "\"}")
                .andExpect(status().isBadRequest());

        json(forwarded(post("/api/v1/newsletter/confirm"), "192.0.2.41"), "{\"token\":\"" + token + "\"}")
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        json(forwarded(post("/api/v1/newsletter/confirm"), "192.0.2.42"), "{\"token\":\"" + token + "\"}")
                .andExpect(status().isBadRequest());
    }

    // --- Sign in and refresh ----------------------------------------------------------------------------

    @Test
    void
            login_attempts_from_one_forwarded_address_are_limited_before_the_password_is_checked_and_another_reader_signs_in()
                    throws Exception {
        String wrong = "{\"email\":\"nobody@example.com\",\"password\":\"not-the-password\"}";
        for (int i = 0; i < 3; i++) {
            json(forwarded(post("/api/v1/auth/login"), "192.0.2.51"), wrong).andExpect(status().isUnauthorized());
        }

        json(forwarded(post("/api/v1/auth/login"), "192.0.2.51"), wrong)
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        // The right password does not help the address that is over its limit ...
        json(forwarded(post("/api/v1/auth/login"), "192.0.2.51"), ADMIN_LOGIN).andExpect(status().isTooManyRequests());
        // ... and does not need to: another reader is a separate count. An administrator's right password is answered
        // with a challenge for the second step (202), never with tokens.
        json(forwarded(post("/api/v1/auth/login"), "192.0.2.52"), ADMIN_LOGIN).andExpect(status().isAccepted());
    }

    @Test
    void login_a_direct_caller_cannot_get_a_fresh_count_by_inventing_addresses() throws Exception {
        String wrong = "{\"email\":\"nobody@example.com\",\"password\":\"not-the-password\"}";
        for (int i = 0; i < 3; i++) {
            json(
                            from(post("/api/v1/auth/login"), "198.51.100.61")
                                    .header(ClientAddressResolver.ADDRESS_HEADER, "192.0.2." + (200 + i)),
                            wrong)
                    .andExpect(status().isUnauthorized());
        }

        json(
                        from(post("/api/v1/auth/login"), "198.51.100.61")
                                .header(ClientAddressResolver.ADDRESS_HEADER, "192.0.2.250"),
                        wrong)
                .andExpect(status().isTooManyRequests());
    }

    @Test
    void refresh_attempts_from_one_forwarded_address_are_limited() throws Exception {
        String unknownToken = "{\"refreshToken\":\"" + "x".repeat(43) + "\"}";
        for (int i = 0; i < 2; i++) {
            json(forwarded(post("/api/v1/auth/refresh"), "192.0.2.71"), unknownToken)
                    .andExpect(status().isUnauthorized());
        }

        json(forwarded(post("/api/v1/auth/refresh"), "192.0.2.71"), unknownToken)
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        json(forwarded(post("/api/v1/auth/refresh"), "192.0.2.72"), unknownToken)
                .andExpect(status().isUnauthorized());
    }

    // --- The second step of a sign-in --------------------------------------------------------------------

    @Test
    void
            the_three_second_step_endpoints_share_one_per_address_limit_that_answers_429_before_the_challenge_is_looked_at()
                    throws Exception {
        String challenge = "x".repeat(43);
        String verify = "{\"challenge\":\"" + challenge + "\",\"code\":\"123456\"}";
        String begin = "{\"challenge\":\"" + challenge + "\"}";
        // A challenge the backend does not know: three different endpoints, three attempts, the same refusal each time.
        json(forwarded(post("/api/v1/auth/mfa/verify"), "192.0.2.91"), verify)
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("MFA_CHALLENGE_INVALID"));
        json(forwarded(post("/api/v1/auth/mfa/enroll/begin"), "192.0.2.91"), begin)
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("MFA_CHALLENGE_INVALID"));
        json(forwarded(post("/api/v1/auth/mfa/enroll/confirm"), "192.0.2.91"), verify)
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("MFA_CHALLENGE_INVALID"));

        // The fourth attempt is over the limit whichever endpoint it goes to: 429, and the account counters are not
        // reached.
        json(forwarded(post("/api/v1/auth/mfa/verify"), "192.0.2.91"), verify)
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        json(forwarded(post("/api/v1/auth/mfa/enroll/begin"), "192.0.2.91"), begin)
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        json(forwarded(post("/api/v1/auth/mfa/enroll/confirm"), "192.0.2.91"), verify)
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        // Another reader is a separate count, and the sign-in limit of the same address is a different bucket.
        json(forwarded(post("/api/v1/auth/mfa/verify"), "192.0.2.92"), verify).andExpect(status().isUnauthorized());
        json(
                        forwarded(post("/api/v1/auth/login"), "192.0.2.91"),
                        "{\"email\":\"nobody@example.com\",\"password\":\"not-the-password\"}")
                .andExpect(status().isUnauthorized());
    }

    @Test
    void second_step_a_direct_caller_cannot_get_a_fresh_count_by_inventing_addresses() throws Exception {
        String verify = "{\"challenge\":\"" + "y".repeat(43) + "\",\"code\":\"123456\"}";
        for (int i = 0; i < 3; i++) {
            json(
                            from(post("/api/v1/auth/mfa/verify"), "198.51.100.93")
                                    .header(ClientAddressResolver.ADDRESS_HEADER, "192.0.2." + (200 + i)),
                            verify)
                    .andExpect(status().isUnauthorized());
        }

        json(
                        from(post("/api/v1/auth/mfa/verify"), "198.51.100.93")
                                .header(ClientAddressResolver.ADDRESS_HEADER, "192.0.2.250"),
                        verify)
                .andExpect(status().isTooManyRequests());
    }

    // --- Search -----------------------------------------------------------------------------------------

    @Test
    void search_from_one_forwarded_address_is_limited_per_client_so_it_cannot_use_up_the_shared_ceiling()
            throws Exception {
        for (int i = 0; i < 2; i++) {
            mockMvc.perform(forwarded(get("/api/v1/search").param("q", "spring" + i), "192.0.2.81"))
                    .andExpect(status().isOk());
        }

        mockMvc.perform(forwarded(get("/api/v1/search").param("q", "spring2"), "192.0.2.81"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        // Nothing to search for costs no turn.
        mockMvc.perform(forwarded(get("/api/v1/search").param("q", " "), "192.0.2.81"))
                .andExpect(status().isOk());
        // Another reader is not affected.
        mockMvc.perform(forwarded(get("/api/v1/search").param("q", "spring"), "192.0.2.82"))
                .andExpect(status().isOk());
    }
}
