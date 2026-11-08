package com.blog.support;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import jakarta.servlet.http.Cookie;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.util.UriComponentsBuilder;
import org.springframework.web.util.UriUtils;

/**
 * One GitHub login as Next's route handler goes through it, on the real backend inside MockMvc with GithubStub
 * playing GitHub:
 * <ol>
 *   <li>{@link #start()}: Next calls {@value #START_PATH} and gets a 302 to GitHub and the blob
 *       {@value #AUTH_REQUEST_COOKIE};</li>
 *   <li>{@link #approve}: the browser opens that URL, the reader clicks "Authorize", GitHub redirects to the site's
 *       callback with code and state;</li>
 *   <li>{@link #callback}: Next forwards the query unchanged to {@value #CALLBACK_PATH} with the blob in the Cookie
 *       header.</li>
 * </ol>
 * Returns {@link MvcResult} rather than just the response, so tests can also check the request side (no session is
 * created).
 */
public final class GithubLoginFlow {

    public static final String START_PATH = "/api/v1/auth/oauth2/authorization/github";
    public static final String CALLBACK_PATH = "/api/v1/auth/oauth2/callback/github";
    public static final String AUTH_REQUEST_COOKIE = "oauth2_auth_request";

    private final MockMvc mockMvc;
    private final GithubStub github;

    public GithubLoginFlow(MockMvc mockMvc, GithubStub github) {
        this.mockMvc = mockMvc;
        this.github = github;
    }

    /**
     * One start of a login.
     *
     * @param result the backend's request and (302) response
     * @param authorizeUrl Location: the GitHub authorize URL
     * @param blob value of the {@value #AUTH_REQUEST_COOKIE} cookie that Next holds on the browser's behalf
     * @param state the state in the authorize URL, decoded
     */
    public record Started(MvcResult result, String authorizeUrl, String blob, String state) {

        public MockHttpServletResponse response() {
            return result.getResponse();
        }
    }

    public Started start() throws Exception {
        MvcResult result = mockMvc.perform(get(START_PATH)).andReturn();
        MockHttpServletResponse response = result.getResponse();
        if (response.getStatus() != 302) {
            throw new AssertionError("start answered " + response.getStatus() + ": " + response.getContentAsString());
        }
        String location = response.getHeader("Location");
        Cookie cookie = response.getCookie(AUTH_REQUEST_COOKIE);
        if (location == null || cookie == null) {
            throw new AssertionError("start must answer with a Location and the " + AUTH_REQUEST_COOKIE + " cookie");
        }
        return new Started(result, location, cookie.getValue(), queryParam(location, "state"));
    }

    /** The reader clicks "Authorize" on GitHub with this profile; returns the code GitHub sends with the callback. */
    public String approve(Started started, Map<String, Object> profile) {
        URI back = github.approve(started.authorizeUrl(), profile);
        if (!started.state().equals(queryParam(back.toString(), "state"))) {
            throw new AssertionError("GitHub must send the state back unchanged");
        }
        return queryParam(back.toString(), "code");
    }

    /** Callback with the code of the "Authorize" click, plus the state and blob of that same start. */
    public MvcResult callback(Started started, String code) throws Exception {
        return callback(started.blob(), "code", code, "state", started.state());
    }

    /**
     * Arbitrary callback, for failure cases: a null blob means no cookie; {@code params} are name, value pairs of the
     * query.
     */
    public MvcResult callback(String blob, String... params) throws Exception {
        MockHttpServletRequestBuilder request = get(CALLBACK_PATH).accept(MediaType.APPLICATION_JSON);
        for (int i = 0; i < params.length; i += 2) {
            request.queryParam(params[i], params[i + 1]);
        }
        if (blob != null) {
            request.cookie(new Cookie(AUTH_REQUEST_COOKIE, blob));
        }
        return mockMvc.perform(request).andReturn();
    }

    /** The whole pass: start, click "Authorize" with this profile, callback. */
    public MvcResult login(Map<String, Object> profile) throws Exception {
        Started started = start();
        return callback(started, approve(started, profile));
    }

    /** A query parameter of the URL, decoded. */
    public static String queryParam(String url, String name) {
        String raw =
                UriComponentsBuilder.fromUriString(url).build().getQueryParams().getFirst(name);
        return raw == null ? null : UriUtils.decode(raw, StandardCharsets.UTF_8);
    }
}
