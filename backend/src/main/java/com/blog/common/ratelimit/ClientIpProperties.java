package com.blog.common.ratelimit;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The shared secret between the Next server and the backend that lets Next tell the backend which reader a request is for,
 * bound from {@code app.client-ip.*} ({@code CLIENT_IP_TOKEN}).
 *
 * The backend sees only the address of whoever opened the socket: behind Next that is the Next server, for every
 * reader. Next therefore sends the reader's address in an {@code X-Client-Ip} header together with this token in
 * {@code X-Client-Ip-Token}; the backend believes the address only when the token matches ({@link ClientAddressResolver}).
 * Without a token nothing can be believed, so every per-address limit uses the socket address.
 *
 * Required in production (ClientIpTokenCheck): an empty value leaves the per-address limits blind to the readers behind
 * Next. The constructor trims both ends and turns null into an empty string, like ViewsProperties, because the Next
 * side trims the same variable before sending it.
 *
 * @param token shared token; empty means not set
 */
@ConfigurationProperties("app.client-ip")
public record ClientIpProperties(String token) {

    public ClientIpProperties {
        token = token == null ? "" : token.strip();
    }

    /** A token is set: a forwarded address can be believed when the request carries it. */
    public boolean tokenSet() {
        return !token.isEmpty();
    }

    /** Does not print the token: configuration is often printed into logs, and a secret riding along would leak there. */
    @Override
    public String toString() {
        return "ClientIpProperties[token=" + (tokenSet() ? "<set>" : "<blank>") + "]";
    }
}
