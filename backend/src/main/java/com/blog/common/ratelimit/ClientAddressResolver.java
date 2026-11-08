package com.blog.common.ratelimit;

import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.stereotype.Component;

/**
 * Decides which address a request counts against in the per-address rate limits.
 *
 * <ul>
 *   <li>The request carries {@value #TOKEN_HEADER} equal to {@code CLIENT_IP_TOKEN} (compared in constant time): it comes
 *       from our own Next server, which has already worked out the reader's address (lib/client-ip.ts). The address in
 *       {@value #ADDRESS_HEADER} is used. If that header is missing or is not an IP address, Next did not know the reader:
 *       the request counts as {@link ClientAddress#UNKNOWN}, one shared quota, kept apart from direct callers.</li>
 *   <li>Anything else, a wrong token, no token, or no token configured: the socket address
 *       ({@link HttpServletRequest#getRemoteAddr()}). The two headers are ignored completely, so a caller who reaches the
 *       backend directly cannot choose its own key by writing them, and cannot learn whether a token exists.</li>
 * </ul>
 *
 * {@code X-Forwarded-For} is never read here: the backend has no proxy of its own that it trusts to write it, and the
 * socket address is the one thing a caller cannot forge. Behind a platform load balancer (Koyeb, Render) the socket
 * address is the balancer's, so direct callers share one quota, which is the safe outcome; readers who come through Next
 * are told apart by the forwarded address.
 */
@Component
public class ClientAddressResolver {

    /** The reader's address as Next worked it out. */
    public static final String ADDRESS_HEADER = "X-Client-Ip";
    /** The shared secret that proves {@value #ADDRESS_HEADER} was written by our own Next server. */
    public static final String TOKEN_HEADER = "X-Client-Ip-Token";

    /** The configured token; null when none is set. */
    private final byte[] token;

    public ClientAddressResolver(ClientIpProperties properties) {
        this.token = properties.tokenSet() ? properties.token().getBytes(StandardCharsets.UTF_8) : null;
    }

    public ClientAddress resolve(HttpServletRequest request) {
        if (fromTrustedFrontend(request)) {
            return ClientAddress.parse(request.getHeader(ADDRESS_HEADER)).orElse(ClientAddress.UNKNOWN);
        }
        return ClientAddress.parse(request.getRemoteAddr()).orElse(ClientAddress.UNKNOWN);
    }

    /**
     * Constant time: {@code String.equals} stops at the first wrong character, so timing the answers of a public endpoint
     * would reveal the token one character at a time. {@link MessageDigest#isEqual} walks the full length of the
     * configured token wherever it differs.
     */
    private boolean fromTrustedFrontend(HttpServletRequest request) {
        if (token == null) {
            return false;
        }
        String presented = request.getHeader(TOKEN_HEADER);
        return presented != null && MessageDigest.isEqual(token, presented.getBytes(StandardCharsets.UTF_8));
    }
}
