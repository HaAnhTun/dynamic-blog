package com.blog.common.quota;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/** Enables {@link AuthorQuotaProperties} ({@code app.author-quota.*}). */
@Configuration
@EnableConfigurationProperties(AuthorQuotaProperties.class)
public class AuthorQuotaConfig {}
