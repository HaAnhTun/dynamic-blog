package com.blog.common.ratelimit;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Where a request comes from, as a key for the per-address rate limits (never shown to anyone and never logged).
 *
 * The key is the address as it should be counted: an IPv4 address is the address itself; an IPv6 address is the whole
 * /64 that contains it (providers hand a /64 to one customer, so counting single addresses would give a fresh quota for
 * every change of the last 64 bits), written {@code 2001:db8:1:2::/64}; an IPv4-mapped IPv6 address
 * ({@code ::ffff:192.0.2.1}) counts as that IPv4 address. The same rule as {@code rateLimitSubject} in the frontend's
 * lib/rate-limit.ts, so a reader has the same identity on both sides.
 *
 * {@link #UNKNOWN} is the key of a request whose address could not be determined: those share one quota (fail soft,
 * not fail open).
 *
 * @param key the normalized address or {@code "unknown"}
 */
public record ClientAddress(String key) {

    /** Requests with no usable address share this one key. */
    public static final ClientAddress UNKNOWN = new ClientAddress("unknown");

    private static final int MAX_LITERAL_LENGTH = 45;
    private static final Pattern IPV4 = Pattern.compile("\\d{1,3}(?:\\.\\d{1,3}){3}");
    private static final Pattern IPV6_CHARACTERS = Pattern.compile("[0-9a-fA-F:.]+");

    public ClientAddress {
        Objects.requireNonNull(key);
    }

    /**
     * Reads an IP address literal: IPv4 with exactly four numbers, or IPv6 (an IPv6 zone such as {@code %eth0} is dropped).
     * Anything else, a host name, an address with a port or in square brackets included, is not an address: no DNS lookup
     * ever happens here.
     *
     * @return the address to count, or empty when {@code literal} is not an IP address
     */
    public static Optional<ClientAddress> parse(String literal) {
        if (literal == null) {
            return Optional.empty();
        }
        String text = literal.strip();
        int zone = text.indexOf('%');
        if (zone >= 0) {
            text = text.substring(0, zone);
        }
        if (text.isEmpty() || text.length() > MAX_LITERAL_LENGTH) {
            return Optional.empty();
        }
        boolean v4 = IPV4.matcher(text).matches();
        if (!v4 && (!text.contains(":") || !IPV6_CHARACTERS.matcher(text).matches())) {
            return Optional.empty();
        }
        InetAddress address;
        try {
            address = InetAddress.ofLiteral(text);
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        if (address instanceof Inet4Address v4Address) {
            return Optional.of(new ClientAddress(v4Address.getHostAddress()));
        }
        if (address instanceof Inet6Address v6Address) {
            byte[] octets = v6Address.getAddress();
            StringBuilder prefix = new StringBuilder();
            for (int group = 0; group < 4; group++) {
                int value = ((octets[2 * group] & 0xff) << 8) | (octets[2 * group + 1] & 0xff);
                prefix.append(Integer.toHexString(value)).append(':');
            }
            return Optional.of(new ClientAddress(prefix + ":/64"));
        }
        return Optional.empty();
    }

    /** Never prints the address: a value object that ends up in a log line or an exception message must not carry it. */
    @Override
    public String toString() {
        return "ClientAddress[<redacted>]";
    }
}
