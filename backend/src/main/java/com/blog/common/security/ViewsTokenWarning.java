package com.blog.common.security;

import com.blog.post.config.ViewsProperties;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * Refuses to start in production ({@link ProductionMode}) when {@code VIEWS_TOKEN} is blank, shorter than
 * {@value #MIN_LENGTH} characters or guessable ({@link SecretStrength}).
 *
 * Otherwise {@code POST /api/v1/posts/{slug}/views}, the only anonymous write, accepts views from anyone who can reach
 * the backend, not only from the Next server: views decide the "most read" order. Development defaults (the dev profile
 * or APP_ALLOW_DEV_DEFAULTS=true) keep a blank token usable. The token is never printed.
 */
@Component
@RequiredArgsConstructor
public class ViewsTokenWarning implements ApplicationRunner {

    /** The fewest characters; the documented {@code openssl rand -hex 32} gives 64. */
    static final int MIN_LENGTH = 16;

    private final ViewsProperties views;
    private final ProductionMode productionMode;

    @Override
    public void run(ApplicationArguments args) {
        if (productionMode.active() && !views.tokenRequired()) {
            throw new IllegalStateException("VIEWS_TOKEN is empty in a production run, so anyone who can reach this "
                    + "backend directly could add views to any published post, and views decide the \"popular\" "
                    + "order. Set the same VIEWS_TOKEN (openssl rand -hex 32) on the backend and the frontend. A "
                    + "throw-away dev or E2E stack can opt in with APP_ALLOW_DEV_DEFAULTS=true.");
        }
        if (productionMode.active()) {
            SecretStrength.require("VIEWS_TOKEN", views.token(), MIN_LENGTH, "openssl rand -hex 32");
        }
    }
}
