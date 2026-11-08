package com.blog.auth.oauth;

import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.core.type.AnnotatedTypeMetadata;

/**
 * Whether GitHub login is configured: both client id and client secret are present and non-blank.
 *
 * It does not use {@code @ConditionalOnProperty}: that treats an empty value as "present", while application.yml always
 * sets {@code client-id: ${GITHUB_CLIENT_ID:}}, so the key is always there and may only be blank. It reads through a
 * Binder to match exactly how {@link GithubOAuthProperties} is bound (relaxed key names, environment variables), and
 * shares the definition {@link GithubOAuthProperties#isEnabled}.
 */
public class GithubOAuthConfiguredCondition implements Condition {

    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        Binder binder = Binder.get(context.getEnvironment());
        return GithubOAuthProperties.isEnabled(
                binder.bind("app.oauth.github.client-id", String.class).orElse(null),
                binder.bind("app.oauth.github.client-secret", String.class).orElse(null));
    }
}
