package com.blog.auth.dto;

/**
 * The token pair of a session. {@link #toString()} keeps the lifetimes and hides both tokens, also when this record is
 * wrapped in an {@code ApiResponse} or a {@code FirstFactorResult}: a response body is printed by DEBUG logging and by
 * assertion messages.
 *
 * @param expiresIn        seconds the access token lives
 * @param refreshExpiresIn seconds the refresh token lives, from now: the frontend sets the Max-Age of its cookie from it, so
 *                         the cookie ends when the backend would refuse the token (an ADMIN or AUTHOR session is shorter than
 *                         a reader's)
 */
public record TokenResponse(String accessToken, String refreshToken, long expiresIn, long refreshExpiresIn) {

    @Override
    public String toString() {
        return "TokenResponse[tokens=<hidden>, expiresIn=" + expiresIn + ", refreshExpiresIn=" + refreshExpiresIn + "]";
    }
}
