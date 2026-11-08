package com.blog.auth.oauth;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestResolver;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.RequestMatcher;
import org.springframework.util.StringUtils;

/**
 * Resolver for the login-start path, only for registration ids that really exist (here only {@code github}).
 *
 * For {@code /api/v1/auth/oauth2/authorization/<unknown id>}, DefaultOAuth2AuthorizationRequestResolver throws
 * InvalidClientRegistrationIdException (a non-public class, so it cannot be caught by type), and
 * OAuth2AuthorizationRequestRedirectFilter turns it into a 500 with a WARN line carrying a stack trace. Here an unknown
 * id means "nothing to do" (null): the request continues through the chain to the DispatcherServlet and gets 404
 * ENDPOINT_NOT_FOUND, exactly the answer when GitHub login is off. Next only calls {@code /github}, so this only happens
 * when the backend has a public URL.
 *
 * The id is read with the very same path pattern Spring's resolver uses ({@code <base>/{registrationId}}), so both
 * always read the same id; for a real id everything is handed back untouched to that resolver (PKCE, state,
 * redirect_uri).
 */
final class KnownRegistrationRequestResolver implements OAuth2AuthorizationRequestResolver {

    private static final String REGISTRATION_ID = "registrationId";

    private final OAuth2AuthorizationRequestResolver delegate;
    private final ClientRegistrationRepository registrations;
    private final RequestMatcher authorizationRequest;

    KnownRegistrationRequestResolver(
            OAuth2AuthorizationRequestResolver delegate,
            ClientRegistrationRepository registrations,
            String authorizationBaseUri) {
        this.delegate = delegate;
        this.registrations = registrations;
        this.authorizationRequest =
                PathPatternRequestMatcher.withDefaults().matcher(authorizationBaseUri + "/{" + REGISTRATION_ID + "}");
    }

    @Override
    public OAuth2AuthorizationRequest resolve(HttpServletRequest request) {
        RequestMatcher.MatchResult match = authorizationRequest.matcher(request);
        if (match.isMatch() && !known(match.getVariables().get(REGISTRATION_ID))) {
            return null;
        }
        return delegate.resolve(request);
    }

    @Override
    public OAuth2AuthorizationRequest resolve(HttpServletRequest request, String clientRegistrationId) {
        if (clientRegistrationId != null && !known(clientRegistrationId)) {
            return null;
        }
        return delegate.resolve(request, clientRegistrationId);
    }

    /** The registration repository rejects an empty id with IllegalArgumentException: an empty id is also an unknown id. */
    private boolean known(String registrationId) {
        return StringUtils.hasText(registrationId) && registrations.findByRegistrationId(registrationId) != null;
    }
}
