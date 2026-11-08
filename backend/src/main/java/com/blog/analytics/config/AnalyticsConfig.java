package com.blog.analytics.config;

import com.blog.analytics.service.ViewSourceClassifier;
import com.blog.auth.oauth.GithubOAuthProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Enables {@link AnalyticsProperties} and builds the view-source classifier from {@code SITE_URL} (the {@code internal} group). */
@Configuration
@EnableConfigurationProperties(AnalyticsProperties.class)
public class AnalyticsConfig {

    @Bean
    public ViewSourceClassifier viewSourceClassifier(GithubOAuthProperties oauth) {
        return new ViewSourceClassifier(oauth.siteUrl());
    }
}
