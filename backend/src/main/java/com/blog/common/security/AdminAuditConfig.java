package com.blog.common.security;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Puts {@link AdminAuditInterceptor} on the admin API. */
@Configuration
public class AdminAuditConfig implements WebMvcConfigurer {

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new AdminAuditInterceptor()).addPathPatterns("/api/v1/admin/**");
    }
}
