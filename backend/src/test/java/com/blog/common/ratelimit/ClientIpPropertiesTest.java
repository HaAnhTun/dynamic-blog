package com.blog.common.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.mock.web.MockHttpServletRequest;

/**
 * {@code CLIENT_IP_TOKEN} at startup: the {@code app.client-ip.token} key, stripped like {@code VIEWS_TOKEN}, empty when
 * absent, and never printed. ApplicationContextRunner, no DB.
 */
class ClientIpPropertiesTest {

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withUserConfiguration(RateLimitConfig.class);

    @Test
    void the_key_reaches_the_properties_stripped_and_the_resolver_believes_only_that_token() {
        runner.withBean(ClientAddressResolver.class)
                .withPropertyValues("app.client-ip.token=  a-very-secret-value  ")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    ClientIpProperties properties = context.getBean(ClientIpProperties.class);
                    assertThat(properties.token()).isEqualTo("a-very-secret-value");
                    assertThat(properties.tokenSet()).isTrue();

                    MockHttpServletRequest request = new MockHttpServletRequest();
                    request.setRemoteAddr("198.51.100.7");
                    request.addHeader(ClientAddressResolver.ADDRESS_HEADER, "203.0.113.9");
                    request.addHeader(ClientAddressResolver.TOKEN_HEADER, "a-very-secret-value");
                    assertThat(context.getBean(ClientAddressResolver.class)
                                    .resolve(request)
                                    .key())
                            .isEqualTo("203.0.113.9");
                });
    }

    @Test
    void without_the_key_no_token_is_set() {
        runner.run(context ->
                assertThat(context.getBean(ClientIpProperties.class).tokenSet()).isFalse());
    }

    @Test
    void the_token_is_never_printed() {
        runner.withPropertyValues("app.client-ip.token=a-very-secret-value")
                .run(context -> assertThat(
                                context.getBean(ClientIpProperties.class).toString())
                        .doesNotContain("a-very-secret-value"));
    }
}
