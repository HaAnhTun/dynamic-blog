package com.blog.auth.mfa;

import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * The development encryption key is committed to a public repository: whoever reads it can decrypt the two-step
 * verification secrets of any instance that still uses it. Only a warning on an opted-in development run; in production
 * the backend already refuses to start when it builds the cipher ({@link MfaConfig}). Same shape as
 * {@code DevSecretWarning}.
 */
@Component
@RequiredArgsConstructor
public class DevMfaKeyWarning implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DevMfaKeyWarning.class);

    private final MfaProperties properties;

    @Override
    public void run(ApplicationArguments args) {
        if (MfaProperties.isDevelopmentKey(properties.encryptionKey())) {
            log.warn("================================================================");
            log.warn("MFA_ENCRYPTION_KEY is the development default, which is committed");
            log.warn("to this repository. Anyone can decrypt the two-step secrets.");
            log.warn("Set MFA_ENCRYPTION_KEY before this is reachable from anywhere but your machine.");
            log.warn("================================================================");
        }
    }
}
