package com.blog.common.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * What counts as "the same caller": an IPv4 address is itself, an IPv6 address is its whole /64, an IPv4-mapped IPv6
 * address is that IPv4 address, and anything that is not an IP address literal is not a key at all. Mirrors
 * {@code rateLimitSubject} in frontend/lib/rate-limit.ts.
 */
class ClientAddressTest {

    private static String key(String literal) {
        return ClientAddress.parse(literal).map(ClientAddress::key).orElse(null);
    }

    @Test
    void an_ipv4_address_is_its_own_key() {
        assertThat(key("203.0.113.9")).isEqualTo("203.0.113.9");
        assertThat(key("  203.0.113.9 ")).isEqualTo("203.0.113.9");
        assertThat(key("127.0.0.1")).isEqualTo("127.0.0.1");
    }

    @Test
    void every_address_of_one_ipv6_64_prefix_has_the_same_key_and_other_prefixes_differ() {
        String key = key("2001:db8:1:2:aaaa:bbbb:cccc:dddd");

        assertThat(key).isEqualTo("2001:db8:1:2::/64");
        assertThat(key("2001:db8:1:2::1")).isEqualTo(key);
        assertThat(key("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).isEqualTo(key);
        assertThat(key("2001:db8:1:3::1")).isNotEqualTo(key);
        assertThat(key("2001:db8:1:2::1%eth0")).isEqualTo(key);
    }

    @Test
    void the_ipv6_loopback_and_the_unspecified_address_are_ordinary_prefixes() {
        assertThat(key("::1")).isEqualTo("0:0:0:0::/64");
        assertThat(key("0:0:0:0:0:0:0:1")).isEqualTo("0:0:0:0::/64");
        assertThat(key("::")).isEqualTo("0:0:0:0::/64");
    }

    @Test
    void an_ipv4_mapped_ipv6_address_counts_as_the_ipv4_address() {
        assertThat(key("::ffff:203.0.113.9")).isEqualTo("203.0.113.9");
        assertThat(key("0:0:0:0:0:ffff:203.0.113.9")).isEqualTo("203.0.113.9");
    }

    static Stream<String> notAddresses() {
        return Stream.of(
                null,
                "",
                "   ",
                "unknown",
                "localhost",
                "example.com",
                "203.0.113",
                "203.0.113.9.1",
                "203.0.113.256",
                "203.0.113.9:8080",
                "[2001:db8::1]",
                "[2001:db8::1]:443",
                "2001:db8::1::2",
                "2001:db8:1:2:3:4:5:6:7",
                "2001:db8::g",
                "203.0.113.9, 198.51.100.1",
                "203.0.113.9\n198.51.100.1",
                "0x7f.0.0.1",
                "1".repeat(60));
    }

    @ParameterizedTest
    @MethodSource("notAddresses")
    void anything_that_is_not_an_ip_address_literal_is_not_a_key(String literal) {
        assertThat(ClientAddress.parse(literal)).isEmpty();
    }

    @Test
    void unknown_is_a_key_no_address_can_have() {
        assertThat(ClientAddress.UNKNOWN.key()).isEqualTo("unknown");
        assertThat(ClientAddress.parse("unknown")).isEmpty();
    }

    @Test
    void the_address_is_never_printed() {
        assertThat(ClientAddress.parse("203.0.113.9").orElseThrow().toString()).doesNotContain("203.0.113.9");
    }
}
