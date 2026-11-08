package com.blog.common.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * The trust rule for the forwarded reader address: it is believed only together with the shared secret, otherwise the
 * socket address counts and the two headers are ignored altogether.
 */
class ClientAddressResolverTest {

    private static final String TOKEN = "unit-test-client-ip-token-not-a-real-secret";

    private final ClientAddressResolver trusting = new ClientAddressResolver(new ClientIpProperties(TOKEN));
    private final ClientAddressResolver noToken = new ClientAddressResolver(new ClientIpProperties(""));

    private static MockHttpServletRequest request(String socket, String forwarded, String token) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr(socket);
        if (forwarded != null) {
            request.addHeader(ClientAddressResolver.ADDRESS_HEADER, forwarded);
        }
        if (token != null) {
            request.addHeader(ClientAddressResolver.TOKEN_HEADER, token);
        }
        return request;
    }

    @Test
    void the_forwarded_address_is_used_when_the_token_matches() {
        assertThat(trusting.resolve(request("10.0.0.5", "203.0.113.9", TOKEN)).key())
                .isEqualTo("203.0.113.9");
    }

    @Test
    void a_forwarded_ipv6_address_counts_as_its_64_prefix() {
        assertThat(trusting.resolve(request("10.0.0.5", "2001:db8:1:2::77", TOKEN))
                        .key())
                .isEqualTo("2001:db8:1:2::/64");
    }

    @Test
    void a_wrong_token_leaves_the_forwarded_address_unread_and_the_socket_address_counts() {
        for (String wrong : new String[] {"", " ", "wrong", TOKEN + "x", TOKEN.substring(1), TOKEN.toUpperCase()}) {
            assertThat(trusting.resolve(request("198.51.100.7", "203.0.113.9", wrong))
                            .key())
                    .as("token [%s]", wrong)
                    .isEqualTo("198.51.100.7");
        }
    }

    @Test
    void no_token_at_all_means_the_socket_address_even_when_an_address_is_forwarded() {
        assertThat(trusting.resolve(request("198.51.100.7", "203.0.113.9", null))
                        .key())
                .isEqualTo("198.51.100.7");
    }

    @Test
    void a_caller_cannot_rotate_its_key_by_writing_the_address_header_without_the_secret() {
        String first =
                trusting.resolve(request("198.51.100.7", "203.0.113.1", null)).key();
        String second =
                trusting.resolve(request("198.51.100.7", "203.0.113.2", null)).key();

        assertThat(first).isEqualTo(second).isEqualTo("198.51.100.7");
    }

    @Test
    void when_no_token_is_configured_nothing_is_believed_not_even_an_empty_token() {
        assertThat(noToken.resolve(request("198.51.100.7", "203.0.113.9", "")).key())
                .isEqualTo("198.51.100.7");
        assertThat(noToken.resolve(request("198.51.100.7", "203.0.113.9", TOKEN))
                        .key())
                .isEqualTo("198.51.100.7");
        assertThat(noToken.resolve(request("198.51.100.7", null, null)).key()).isEqualTo("198.51.100.7");
    }

    @Test
    void a_trusted_request_without_a_usable_address_counts_as_unknown_and_not_as_the_socket_address() {
        for (String forwarded :
                new String[] {null, "", "unknown", "not an ip", "203.0.113.9:80", "203.0.113.9, 1.2.3.4"}) {
            assertThat(trusting.resolve(request("10.0.0.5", forwarded, TOKEN)))
                    .as("forwarded [%s]", forwarded)
                    .isEqualTo(ClientAddress.UNKNOWN);
        }
    }

    @Test
    void x_forwarded_for_is_never_read() {
        MockHttpServletRequest request = request("198.51.100.7", null, TOKEN);
        request.addHeader("X-Forwarded-For", "203.0.113.9");
        request.addHeader("X-Real-IP", "203.0.113.10");
        request.addHeader("Forwarded", "for=203.0.113.11");

        assertThat(trusting.resolve(request)).isEqualTo(ClientAddress.UNKNOWN);
        assertThat(noToken.resolve(request).key()).isEqualTo("198.51.100.7");
    }

    @Test
    void an_unreadable_socket_address_counts_as_unknown() {
        assertThat(noToken.resolve(request("", null, null))).isEqualTo(ClientAddress.UNKNOWN);
    }

    @Test
    void ipv4_mapped_socket_addresses_and_ipv6_loopback_are_normalized_like_forwarded_ones() {
        assertThat(noToken.resolve(request("::ffff:198.51.100.7", null, null)).key())
                .isEqualTo("198.51.100.7");
        assertThat(noToken.resolve(request("0:0:0:0:0:0:0:1", null, null)).key())
                .isEqualTo("0:0:0:0::/64");
    }

    @Test
    void the_properties_never_print_the_token() {
        assertThat(new ClientIpProperties(" " + TOKEN + " ").toString()).doesNotContain(TOKEN);
        assertThat(new ClientIpProperties(null).tokenSet()).isFalse();
        assertThat(new ClientIpProperties("  ").tokenSet()).isFalse();
        assertThat(new ClientIpProperties(" " + TOKEN + " ").token()).isEqualTo(TOKEN);
    }
}
