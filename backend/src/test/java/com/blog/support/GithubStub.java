package com.blog.support;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import tools.jackson.databind.json.JsonMapper;

/**
 * A fake GitHub for the GitHub-login ITs: a JDK {@link HttpServer} on {@code 127.0.0.1:<random port>}, one for the
 * whole JVM, built in AbstractIntegrationTest.
 *
 * Behaves like GitHub wherever the blog's code relies on it:
 * <ul>
 *   <li>{@code GET /login/oauth/authorize}: checks {@code response_type=code}, the client id, that
 *       {@code redirect_uri} equals the configured callback, PKCE S256; "the reader clicks Authorize" with the test
 *       profile sent along, then 302 back to {@code redirect_uri?code&state};</li>
 *   <li>{@code POST /login/oauth/access_token}: the client's HTTP Basic, {@code redirect_uri} matching the authorize
 *       step, the S256 hash of {@code code_verifier}; a code works only once. A wrong or used code gets <b>HTTP
 *       200</b> {@code {"error":"bad_verification_code"}}, exactly like real GitHub, not a 4xx;</li>
 *   <li>{@code GET /user}: the profile of the Bearer token, 401 for an unknown token.</li>
 * </ul>
 * Failures are installed per test ({@link #failToken}, {@link #failUserInfo}) and kept until {@link #reset()}: a
 * client that retries the request after being disconnected gets a failed retry too, like a GitHub that is really
 * down.
 *
 * Only tests can call it, and it writes no log: the backend log tests check that no token or code leaks out, and a
 * log line from the fake server itself would make that check meaningless.
 */
public final class GithubStub {

    public static final String CLIENT_ID = "itclient";
    public static final String CLIENT_SECRET = "itsecret";
    /** The site's (Next's) callback, not the backend's: the backend receives the callback at a different address. */
    public static final String REDIRECT_URI = "http://localhost:3000/api/auth/github/callback";
    /** {@code app.admin.github-id} of the shared test context: AdminGithubLink links the seeded admin to this id. */
    public static final long ADMIN_GITHUB_ID = 990_000_001L;

    /**
     * Only tests send this header at the authorize step, to choose the "person who clicks Authorize" profile; E2E
     * uses a cookie instead.
     */
    static final String PROFILE_HEADER = "X-Github-Stub-Profile";

    private static final JsonMapper JSON = JsonMapper.builder().build();

    /** A failure installed for a step. */
    public enum Failure {
        NONE,
        /** HTTP 500. */
        SERVER_ERROR,
        /** Closes the connection without answering: like a network drop or GitHub being down. */
        DISCONNECT
    }

    /** What the authorize step received, as the browser brings it. */
    public record AuthorizeCall(
            String responseType,
            String clientId,
            String redirectUri,
            String scope,
            String codeChallengeMethod,
            boolean codeChallengePresent,
            String state) {}

    /** What the code-for-token step received from the backend, and the result. */
    public record TokenCall(
            boolean clientAuthenticated, String grantType, String redirectUri, boolean pkceVerified, String result) {}

    private record Grant(Map<String, Object> profile, String redirectUri, String codeChallenge) {}

    private final HttpServer server;
    private final HttpClient browser = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    private final Map<String, Map<String, Object>> approvals = new ConcurrentHashMap<>();
    private final Map<String, Grant> codes = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Object>> accessTokens = new ConcurrentHashMap<>();
    private final Set<String> issuedCodes = ConcurrentHashMap.newKeySet();
    private final List<AuthorizeCall> authorizeCalls = new CopyOnWriteArrayList<>();
    private final List<TokenCall> tokenCalls = new CopyOnWriteArrayList<>();
    private volatile Failure tokenFailure = Failure.NONE;
    private volatile Failure userInfoFailure = Failure.NONE;

    private GithubStub(HttpServer server) {
        this.server = server;
    }

    /** Builds and runs the fake server on loopback, with the port chosen by the operating system. */
    public static GithubStub start() {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
            GithubStub stub = new GithubStub(server);
            server.createContext("/login/oauth/authorize", stub::authorize);
            server.createContext("/login/oauth/access_token", stub::token);
            server.createContext("/user", stub::user);
            server.setExecutor(Executors.newCachedThreadPool(task -> {
                Thread thread = new Thread(task, "github-stub");
                thread.setDaemon(true);
                return thread;
            }));
            // The HttpServer dispatcher thread inherits "daemon" from the thread calling start(): start from a daemon
            // thread so the fake server does not keep the Surefire JVM alive after the tests finish.
            Thread starter = new Thread(server::start, "github-stub-start");
            starter.setDaemon(true);
            starter.start();
            starter.join();
            return stub;
        } catch (IOException e) {
            throw new IllegalStateException("Cannot start the GitHub stub", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while starting the GitHub stub", e);
        }
    }

    // --- Addresses (app.oauth.github.provider.*) ---------------------------------------------------------

    public String authorizationUri() {
        return base() + "/login/oauth/authorize";
    }

    public String tokenUri() {
        return base() + "/login/oauth/access_token";
    }

    public String userInfoUri() {
        return base() + "/user";
    }

    private String base() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    // --- Test controls ------------------------------------------------------------------------------------

    /** Drops every installed failure and everything recorded; issued codes and tokens also become invalid. */
    public void reset() {
        tokenFailure = Failure.NONE;
        userInfoFailure = Failure.NONE;
        approvals.clear();
        codes.clear();
        accessTokens.clear();
        issuedCodes.clear();
        authorizeCalls.clear();
        tokenCalls.clear();
    }

    public void failToken(Failure failure) {
        tokenFailure = failure;
    }

    public void failUserInfo(Failure failure) {
        userInfoFailure = failure;
    }

    public List<AuthorizeCall> authorizeCalls() {
        return List.copyOf(authorizeCalls);
    }

    public List<TokenCall> tokenCalls() {
        return List.copyOf(tokenCalls);
    }

    /** Every GitHub access token the fake server has issued: none may appear in the backend log. */
    public Set<String> issuedAccessTokens() {
        return Set.copyOf(accessTokens.keySet());
    }

    /** Every authorize code the fake server has issued, including used ones. */
    public Set<String> issuedCodes() {
        return Set.copyOf(issuedCodes);
    }

    /**
     * The reader opens the authorize URL the backend returned (the Location of the 302) and clicks "Authorize" with
     * this profile.
     *
     * @return the URL GitHub redirects the browser to: {@code redirect_uri?code=…&state=…}
     */
    public URI approve(String authorizeUrl, Map<String, Object> profile) {
        String key = UUID.randomUUID().toString();
        approvals.put(key, new LinkedHashMap<>(profile));
        try {
            HttpResponse<String> response = browser.send(
                    HttpRequest.newBuilder(URI.create(authorizeUrl))
                            .header(PROFILE_HEADER, key)
                            .GET()
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 302) {
                throw new AssertionError(
                        "GitHub stub refused the authorize request: " + response.statusCode() + " " + response.body());
            }
            return URI.create(response.headers().firstValue("Location").orElseThrow());
        } catch (IOException e) {
            throw new IllegalStateException("GitHub stub is not answering", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        } finally {
            approvals.remove(key);
        }
    }

    /** A {@code GET /user} profile as GitHub returns it, including the public email (the blog must ignore it). */
    public static Map<String, Object> profile(long id, String login, String name) {
        Map<String, Object> profile = new LinkedHashMap<>();
        profile.put("login", login);
        profile.put("id", id);
        profile.put("node_id", "U_stub" + id);
        profile.put("avatar_url", "https://avatars.githubusercontent.com/u/" + id + "?v=4");
        profile.put("type", "User");
        profile.put("name", name);
        profile.put("email", login + "@stub-mail.example");
        return profile;
    }

    // --- GitHub ------------------------------------------------------------------------------------------

    private void authorize(HttpExchange exchange) throws IOException {
        try (exchange) {
            Map<String, String> query = parse(exchange.getRequestURI().getRawQuery());
            String challenge = query.get("code_challenge");
            String state = query.get("state");
            authorizeCalls.add(new AuthorizeCall(
                    query.get("response_type"),
                    query.get("client_id"),
                    query.get("redirect_uri"),
                    query.get("scope"),
                    query.get("code_challenge_method"),
                    challenge != null && !challenge.isEmpty(),
                    state));
            String key = exchange.getRequestHeaders().getFirst(PROFILE_HEADER);
            Map<String, Object> profile = key == null ? null : approvals.remove(key);
            if (!"GET".equals(exchange.getRequestMethod())
                    || !"code".equals(query.get("response_type"))
                    || !CLIENT_ID.equals(query.get("client_id"))
                    || !REDIRECT_URI.equals(query.get("redirect_uri"))
                    || !"S256".equals(query.get("code_challenge_method"))
                    || challenge == null
                    || challenge.isEmpty()
                    || state == null
                    || state.isEmpty()
                    || profile == null) {
                // Real GitHub shows an error page, it does not redirect to an unknown redirect_uri.
                send(exchange, 400, "text/plain", "The authorize request does not match the OAuth app");
                return;
            }
            String code = "stub-code-" + UUID.randomUUID();
            issuedCodes.add(code);
            codes.put(code, new Grant(profile, query.get("redirect_uri"), challenge));
            exchange.getResponseHeaders()
                    .set("Location", query.get("redirect_uri") + "?code=" + encode(code) + "&state=" + encode(state));
            exchange.sendResponseHeaders(302, -1);
        }
    }

    private void token(HttpExchange exchange) throws IOException {
        Failure failure = tokenFailure;
        if (failure == Failure.DISCONNECT) {
            exchange.close();
            return;
        }
        try (exchange) {
            if (failure == Failure.SERVER_ERROR) {
                send(exchange, 500, "application/json", "{\"message\":\"Server Error\"}");
                return;
            }
            Map<String, String> form =
                    parse(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            boolean clientAuthenticated =
                    clientAuthenticated(exchange.getRequestHeaders().getFirst("Authorization"));
            String code = form.get("code");
            Grant grant = code == null ? null : codes.remove(code);
            boolean pkceVerified = grant != null && grant.codeChallenge().equals(s256(form.get("code_verifier")));

            String result;
            if (!clientAuthenticated) {
                result = "incorrect_client_credentials";
            } else if (!"authorization_code".equals(form.get("grant_type")) || grant == null) {
                result = "bad_verification_code";
            } else if (!grant.redirectUri().equals(form.get("redirect_uri"))) {
                result = "redirect_uri_mismatch";
            } else if (!pkceVerified) {
                result = "bad_verification_code";
            } else {
                result = "ok";
            }
            tokenCalls.add(new TokenCall(
                    clientAuthenticated, form.get("grant_type"), form.get("redirect_uri"), pkceVerified, result));

            if (!"ok".equals(result)) {
                // Failure of the token-exchange step, which GitHub returns with HTTP 200.
                send(
                        exchange,
                        200,
                        "application/json",
                        JSON.writeValueAsString(Map.of(
                                "error", result,
                                "error_description", "The code passed is incorrect or expired.",
                                "error_uri", "https://docs.github.com/apps/troubleshooting")));
                return;
            }
            String accessToken = "gho_stub_" + UUID.randomUUID().toString().replace("-", "");
            accessTokens.put(accessToken, grant.profile());
            send(
                    exchange,
                    200,
                    "application/json",
                    JSON.writeValueAsString(
                            Map.of("access_token", accessToken, "token_type", "bearer", "scope", "read:user")));
        }
    }

    private void user(HttpExchange exchange) throws IOException {
        Failure failure = userInfoFailure;
        if (failure == Failure.DISCONNECT) {
            exchange.close();
            return;
        }
        try (exchange) {
            if (failure == Failure.SERVER_ERROR) {
                send(exchange, 500, "application/json", "{\"message\":\"Server Error\"}");
                return;
            }
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            Map<String, Object> profile = authorization != null && authorization.startsWith("Bearer ")
                    ? accessTokens.get(authorization.substring("Bearer ".length()))
                    : null;
            if (profile == null) {
                send(exchange, 401, "application/json", "{\"message\":\"Bad credentials\"}");
                return;
            }
            send(exchange, 200, "application/json", JSON.writeValueAsString(profile));
        }
    }

    // --- Helpers ------------------------------------------------------------------------------------------

    private static boolean clientAuthenticated(String authorization) {
        if (authorization == null || !authorization.startsWith("Basic ")) {
            return false;
        }
        String decoded;
        try {
            decoded = new String(
                    Base64.getDecoder().decode(authorization.substring("Basic ".length())), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return false;
        }
        int colon = decoded.indexOf(':');
        // Spring's client_secret_basic URL-encodes each part before joining (RFC 6749 §2.3.1).
        return colon > 0
                && CLIENT_ID.equals(URLDecoder.decode(decoded.substring(0, colon), StandardCharsets.UTF_8))
                && CLIENT_SECRET.equals(URLDecoder.decode(decoded.substring(colon + 1), StandardCharsets.UTF_8));
    }

    private static String s256(String verifier) {
        if (verifier == null) {
            return "";
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Map<String, String> parse(String encoded) {
        Map<String, String> values = new LinkedHashMap<>();
        if (encoded == null || encoded.isEmpty()) {
            return values;
        }
        for (String pair : encoded.split("&")) {
            int eq = pair.indexOf('=');
            String name = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), StandardCharsets.UTF_8);
            String value = eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            values.putIfAbsent(name, value);
        }
        return values;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static void send(HttpExchange exchange, int status, String contentType, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", contentType + "; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }
}
