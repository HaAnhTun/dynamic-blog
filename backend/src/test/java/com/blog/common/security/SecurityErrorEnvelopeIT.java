package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.exception.GlobalExceptionHandler;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@AutoConfigureMockMvc
class SecurityErrorEnvelopeIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    private ListAppender<ILoggingEvent> logs;
    private final List<Logger> captured = new ArrayList<>();

    @BeforeEach
    void captureHandlerLogs() {
        logs = new ListAppender<>();
        logs.start();
        // The two filter-path handlers, plus GlobalExceptionHandler: capturing all three is
        // what lets bothDenialPathsProduceTheSameParsedEnvelope tell the routes apart by the
        // logger that answered. Still not the root logger — a root capture would collect
        // every line Spring emits, and anySatisfy would then pass on a message these tests
        // know nothing about.
        for (Class<?> type : List.of(
                ApiAuthenticationEntryPoint.class, ApiAccessDeniedHandler.class, GlobalExceptionHandler.class)) {
            Logger logger = (Logger) LoggerFactory.getLogger(type);
            logger.addAppender(logs);
            captured.add(logger);
        }
    }

    @AfterEach
    void releaseHandlerLogs() {
        captured.forEach(logger -> logger.detachAppender(logs));
        captured.clear();
    }

    @Test
    void a401CarriesTheEnvelope() throws Exception {
        mockMvc.perform(get("/api/v1/admin/posts"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(APPLICATION_JSON))
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"))
                .andExpect(jsonPath("$.error.message").isNotEmpty())
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());
    }

    @Test
    void a403CarriesTheEnvelope() throws Exception {
        User author = auth.createAuthor("author-envelope@blog.local");

        mockMvc.perform(delete("/api/v1/admin/posts/00000000-0000-0000-0000-0000000000ff")
                        .header("Authorization", auth.bearerFor(author)))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(APPLICATION_JSON))
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());
    }

    @Test
    void a401DoesNotCarryAWwwAuthenticateChallenge() throws Exception {
        // Spring Security's default entry point sends WWW-Authenticate: Bearer, which makes
        // a browser pop a credential dialog on a JSON API. The replacement must not.
        mockMvc.perform(get("/api/v1/admin/posts"))
                .andExpect(status().isUnauthorized())
                .andExpect(result -> {
                    String header = result.getResponse().getHeader("WWW-Authenticate");
                    if (header != null) {
                        throw new AssertionError("unexpected WWW-Authenticate: " + header);
                    }
                });
    }

    @Test
    void a401BodyDoesNotNameTheMissingAuthority() throws Exception {
        // The message is for a person, not a probe: it must not enumerate which role or
        // scope would have worked.
        //
        // The first assertion is not decoration. Every `doesNotContain` below would pass
        // on an empty body, and an empty body is exactly the failure this file exists to
        // fix, so the absence checks are worthless without something proving the channel
        // they inspect is non-empty. Step 5b mutates the handler to make them fire.
        String body = mockMvc.perform(get("/api/v1/admin/posts"))
                .andReturn()
                .getResponse()
                .getContentAsString();

        assertThat(body).contains("UNAUTHENTICATED");
        assertThat(body).doesNotContain("ROLE_").doesNotContain("hasAnyRole").doesNotContain("AUTHOR");
        // Measured, and the reason this line exists: mutating the handler to publish
        // authException.getMessage() leaks "Full authentication is required to access this
        // resource" here and the decoder's text elsewhere, but NEITHER names a role — so the
        // three doesNotContain checks above cannot be made to fail by any message the
        // framework actually produces. Pinning the message to the fixed string is the
        // falsifiable form of the same guarantee: a handler that starts interpolating
        // anything, a role name included, fails here.
        assertThat(objectMapper.readTree(body).path("error").path("message").asString())
                .isEqualTo("Authentication required");
    }

    @Test
    void aTokenWithABadSignatureCarriesTheEnvelope() throws Exception {
        // A token-less request gets the envelope; a forged one must too — the forged token
        // is the case a person debugging a broken client actually hits.
        //
        // This is the test that guards the asymmetry Task 7 was dispatched to explain.
        // Spring's BearerTokenAuthenticationFilter answers a bad token through the entry
        // point given to `oauth2ResourceServer(...)`, NOT the one given to
        // `exceptionHandling(...)`; with only the latter set, this request comes back 401
        // with Content-Length: 0 and a WWW-Authenticate header quoting the decoder. See
        // SecurityConfig: both are wired, and removing either one breaks a different test.
        //
        // Build the forgery by keeping the header and payload of a real token and
        // corrupting only the signature, so the failure is the signature and nothing else.
        String real = auth.bearerForAdmin().substring("Bearer ".length());
        String forged = real.substring(0, real.lastIndexOf('.') + 1) + "AAAAdeadbeefAAAA";

        mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", "Bearer " + forged))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(APPLICATION_JSON))
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());
    }

    @Test
    void anExpiredTokenCarriesTheEnvelopeAndDoesNotLeakWhenItExpired() throws Exception {
        // Same shape as the forged token, different cause. The message must not quote the
        // decoder's own text: a JWT validation failure reads
        // "An error occurred while attempting to decode the Jwt: Jwt expired at <instant>",
        // which hands a probe the server's clock and the token's lifetime.
        String expired = auth.expiredBearerForAdmin();

        String body = mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", expired))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"))
                .andReturn()
                .getResponse()
                .getContentAsString();

        assertThat(body).doesNotContain("expired at").doesNotContain("Jwt");
    }

    @Test
    void bothDenialPathsProduceTheSameParsedEnvelope() throws Exception {
        // A 403 reaches the caller by two different routes, and a person who hit the wrong
        // button must not be able to tell which one answered:
        //
        //   URL rule      -> ExceptionTranslationFilter -> ApiAccessDeniedHandler
        //   @PreAuthorize -> AuthorizationDeniedException -> GlobalExceptionHandler
        //
        // Compare the PARSED bodies, never the raw strings or the headers: one path streams
        // and is chunked, the other sets Content-Length. That difference is framing, not
        // content, and asserting on it would make this test fail for a reason it does not
        // care about. (Measured against a running server: here it is the filter path that
        // sets Content-Length and the MVC path that is chunked, the opposite way round from
        // what the task brief predicted — which is exactly why it is not asserted.)
        User author = auth.createAuthor("author-both-paths@blog.local");
        String token = auth.bearerFor(author);

        String viaUrlRule = mockMvc.perform(get("/api/v1/admin/users").header("Authorization", token))
                .andExpect(status().isForbidden())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String viaPreAuthorize = mockMvc.perform(delete("/api/v1/admin/posts/00000000-0000-0000-0000-0000000000ff")
                        .header("Authorization", token))
                .andExpect(status().isForbidden())
                .andReturn()
                .getResponse()
                .getContentAsString();

        JsonNode urlRule = objectMapper.readTree(viaUrlRule).path("error");
        JsonNode preAuthorize = objectMapper.readTree(viaPreAuthorize).path("error");

        assertThat(urlRule.path("code").asString()).isEqualTo("FORBIDDEN");
        assertThat(preAuthorize.path("code").asString())
                .isEqualTo(urlRule.path("code").asString());
        assertThat(preAuthorize.path("message").asString())
                .isEqualTo(urlRule.path("message").asString());
        // Field for field, so a route that silently drops traceId or adds a field is caught.
        assertThat(fieldNames(preAuthorize)).isEqualTo(fieldNames(urlRule));
        // The traceIds must differ: they identify requests, not response shapes.
        assertThat(preAuthorize.path("traceId").asString())
                .isNotEqualTo(urlRule.path("traceId").asString());

        // And now the part that pins the two routes as two. Everything above is equally
        // satisfied by hitting ONE handler twice, because each call mints a fresh UUID: add
        // a URL rule over that DELETE tomorrow and this test would keep passing while
        // covering the filter path twice and the MVC path not at all.
        //
        // So match each traceId back to the logger that emitted it. On the logger NAME, not
        // on message text, which a later edit would reword without touching the routing this
        // is here to protect.
        assertThat(loggerThatReported(urlRule.path("traceId").asString()))
                .as("the URL-rule denial must come from the filter-path handler")
                .isEqualTo(ApiAccessDeniedHandler.class.getName());
        assertThat(loggerThatReported(preAuthorize.path("traceId").asString()))
                .as("the @PreAuthorize denial must come from the MVC exception handler")
                .isEqualTo(GlobalExceptionHandler.class.getName());
    }

    /** The name of the single captured logger whose line carries this traceId. */
    private String loggerThatReported(String traceId) {
        List<String> names = logs.list.stream()
                .filter(event -> event.getFormattedMessage().contains(traceId))
                .map(ILoggingEvent::getLoggerName)
                .distinct()
                .toList();
        assertThat(names)
                .as("exactly one logger should have reported traceId %s", traceId)
                .hasSize(1);
        return names.getFirst();
    }

    @Test
    void aFilterPathDenialIsLogged() throws Exception {
        // Every other envelope in this API logs its traceId at warn. Until this task the
        // two filter-path answers logged nothing, so their traceId appeared in the caller's
        // response and nowhere else — a support ticket quoting one was unanswerable.
        //
        // A request with no credential at all is the exception since issue 089: anyone can send
        // it without limit, so it is a DEBUG line (the next test). A token that was sent and
        // refused is the case a ticket is about: WARN, but once a minute per reason with the number
        // of similar refusals left out (ApiSecurityHandlersLoggingTest pins that), the repeats are
        // DEBUG. The context is shared, so an earlier test may have used this minute's WARN line;
        // this test runs with DEBUG on and asks for the line at either level.
        Logger entryPoint = (Logger) LoggerFactory.getLogger(ApiAuthenticationEntryPoint.class);
        Level before = entryPoint.getLevel();
        try {
            entryPoint.setLevel(Level.DEBUG);
            String real = auth.bearerForAdmin().substring("Bearer ".length());
            String forged = real.substring(0, real.lastIndexOf('.') + 1) + "AAAAdeadbeefAAAA";
            String body = mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", "Bearer " + forged))
                    .andExpect(status().isUnauthorized())
                    .andReturn()
                    .getResponse()
                    .getContentAsString();
            String traceId =
                    objectMapper.readTree(body).path("error").path("traceId").asString();

            assertThat(traceId).isNotBlank();
            assertThat(logs.list)
                    .as("the 401's traceId must appear in the server log")
                    .anySatisfy(event -> {
                        assertThat(event.getFormattedMessage()).contains(traceId);
                        assertThat(event.getLevel().isGreaterOrEqual(Level.DEBUG))
                                .isTrue();
                        assertThat(event.getLoggerName()).isEqualTo(ApiAuthenticationEntryPoint.class.getName());
                    });
        } finally {
            entryPoint.setLevel(before);
        }
    }

    @Test
    void aRequestWithoutACredentialIsLoggedAtDebugOnly() throws Exception {
        // Issue 089: an anonymous caller can send these without limit and chooses the path, so a line per request at
        // WARN
        // would rotate the security events out of the log. At DEBUG the trace id is still matched to the answer.
        Logger entryPoint = (Logger) LoggerFactory.getLogger(ApiAuthenticationEntryPoint.class);
        Level before = entryPoint.getLevel();
        try {
            entryPoint.setLevel(Level.DEBUG);
            String body = mockMvc.perform(get("/api/v1/admin/posts"))
                    .andExpect(status().isUnauthorized())
                    .andReturn()
                    .getResponse()
                    .getContentAsString();
            String traceId =
                    objectMapper.readTree(body).path("error").path("traceId").asString();

            assertThat(logs.list)
                    .filteredOn(event -> event.getFormattedMessage().contains(traceId))
                    .singleElement()
                    .satisfies(event -> assertThat(event.getLevel()).isEqualTo(Level.DEBUG));
        } finally {
            entryPoint.setLevel(before);
        }
    }

    @Test
    void aFilterPathAccessDenialIsLoggedToo() throws Exception {
        // The sibling of the test above, for the other filter-path handler. Without it the
        // appender's second logger is never exercised and ApiAccessDeniedHandler could lose
        // its log line with the suite still green.
        User author = auth.createAuthor("author-denied-log@blog.local");

        String body = mockMvc.perform(get("/api/v1/admin/users").header("Authorization", auth.bearerFor(author)))
                .andExpect(status().isForbidden())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String traceId =
                objectMapper.readTree(body).path("error").path("traceId").asString();

        assertThat(traceId).isNotBlank();
        assertThat(logs.list)
                .as("the 403's traceId must appear in the server log")
                .anySatisfy(event -> assertThat(event.getFormattedMessage()).contains(traceId));
    }

    @Test
    void aFilterPathDenialDoesNotLogTheTokenOrTheDecodersMessage() throws Exception {
        // A log line is the one place a token fragment outlives rotation, and the decoder's
        // own message for an expired token carries the server's clock. Neither belongs in
        // the log, so the handler logs the exception's class name and nothing else from it.
        // DEBUG is on, so the line is there even when this minute's WARN line was used by an earlier test.
        Logger entryPoint = (Logger) LoggerFactory.getLogger(ApiAuthenticationEntryPoint.class);
        Level before = entryPoint.getLevel();
        try {
            entryPoint.setLevel(Level.DEBUG);
            String expired = auth.expiredBearerForAdmin();
            String token = expired.substring("Bearer ".length());

            mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", expired))
                    .andExpect(status().isUnauthorized());

            assertThat(logs.list).isNotEmpty();
            assertThat(logs.list)
                    .as("no captured log line may quote the token or the decoder's message")
                    .allSatisfy(event -> assertThat(event.getFormattedMessage())
                            .doesNotContain(token)
                            .doesNotContain("expired at")
                            .doesNotContain("attempting to decode"));
            // The control: the lines inspected above really are this request's, not an empty list.
            assertThat(logs.list)
                    .anySatisfy(event -> assertThat(event.getFormattedMessage()).contains("/api/v1/admin/posts"));
        } finally {
            entryPoint.setLevel(before);
        }
    }

    // --- Step 7: the framework 4xx envelopes, through the real filter chain -------------
    //
    // GlobalExceptionHandlerTest runs with addFilters = false, so until these tests nothing
    // proved the 404 and 405 envelopes survive the chain a real request traverses — and the
    // chain is what this sprint changed. `denyAll()` is the fallback, so an unmapped path is
    // stopped by authorization before the DispatcherServlet can report it unmapped: measured
    // against a running server, /api/v1/does-not-exist is 401 without a token and 403 with
    // one, never 404. Both codes are still reachable, but only on the paths used below, each
    // of which was watched producing its code over HTTP before being written here.

    @Test
    void anUnmappedPathUnderAPublicPrefixStillCarriesTheNotFoundEnvelope() throws Exception {
        // Reachable because GET /api/v1/posts/** is permitAll, so authorization passes and
        // the DispatcherServlet gets to report the path unmapped.
        mockMvc.perform(get("/api/v1/posts/no/such/thing"))
                .andExpect(status().isNotFound())
                .andExpect(content().contentTypeCompatibleWith(APPLICATION_JSON))
                .andExpect(jsonPath("$.error.code").value("ENDPOINT_NOT_FOUND"))
                .andExpect(jsonPath("$.error.message").value("The requested endpoint does not exist"))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());
    }

    @Test
    void anUnmappedPathUnderAdminStillCarriesTheNotFoundEnvelopeForAnAuthorisedCaller() throws Exception {
        // The other reachable route to ENDPOINT_NOT_FOUND: /api/v1/admin/** admits ADMIN, so
        // the URL rule passes and an unmapped admin path is a genuine 404 rather than a 403.
        mockMvc.perform(get("/api/v1/admin/nope").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("ENDPOINT_NOT_FOUND"))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());
    }

    // An unmapped path with no matching rule is NOT tested here. It is a question about who
    // the fallback refuses, not about the envelope's shape, so it belongs to the file that
    // owns authorization: AdminAuthorizationIT.anUnmappedPathIsDenied covers both the
    // token-less 401 and the ADMIN 403.

    @Test
    void aWrongMethodOnAnAdminRouteStillCarriesTheValidationEnvelope() throws Exception {
        // 405 through the real chain. It needs a method the URL rule admits but no handler
        // maps: PATCH /api/v1/admin/posts passes hasAnyRole(ADMIN, AUTHOR) and then finds no
        // mapping. GlobalExceptionHandler maps any framework 4xx that is not a 404 onto
        // VALIDATION_ERROR.
        mockMvc.perform(patch("/api/v1/admin/posts").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(content().contentTypeCompatibleWith(APPLICATION_JSON))
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"))
                .andExpect(jsonPath("$.error.message").value("The request could not be processed"))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());
    }

    private static List<String> fieldNames(JsonNode node) {
        List<String> names = new ArrayList<>();
        node.propertyNames().forEach(names::add);
        names.sort(null);
        return names;
    }
}
