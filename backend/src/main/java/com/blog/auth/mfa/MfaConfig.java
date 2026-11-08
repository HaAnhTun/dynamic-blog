package com.blog.auth.mfa;

import com.blog.common.config.SecurityProperties;
import com.blog.common.security.ProductionMode;
import java.security.SecureRandom;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the two-step verification primitives. The cipher is an eagerly built singleton, so a missing or unusable
 * {@code MFA_ENCRYPTION_KEY} stops the backend before Tomcat accepts any connection, in every mode
 * ({@link MfaProperties#requireKeyBytes()}); the development key and a key equal to {@code JWT_SECRET} are refused when
 * {@link ProductionMode#active()} ({@link MfaSecretCipher#refuseUnsafeKey}).
 */
@Configuration
@EnableConfigurationProperties(MfaProperties.class)
public class MfaConfig {

    @Bean
    public MfaSecretCipher mfaSecretCipher(
            MfaProperties properties, SecurityProperties security, ProductionMode productionMode) {
        byte[] key = properties.requireKeyBytes();
        MfaSecretCipher.refuseUnsafeKey(properties.encryptionKey(), security.jwtSecret(), productionMode.active());
        return new MfaSecretCipher(key);
    }

    @Bean
    public Totp totp() {
        return new Totp();
    }

    /** The one source of randomness for secrets, recovery codes and challenges. */
    @Bean
    public SecureRandom mfaSecureRandom() {
        return new SecureRandom();
    }
}
