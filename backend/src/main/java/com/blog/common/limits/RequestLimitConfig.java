package com.blog.common.limits;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import tools.jackson.databind.ObjectMapper;

/**
 * Enables {@link RequestLimitProperties} ({@code app.request-limit.*}) and registers {@link RequestSizeLimitFilter} for the
 * API ahead of every other filter that reads a request, the security chain included.
 */
@Configuration
@EnableConfigurationProperties(RequestLimitProperties.class)
public class RequestLimitConfig {

    /** Just after the character-encoding filter, well before the Spring Security chain (order -100). */
    static final int ORDER = Ordered.HIGHEST_PRECEDENCE + 10;

    @Bean
    public FilterRegistrationBean<RequestSizeLimitFilter> requestSizeLimitFilter(
            RequestLimitProperties properties, ObjectMapper objectMapper) {
        FilterRegistrationBean<RequestSizeLimitFilter> registration =
                new FilterRegistrationBean<>(new RequestSizeLimitFilter(
                        properties.publicBody().toBytes(),
                        properties.adminBody().toBytes(),
                        objectMapper));
        registration.addUrlPatterns("/api/*");
        registration.setOrder(ORDER);
        return registration;
    }
}
