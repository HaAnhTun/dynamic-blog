package com.blog.common.security;

import com.blog.common.config.SecurityProperties;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * A signing secret committed to a public repository means anyone can mint a valid ADMIN
 * token for any instance still using it. That is worth more than a comment in a YAML file.
 *
 * Only a warning on opted-in dev machines: in production (ProductionMode) the backend already refuses to start when it
 * builds {@code jwtEncoder} (SecurityConfig.refuseDevelopmentSecretInProduction), before this runner gets a chance to
 * run.
 */
@Component
@RequiredArgsConstructor
public class DevSecretWarning implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DevSecretWarning.class);

    private final SecurityProperties properties;

    @Override
    public void run(ApplicationArguments args) {
        if (SecurityProperties.DEV_JWT_SECRET.equals(properties.jwtSecret())) {
            log.warn("================================================================");
            log.warn("JWT_SECRET is the development default, which is committed to this");
            log.warn("repository. Anyone can mint a valid ADMIN token for this instance.");
            log.warn("Set JWT_SECRET before it is reachable from anywhere but your machine.");
            log.warn("================================================================");
        }
    }
}
