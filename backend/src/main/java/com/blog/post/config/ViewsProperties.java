package com.blog.post.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * View counter settings, bound from {@code app.views.*} (application.yml).
 *
 * {@code token} is an optional shared secret between the Next server and the backend. When blank, anyone can call
 * {@code POST /api/v1/posts/{slug}/views}: correct for dev and compose, where the backend does not expose a port to the
 * outside and only Next reaches it. Set it when the backend has a public URL (Koyeb, Render): then only requests
 * carrying a matching {@code X-View-Token} header are counted (PostViewService).
 *
 * The constructor trims both ends and turns null into an empty string: the Next side reads the same VIEWS_TOKEN
 * variable and trims it before sending, so a stray space in the .env file that only one side strips would turn every
 * view into a 403.
 *
 * @param token shared token; empty means not set
 */
@ConfigurationProperties("app.views")
public record ViewsProperties(String token) {

    public ViewsProperties {
        token = token == null ? "" : token.strip();
    }

    /** A token is set: every view must carry a matching header. */
    public boolean tokenRequired() {
        return !token.isEmpty();
    }

    /**
     * Does not print the token. The record's generated toString prints every component, and configuration is often
     * printed into logs or error messages; a secret riding along there leaks where nobody is looking.
     */
    @Override
    public String toString() {
        return "ViewsProperties[token=" + (tokenRequired() ? "<set>" : "<blank>") + "]";
    }
}
