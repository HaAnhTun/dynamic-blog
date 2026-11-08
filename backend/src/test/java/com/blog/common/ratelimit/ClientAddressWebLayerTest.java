package com.blog.common.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.auth.controller.AuthController;
import com.blog.auth.controller.MfaLoginController;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.AuthService;
import com.blog.auth.service.FirstFactorResult;
import com.blog.auth.service.MfaSignInService;
import com.blog.common.i18n.I18nProperties;
import com.blog.common.i18n.Languages;
import com.blog.contact.controller.ContactController;
import com.blog.contact.service.ContactService;
import com.blog.newsletter.controller.NewsletterController;
import com.blog.newsletter.service.NewsletterService;
import com.blog.search.controller.SearchController;
import com.blog.search.service.SearchService;
import com.blog.setup.controller.SetupController;
import com.blog.setup.service.SetupService;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.stubbing.Answer;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * The trust rule for the forwarded reader address, seen through the real controllers of every endpoint that uses it:
 * contact, the three newsletter POSTs, login, the three calls of the second step of a sign-in, refresh, setup and
 * search. The services are mocks that record the {@link ClientAddress} they are given, so what is proved is exactly
 * what the controller hands to the limits.
 */
class ClientAddressWebLayerTest {

    private static final String TOKEN = "web-layer-client-ip-token-not-a-real-secret";
    private static final String SOCKET = "198.51.100.7";

    private final AtomicReference<ClientAddress> seen = new AtomicReference<>();
    private final ContactService contact = mock(ContactService.class);
    private final NewsletterService newsletter = mock(NewsletterService.class);
    private final AuthService auth = mock(AuthService.class);
    private final MfaSignInService mfaSignIn = mock(MfaSignInService.class);
    private final SetupService setup = mock(SetupService.class);
    private final SearchService search = mock(SearchService.class);
    private MockMvc mvc;

    @BeforeEach
    void wire() {
        // Each service gets the address as its LAST argument; remember it, answer with nothing.
        Answer<Object> remember = invocation -> {
            seen.set(invocation.getArgument(invocation.getArguments().length - 1));
            return null;
        };
        doAnswer(remember).when(contact).submit(any(), any());
        doAnswer(remember).when(newsletter).subscribe(any(), any(), any());
        doAnswer(remember).when(newsletter).confirm(any(), any());
        doAnswer(remember).when(newsletter).unsubscribe(any(), any());
        // A login answers with a session or a challenge: a session, here, so the controller has something to write.
        when(auth.login(any(), any())).thenAnswer(invocation -> {
            remember.answer(invocation);
            return new FirstFactorResult.Session(new TokenResponse("access", "refresh", 900, 604_800L));
        });
        when(mfaSignIn.verify(any(), any(), any())).thenAnswer(remember);
        when(mfaSignIn.beginEnrollment(any(), any(), any())).thenAnswer(remember);
        when(mfaSignIn.confirmEnrollment(any(), any(), any())).thenAnswer(remember);
        when(auth.refresh(any(), any())).thenAnswer(remember);
        when(setup.complete(any(), any())).thenAnswer(remember);
        when(search.search(any(), any(), any(), anyInt(), anyInt(), any(), any(), any(), any(), any()))
                .thenAnswer(remember);

        ClientAddressResolver resolver = new ClientAddressResolver(new ClientIpProperties(TOKEN));
        Languages languages = new Languages(new I18nProperties(List.of("vi", "en"), "vi"));
        mvc = MockMvcBuilders.standaloneSetup(
                        new ContactController(contact, resolver),
                        new NewsletterController(newsletter, resolver),
                        new AuthController(auth, resolver),
                        new MfaLoginController(mfaSignIn, resolver),
                        new SetupController(setup, resolver),
                        new SearchController(search, languages, resolver))
                .build();
    }

    private static MockHttpServletRequestBuilder json(String path, Map<String, Object> body) {
        StringBuilder text = new StringBuilder("{");
        body.forEach((key, value) -> {
            if (text.length() > 1) {
                text.append(',');
            }
            text.append('"').append(key).append("\":\"").append(value).append('"');
        });
        return post(path).contentType(APPLICATION_JSON).content(text.append('}').toString());
    }

    /** One fresh request for each endpoint that keys a limit on the client address. */
    private static Map<String, Supplier<MockHttpServletRequestBuilder>> endpoints() {
        Map<String, Supplier<MockHttpServletRequestBuilder>> all = new LinkedHashMap<>();
        all.put("contact", () -> json("/api/v1/contact/messages", Map.of("name", "n", "email", "a@example.com")));
        all.put(
                "newsletter subscribe",
                () -> json("/api/v1/newsletter/subscriptions", Map.of("email", "a@example.com")));
        all.put("newsletter confirm", () -> json("/api/v1/newsletter/confirm", Map.of("token", "t")));
        all.put("newsletter unsubscribe", () -> json("/api/v1/newsletter/unsubscribe", Map.of("token", "t")));
        all.put("login", () -> json("/api/v1/auth/login", Map.of("email", "a@example.com", "password", "p")));
        all.put("mfa verify", () -> json("/api/v1/auth/mfa/verify", Map.of("challenge", "c", "code", "123456")));
        all.put("mfa enroll begin", () -> json("/api/v1/auth/mfa/enroll/begin", Map.of("challenge", "c")));
        all.put(
                "mfa enroll confirm",
                () -> json("/api/v1/auth/mfa/enroll/confirm", Map.of("challenge", "c", "code", "123456")));
        all.put("refresh", () -> json("/api/v1/auth/refresh", Map.of("refreshToken", "t")));
        all.put("setup", () -> json("/api/v1/setup", Map.of("setupCode", "c")));
        all.put("search", () -> get("/api/v1/search").param("q", "spring"));
        return all;
    }

    private String addressFor(MockHttpServletRequestBuilder request, String forwarded, String token) throws Exception {
        seen.set(null);
        request.with(r -> {
            r.setRemoteAddr(SOCKET);
            return r;
        });
        if (forwarded != null) {
            request.header(ClientAddressResolver.ADDRESS_HEADER, forwarded);
        }
        if (token != null) {
            request.header(ClientAddressResolver.TOKEN_HEADER, token);
        }
        mvc.perform(request);
        assertThat(seen.get()).as("the service was called").isNotNull();
        return seen.get().key();
    }

    @Test
    void with_the_secret_every_endpoint_counts_the_forwarded_address() throws Exception {
        for (var endpoint : endpoints().entrySet()) {
            assertThat(addressFor(endpoint.getValue().get(), "203.0.113.9", TOKEN))
                    .as(endpoint.getKey())
                    .isEqualTo("203.0.113.9");
            assertThat(addressFor(endpoint.getValue().get(), "2001:db8:1:2::9", TOKEN))
                    .as(endpoint.getKey() + " ipv6")
                    .isEqualTo("2001:db8:1:2::/64");
        }
    }

    @Test
    void without_the_secret_every_endpoint_counts_the_socket_address_whatever_the_headers_say() throws Exception {
        for (var endpoint : endpoints().entrySet()) {
            assertThat(addressFor(endpoint.getValue().get(), "203.0.113.9", null))
                    .as(endpoint.getKey() + " no token")
                    .isEqualTo(SOCKET);
            assertThat(addressFor(endpoint.getValue().get(), "203.0.113.9", "a-guess-at-the-secret"))
                    .as(endpoint.getKey() + " wrong token")
                    .isEqualTo(SOCKET);
            assertThat(addressFor(endpoint.getValue().get(), null, null))
                    .as(endpoint.getKey() + " plain request")
                    .isEqualTo(SOCKET);
        }
    }

    @Test
    void with_the_secret_but_no_readable_address_every_endpoint_counts_unknown_not_the_socket() throws Exception {
        for (var endpoint : endpoints().entrySet()) {
            assertThat(addressFor(endpoint.getValue().get(), null, TOKEN))
                    .as(endpoint.getKey() + " no address")
                    .isEqualTo(ClientAddress.UNKNOWN.key());
            assertThat(addressFor(endpoint.getValue().get(), "not-an-ip", TOKEN))
                    .as(endpoint.getKey() + " junk address")
                    .isEqualTo(ClientAddress.UNKNOWN.key());
        }
    }
}
