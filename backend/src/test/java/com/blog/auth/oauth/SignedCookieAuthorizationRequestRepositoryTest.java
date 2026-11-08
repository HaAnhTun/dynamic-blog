package com.blog.auth.oauth;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.http.Cookie;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.config.oauth2.client.CommonOAuth2Provider;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.DefaultOAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestCustomizers;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;

/**
 * Stores the in-progress GitHub login request in an HMAC-signed cookie instead of a session: no JSESSIONID,
 * survives a restart, no Java serialization.
 *
 * The request in the tests is built by the very resolver the chain uses (PKCE S256, absolute callback), so the save/load round trip
 * checks the real shape: {@code registration_id} and {@code code_verifier} sit in the attributes, {@code code_challenge}
 * in the parameters, and the code exchange uses the {@code redirect_uri} and {@code code_verifier} read back from here.
 */
class SignedCookieAuthorizationRequestRepositoryTest {

    private static final byte[] JWT_SECRET =
            "jwt-secret-cua-test-dai-hon-32-byte-cho-hmac".getBytes(StandardCharsets.UTF_8);
    private static final String CALLBACK = "https://blog.example.com/api/auth/github/callback";
    /** The blob format that Next checks before wrapping it into the oauth_flow cookie (FE/lib/oauth-flow-cookie.ts). */
    private static final String NEXT_BLOB_PATTERN = "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$";

    private static final int NEXT_MAX_BLOB_LENGTH = 3_000;

    private final MutableClock clock = new MutableClock();
    private final SignedCookieAuthorizationRequestRepository repository =
            new SignedCookieAuthorizationRequestRepository(JWT_SECRET, new ConsumedStateRegistry(clock, 100), clock);

    // --- Save --------------------------------------------------------------------------------------------

    @Test
    void saves_as_HttpOnly_SameSite_Lax_narrow_Path_10_minute_cookie_in_the_shape_Next_expects() {
        MockHttpServletResponse response = new MockHttpServletResponse();
        repository.saveAuthorizationRequest(githubRequest(), new MockHttpServletRequest(), response);

        List<String> setCookies = response.getHeaders("Set-Cookie");
        assertThat(setCookies).hasSize(1);
        assertThat(setCookies.getFirst())
                .startsWith("oauth2_auth_request=")
                .contains("Path=/api/v1/auth/oauth2")
                .contains("Max-Age=600")
                .contains("HttpOnly")
                .contains("SameSite=Lax");
        String blob = response.getCookie("oauth2_auth_request").getValue();
        assertThat(blob).matches(NEXT_BLOB_PATTERN).hasSizeLessThan(NEXT_MAX_BLOB_LENGTH);
    }

    @Test
    void blob_is_signed_JSON_not_Java_serialization() {
        String blob = save(githubRequest());
        byte[] payload = Base64.getUrlDecoder().decode(blob.substring(0, blob.indexOf('.')));

        // 0xACED is the Java serialization "magic"; the payload must be plain JSON.
        assertThat(payload[0]).isEqualTo((byte) '{');
        assertThat(new String(payload, StandardCharsets.UTF_8))
                .contains("\"v\":1")
                .contains("\"exp\":");
    }

    @Test
    void saving_null_clears_the_cookie() {
        MockHttpServletResponse response = new MockHttpServletResponse();
        repository.saveAuthorizationRequest(null, new MockHttpServletRequest(), response);

        assertThat(response.getHeader("Set-Cookie"))
                .startsWith("oauth2_auth_request=;")
                .contains("Max-Age=0");
    }

    // --- Load --------------------------------------------------------------------------------------------

    @Test
    void loads_back_every_field_the_token_exchange_needs() {
        OAuth2AuthorizationRequest original = githubRequest();

        OAuth2AuthorizationRequest loaded =
                repository.loadAuthorizationRequest(callback(save(original), original.getState()));

        assertThat(loaded).isNotNull();
        assertThat(loaded.<String>getAttribute("registration_id")).isEqualTo("github");
        assertThat(loaded.<String>getAttribute("code_verifier"))
                .isNotBlank()
                .isEqualTo(original.<String>getAttribute("code_verifier"));
        assertThat(loaded.getRedirectUri()).isEqualTo(CALLBACK);
        assertThat(loaded.getAdditionalParameters())
                .containsEntry("code_challenge_method", "S256")
                .containsKey("code_challenge");
        // equals of OAuth2AuthorizationRequest compares every field: authorize URI, client id, scope, state,
        // parameters,
        // attributes, and the full authorize URL too.
        assertThat(loaded).isEqualTo(original);
    }

    @Test
    void missing_cookie_or_missing_state_or_different_state_cannot_be_loaded() {
        OAuth2AuthorizationRequest original = githubRequest();
        String blob = save(original);

        assertThat(repository.loadAuthorizationRequest(callback(null, original.getState())))
                .isNull();
        assertThat(repository.loadAuthorizationRequest(callback(blob, null))).isNull();
        assertThat(repository.loadAuthorizationRequest(callback(blob, ""))).isNull();
        assertThat(repository.loadAuthorizationRequest(callback(blob, original.getState() + "x")))
                .isNull();
        // State of another login attempt (exactly the login-CSRF pattern): a valid blob but not for this state.
        assertThat(repository.loadAuthorizationRequest(
                        callback(blob, githubRequest().getState())))
                .isNull();
    }

    @Test
    void altered_payload_or_signature_cannot_be_loaded() {
        OAuth2AuthorizationRequest original = githubRequest();
        String blob = save(original);
        int dot = blob.indexOf('.');
        String payload = blob.substring(0, dot);
        String mac = blob.substring(dot + 1);
        String otherMac = save(githubRequest()).split("\\.")[1];

        for (String tampered : List.of(
                flipFirst(payload) + "." + mac,
                payload + "." + flipFirst(mac),
                payload + "." + otherMac,
                payload,
                payload + ".",
                "." + mac,
                blob + ".extra",
                "rac-rac.rac",
                "")) {
            assertThat(repository.loadAuthorizationRequest(callback(tampered, original.getState())))
                    .as(tampered)
                    .isNull();
        }
    }

    @Test
    void blob_signed_with_different_JWT_SECRET_cannot_be_loaded() {
        SignedCookieAuthorizationRequestRepository otherInstance = new SignedCookieAuthorizationRequestRepository(
                "mot-jwt-secret-khac-cung-dai-hon-32-byte!!".getBytes(StandardCharsets.UTF_8),
                new ConsumedStateRegistry(clock, 100),
                clock);
        OAuth2AuthorizationRequest original = githubRequest();
        MockHttpServletResponse response = new MockHttpServletResponse();
        otherInstance.saveAuthorizationRequest(original, new MockHttpServletRequest(), response);

        String foreign = response.getCookie("oauth2_auth_request").getValue();
        assertThat(repository.loadAuthorizationRequest(callback(foreign, original.getState())))
                .isNull();
    }

    @Test
    void blob_older_than_10_minutes_cannot_be_loaded() {
        OAuth2AuthorizationRequest original = githubRequest();
        String blob = save(original);

        clock.advance(Duration.ofMinutes(10).minusSeconds(1));
        assertThat(repository.loadAuthorizationRequest(callback(blob, original.getState())))
                .isNotNull();

        clock.advance(Duration.ofSeconds(1));
        assertThat(repository.loadAuthorizationRequest(callback(blob, original.getState())))
                .isNull();
    }

    @Test
    void with_several_cookies_of_same_name_the_valid_one_is_used() {
        OAuth2AuthorizationRequest original = githubRequest();
        MockHttpServletRequest request = callback(null, original.getState());
        request.setCookies(
                new Cookie("oauth2_auth_request", "rac.rac"), new Cookie("oauth2_auth_request", save(original)));

        assertThat(repository.loadAuthorizationRequest(request)).isEqualTo(original);
    }

    // --- Remove (callback) -------------------------------------------------------------------------------

    @Test
    void remove_works_exactly_once_replay_is_null_and_every_call_clears_cookie() {
        OAuth2AuthorizationRequest original = githubRequest();
        String blob = save(original);

        MockHttpServletResponse first = new MockHttpServletResponse();
        assertThat(repository.removeAuthorizationRequest(callback(blob, original.getState()), first))
                .isEqualTo(original);
        MockHttpServletResponse replay = new MockHttpServletResponse();
        assertThat(repository.removeAuthorizationRequest(callback(blob, original.getState()), replay))
                .isNull();

        for (MockHttpServletResponse response : List.of(first, replay)) {
            assertThat(response.getHeader("Set-Cookie"))
                    .startsWith("oauth2_auth_request=;")
                    .contains("Path=/api/v1/auth/oauth2")
                    .contains("Max-Age=0");
        }
    }

    @Test
    void remove_with_invalid_blob_is_null_and_does_not_mark_state_consumed() {
        OAuth2AuthorizationRequest original = githubRequest();
        String blob = save(original);

        assertThat(repository.removeAuthorizationRequest(callback(blob, "state-gia"), new MockHttpServletResponse()))
                .isNull();
        // A call with a fake state must not burn the real login attempt that is waiting.
        assertThat(repository.removeAuthorizationRequest(
                        callback(blob, original.getState()), new MockHttpServletResponse()))
                .isEqualTo(original);
    }

    // --- Helpers -----------------------------------------------------------------------------------------

    /** An authorize request as the real chain builds it: GitHub registration, absolute callback, PKCE S256. */
    private static OAuth2AuthorizationRequest githubRequest() {
        ClientRegistration github = CommonOAuth2Provider.GITHUB
                .getBuilder("github")
                .clientId("itclient")
                .clientSecret("itsecret")
                .redirectUri(CALLBACK)
                .build();
        DefaultOAuth2AuthorizationRequestResolver resolver = new DefaultOAuth2AuthorizationRequestResolver(
                new InMemoryClientRegistrationRepository(github), "/api/v1/auth/oauth2/authorization");
        resolver.setAuthorizationRequestCustomizer(OAuth2AuthorizationRequestCustomizers.withPkce());
        OAuth2AuthorizationRequest request =
                resolver.resolve(new MockHttpServletRequest("GET", "/api/v1/auth/oauth2/authorization/github"));
        assertThat(request).isNotNull();
        return request;
    }

    private String save(OAuth2AuthorizationRequest request) {
        MockHttpServletResponse response = new MockHttpServletResponse();
        repository.saveAuthorizationRequest(request, new MockHttpServletRequest(), response);
        return response.getCookie("oauth2_auth_request").getValue();
    }

    /** The moment Next calls the backend callback: the cookie carries the blob, the query carries state (and code, not needed here). */
    private static MockHttpServletRequest callback(String blob, String state) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/auth/oauth2/callback/github");
        request.addParameter("code", "mot-code");
        if (state != null) {
            request.addParameter("state", state);
        }
        if (blob != null) {
            request.setCookies(new Cookie("oauth2_auth_request", blob));
        }
        return request;
    }

    /** Changes exactly one character, staying inside the base64url alphabet, so the failure is the signature and not the format. */
    private static String flipFirst(String value) {
        char first = value.charAt(0);
        return (first == 'A' ? 'B' : 'A') + value.substring(1);
    }
}
