package com.blog.auth.oauth;

import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.http.converter.FormHttpMessageConverter;
import org.springframework.security.oauth2.client.endpoint.OAuth2AccessTokenResponseClient;
import org.springframework.security.oauth2.client.endpoint.OAuth2AuthorizationCodeGrantRequest;
import org.springframework.security.oauth2.client.endpoint.RestClientAuthorizationCodeTokenResponseClient;
import org.springframework.security.oauth2.client.http.OAuth2ErrorResponseErrorHandler;
import org.springframework.security.oauth2.client.userinfo.DefaultOAuth2UserService;
import org.springframework.security.oauth2.core.http.converter.OAuth2AccessTokenResponseHttpMessageConverter;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestTemplate;

/**
 * The two backend calls to GitHub during one login, sharing the same timeouts: exchanging the code for a token, and
 * reading the profile with {@code GET /user}.
 *
 * Spring's default client sets no timeout: a hung GitHub would hold the request thread (and the waiting Next
 * connection) until TCP gives up. Here connecting takes at most 5 seconds and waiting for a response at most 10
 * seconds; running out of time is an IOException (wrapped in ResourceAccessException when no response arrived, buried
 * under a body-read error when GitHub stops midway), i.e. 502 OAUTH_PROVIDER_UNAVAILABLE.
 *
 * Apart from the timeouts, everything is identical to the Spring Security 7.1 defaults (read in the source):
 * {@link RestClientAuthorizationCodeTokenResponseClient} with {@link FormHttpMessageConverter},
 * {@link OAuth2AccessTokenResponseHttpMessageConverter} and {@link OAuth2ErrorResponseErrorHandler} (the setter is
 * {@code setRestClient}); {@link DefaultOAuth2UserService} with a RestTemplate that has
 * {@link OAuth2ErrorResponseErrorHandler} (the setter is {@code setRestOperations}). Keeping them unchanged is what
 * makes GitHub's "HTTP 200 with an error" response still become {@code invalid_token_response}.
 *
 * HTTP/1.1: GitHub serves it, and it avoids the h2c upgrade the JDK HttpClient tries over plain http (the fake GitHub
 * in tests and E2E runs http on loopback).
 */
final class GithubHttpClients {

    static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
    static final Duration READ_TIMEOUT = Duration.ofSeconds(10);

    private GithubHttpClients() {}

    /** One JDK HttpClient shared by both calls; safe across threads. */
    static ClientHttpRequestFactory requestFactory() {
        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(CONNECT_TIMEOUT)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(client);
        factory.setReadTimeout(READ_TIMEOUT);
        return factory;
    }

    static OAuth2AccessTokenResponseClient<OAuth2AuthorizationCodeGrantRequest> tokenResponseClient(
            ClientHttpRequestFactory requestFactory) {
        RestClient restClient = RestClient.builder()
                .requestFactory(requestFactory)
                .configureMessageConverters(converters -> {
                    converters.addCustomConverter(new FormHttpMessageConverter());
                    converters.addCustomConverter(new OAuth2AccessTokenResponseHttpMessageConverter());
                })
                .defaultStatusHandler(new OAuth2ErrorResponseErrorHandler())
                .build();
        RestClientAuthorizationCodeTokenResponseClient client = new RestClientAuthorizationCodeTokenResponseClient();
        client.setRestClient(restClient);
        return client;
    }

    static DefaultOAuth2UserService userInfoService(ClientHttpRequestFactory requestFactory) {
        RestTemplate restTemplate = new RestTemplate(requestFactory);
        restTemplate.setErrorHandler(new OAuth2ErrorResponseErrorHandler());
        DefaultOAuth2UserService service = new DefaultOAuth2UserService();
        service.setRestOperations(restTemplate);
        return service;
    }
}
