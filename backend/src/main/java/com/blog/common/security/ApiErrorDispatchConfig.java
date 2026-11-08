package com.blog.common.security;

import jakarta.servlet.DispatcherType;
import java.util.EnumSet;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import tools.jackson.databind.ObjectMapper;

/** Registers {@link ApiErrorDispatchFilter} for the ERROR dispatch only, ahead of the security chain (order -100). */
@Configuration
public class ApiErrorDispatchConfig {

    /** Before everything that reads a request, the request-size filter and the security chain included. */
    static final int ORDER = Ordered.HIGHEST_PRECEDENCE + 5;

    @Bean
    public FilterRegistrationBean<ApiErrorDispatchFilter> apiErrorDispatchFilter(ObjectMapper objectMapper) {
        FilterRegistrationBean<ApiErrorDispatchFilter> registration =
                new FilterRegistrationBean<>(new ApiErrorDispatchFilter(objectMapper));
        registration.addUrlPatterns("/*");
        registration.setDispatcherTypes(EnumSet.of(DispatcherType.ERROR));
        registration.setOrder(ORDER);
        return registration;
    }
}
