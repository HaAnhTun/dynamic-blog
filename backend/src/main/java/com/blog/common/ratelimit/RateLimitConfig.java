package com.blog.common.ratelimit;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * Enables {@link RateLimitProperties} ({@code app.rate-limit.*}) for {@link RateLimiter} and {@link ClientIpProperties}
 * ({@code app.client-ip.*}) for {@link ClientAddressResolver}.
 */
@Configuration
@EnableConfigurationProperties({RateLimitProperties.class, ClientIpProperties.class})
public class RateLimitConfig {}
