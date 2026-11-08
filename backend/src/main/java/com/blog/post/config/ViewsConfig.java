package com.blog.post.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/** Enables {@link ViewsProperties} ({@code app.views.*}) for the view counter. */
@Configuration
@EnableConfigurationProperties(ViewsProperties.class)
public class ViewsConfig {}
