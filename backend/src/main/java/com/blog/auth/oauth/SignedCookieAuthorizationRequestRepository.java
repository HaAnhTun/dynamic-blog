package com.blog.auth.oauth;

import com.blog.common.config.SecurityConfig;
import com.blog.common.config.SecurityProperties;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.security.oauth2.client.web.AuthorizationRequestRepository;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;
import org.springframework.security.oauth2.core.endpoint.OAuth2ParameterNames;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/**
 * Keeps the in-progress GitHub login request in an HMAC-signed cookie instead of a session.
 *
 * <h2>Why not a session</h2>
 *
 * Spring's default repository ({@code HttpSessionOAuth2AuthorizationRequestRepository}) creates a JSESSIONID: this API
 * has no session cookie at all, a session is lost on restart, and Next would have to forward it. Here the whole
 * request travels with the request: {@code base64url(JSON) "." base64url(HMAC-SHA256)}, about 1-1.5 KB.
 *
 * <h2>What is signed, and why not Java serialization</h2>
 *
 * The payload carries everything the code-for-token exchange reads back: {@code redirect_uri}, the PKCE
 * {@code code_verifier}, {@code registration_id}, the state and a 10-minute expiry. The payload is only parsed AFTER the
 * signature matches (compared with {@link MessageDigest#isEqual}), and the request is rebuilt with Spring's builder:
 * there is no path for a cookie written by someone else to reach the decoder. The key is
 * {@code HMAC-SHA256(JWT_SECRET, "oauth2-authorization-request/v1")}: no extra secret to manage, and this key never
 * equals the JWT signing key.
 *
 * <h2>Contract with Next</h2>
 *
 * The cookie name {@value #COOKIE_NAME} is the backend to Next contract. Next does not pass this {@code Set-Cookie} on
 * to the browser; it packs the value into its own {@code oauth_flow} cookie and sends it back at the callback. The
 * value consists only of base64url characters and exactly one dot (FE/lib/oauth-flow-cookie.ts checks exactly that
 * shape).
 *
 * <h2>Replay protection</h2>
 *
 * The blob itself has no server-side state, so {@link #removeAuthorizationRequest} records the state in
 * {@link ConsumedStateRegistry}: a second callback with the same blob gets null, i.e.
 * {@code authorization_request_not_found}, i.e. {@code OAUTH_STATE_INVALID}.
 */
@Component
public class SignedCookieAuthorizationRequestRepository
        implements AuthorizationRequestRepository<OAuth2AuthorizationRequest> {

    public static final String COOKIE_NAME = "oauth2_auth_request";
    /** Only the backend's OAuth paths: no other request carries this cookie. */
    static final String COOKIE_PATH = "/api/v1/auth/oauth2";

    static final Duration TTL = Duration.ofMinutes(10);

    private static final int VERSION = 1;
    private static final String HMAC_SHA256 = "HmacSHA256";
    private static final byte[] KEY_LABEL = "oauth2-authorization-request/v1".getBytes(StandardCharsets.US_ASCII);
    /** A real blob is about 1-1.5 KB; browsers would not keep a longer cookie anyway, so skip computing the HMAC. */
    private static final int MAX_COOKIE_LENGTH = 4096;
    /**
     * A dedicated mapper, not Boot's bean: the blob format must not change with the API's Jackson configuration (a new
     * {@code spring.jackson.*} setting could rename fields while someone is midway through logging in).
     */
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private static final Base64.Encoder BASE64URL = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder BASE64URL_DECODER = Base64.getUrlDecoder();

    private final SecretKeySpec key;
    private final ConsumedStateRegistry consumedStates;
    private final Clock clock;

    @Autowired
    public SignedCookieAuthorizationRequestRepository(
            SecurityProperties security, ConsumedStateRegistry consumedStates) {
        this(SecurityConfig.requireUsableSecret(security.jwtSecret()), consumedStates, Clock.systemUTC());
    }

    SignedCookieAuthorizationRequestRepository(byte[] jwtSecret, ConsumedStateRegistry consumedStates, Clock clock) {
        this.key = new SecretKeySpec(hmac(new SecretKeySpec(jwtSecret, HMAC_SHA256), KEY_LABEL), HMAC_SHA256);
        this.consumedStates = consumedStates;
        this.clock = clock;
    }

    /**
     * The in-progress request for this request, or null when: there is no cookie, the signature does not match, the
     * blob is older than 10 minutes, or the {@code state} on the URL differs from the state in the blob (login CSRF: the
     * attacker's callback URL carries the attacker's state, while the victim's browser has no blob for that state).
     */
    @Override
    public OAuth2AuthorizationRequest loadAuthorizationRequest(HttpServletRequest request) {
        String state = request.getParameter(OAuth2ParameterNames.STATE);
        Cookie[] cookies = request.getCookies();
        if (state == null || state.isEmpty() || cookies == null) {
            return null;
        }
        // Every cookie with this name, not just the first: a junk cookie planted from elsewhere must not hide the real
        // blob.
        for (Cookie cookie : cookies) {
            if (COOKIE_NAME.equals(cookie.getName())) {
                Payload payload = verify(cookie.getValue());
                if (payload != null && state.equals(payload.state())) {
                    OAuth2AuthorizationRequest authorizationRequest = payload.toAuthorizationRequest();
                    if (authorizationRequest != null) {
                        return authorizationRequest;
                    }
                }
            }
        }
        return null;
    }

    @Override
    public void saveAuthorizationRequest(
            OAuth2AuthorizationRequest authorizationRequest, HttpServletRequest request, HttpServletResponse response) {
        if (authorizationRequest == null) {
            expireCookie(response);
            return;
        }
        long expiresAt = clock.instant().plus(TTL).getEpochSecond();
        String value = sign(Payload.of(authorizationRequest, expiresAt));
        response.addHeader(HttpHeaders.SET_COOKIE, cookie(value, TTL).toString());
    }

    /**
     * Takes the request out at the callback: exactly once per state. The second time (callback replayed) gets null. The
     * cookie is always cleared: whatever the outcome, this login attempt is over.
     *
     * A request with a wrong state marks nothing: it must not burn the real pending login.
     */
    @Override
    public OAuth2AuthorizationRequest removeAuthorizationRequest(
            HttpServletRequest request, HttpServletResponse response) {
        OAuth2AuthorizationRequest authorizationRequest = loadAuthorizationRequest(request);
        expireCookie(response);
        if (authorizationRequest == null || !consumedStates.consume(authorizationRequest.getState())) {
            return null;
        }
        return authorizationRequest;
    }

    // --- Signing and verifying -------------------------------------------------------------------------------

    private String sign(Payload payload) {
        String encoded = BASE64URL.encodeToString(JSON.writeValueAsBytes(payload));
        return encoded + "." + BASE64URL.encodeToString(hmac(key, encoded.getBytes(StandardCharsets.US_ASCII)));
    }

    /** The payload of a blob with a valid signature, the right version and not expired; null for anything else. */
    private Payload verify(String value) {
        if (value == null || value.length() > MAX_COOKIE_LENGTH) {
            return null;
        }
        int dot = value.indexOf('.');
        if (dot <= 0 || dot == value.length() - 1 || dot != value.lastIndexOf('.')) {
            return null;
        }
        String encoded = value.substring(0, dot);
        byte[] presented;
        try {
            presented = BASE64URL_DECODER.decode(value.substring(dot + 1));
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (!MessageDigest.isEqual(hmac(key, encoded.getBytes(StandardCharsets.US_ASCII)), presented)) {
            return null;
        }
        Payload payload;
        try {
            payload = JSON.readValue(BASE64URL_DECODER.decode(encoded), Payload.class);
        } catch (IllegalArgumentException | JacksonException e) {
            // Valid signature but unreadable: only happens when the blob format changed between two backend versions.
            // The reader starts the login over.
            return null;
        }
        if (payload.v() != VERSION || clock.instant().getEpochSecond() >= payload.exp()) {
            return null;
        }
        return payload;
    }

    private static byte[] hmac(SecretKeySpec key, byte[] data) {
        try {
            Mac mac = Mac.getInstance(HMAC_SHA256);
            mac.init(key);
            return mac.doFinal(data);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is required by every JVM", e);
        }
    }

    // --- Cookie ----------------------------------------------------------------------------------------------

    private static ResponseCookie cookie(String value, Duration maxAge) {
        // Not Secure: Next calls the backend over internal http and reads this Set-Cookie itself; the browser never
        // sees it.
        return ResponseCookie.from(COOKIE_NAME, value)
                .path(COOKIE_PATH)
                .maxAge(maxAge)
                .httpOnly(true)
                .sameSite("Lax")
                .build();
    }

    private static void expireCookie(HttpServletResponse response) {
        response.addHeader(HttpHeaders.SET_COOKIE, cookie("", Duration.ZERO).toString());
    }

    // --- Payload ---------------------------------------------------------------------------------------------

    /**
     * The signed content. The field names are the blob's format: if a name or meaning changes, bump {@code v}, so a
     * blob from an older version is cleanly rejected instead of misread.
     *
     * @param exp expiry, epoch seconds
     */
    record Payload(
            int v,
            String authorizationUri,
            String clientId,
            String redirectUri,
            List<String> scopes,
            String state,
            Map<String, String> additionalParameters,
            Map<String, String> attributes,
            String authorizationRequestUri,
            long exp) {

        static Payload of(OAuth2AuthorizationRequest request, long exp) {
            return new Payload(
                    VERSION,
                    request.getAuthorizationUri(),
                    request.getClientId(),
                    request.getRedirectUri(),
                    List.copyOf(request.getScopes()),
                    request.getState(),
                    strings(request.getAdditionalParameters()),
                    strings(request.getAttributes()),
                    request.getAuthorizationRequestUri(),
                    exp);
        }

        /** Null when the blob has a valid signature but lacks a required field (Spring's builder refuses). */
        OAuth2AuthorizationRequest toAuthorizationRequest() {
            try {
                return OAuth2AuthorizationRequest.authorizationCode()
                        .authorizationUri(authorizationUri)
                        .clientId(clientId)
                        .redirectUri(redirectUri)
                        .scopes(scopes == null ? null : new LinkedHashSet<>(scopes))
                        .state(state)
                        .additionalParameters(objects(additionalParameters))
                        .attributes(objects(attributes))
                        .authorizationRequestUri(authorizationRequestUri)
                        .build();
            } catch (IllegalArgumentException e) {
                return null;
            }
        }

        /**
         * Every parameter and attribute of this flow is a string (code_challenge, code_challenge_method,
         * registration_id, code_verifier). Any other value is a sign the configuration changed; throw so it shows up
         * immediately, instead of turning it into a string and silently breaking PKCE.
         */
        private static Map<String, String> strings(Map<String, Object> source) {
            Map<String, String> copy = new LinkedHashMap<>();
            source.forEach((name, value) -> {
                if (!(value instanceof String text)) {
                    throw new IllegalArgumentException("OAuth2 authorization request value '" + name
                            + "' is not a string and cannot be stored in the signed cookie");
                }
                copy.put(name, text);
            });
            return copy;
        }

        private static Map<String, Object> objects(Map<String, String> source) {
            return source == null ? new LinkedHashMap<>() : new LinkedHashMap<>(source);
        }
    }
}
