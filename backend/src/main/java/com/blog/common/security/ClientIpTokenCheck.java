package com.blog.common.security;

import com.blog.common.ratelimit.ClientIpProperties;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * Refuses to start in production ({@link ProductionMode}) when {@code CLIENT_IP_TOKEN} is blank, shorter than
 * {@value #MIN_LENGTH} characters or guessable ({@link SecretStrength}).
 *
 * Without the token the backend cannot believe the reader address that Next forwards, so every per-address limit (contact,
 * newsletter, sign-in, refresh, setup, search) would count the Next server as one single caller: the first few readers
 * would use up the quota of everyone. Development defaults (the dev profile or APP_ALLOW_DEV_DEFAULTS=true) keep a blank
 * token usable. The token is never printed.
 */
@Component
@RequiredArgsConstructor
public class ClientIpTokenCheck implements ApplicationRunner {

    /** The fewest characters; the documented {@code openssl rand -hex 32} gives 64. */
    static final int MIN_LENGTH = 16;

    private final ClientIpProperties clientIp;
    private final ProductionMode productionMode;

    @Override
    public void run(ApplicationArguments args) {
        if (productionMode.active() && !clientIp.tokenSet()) {
            throw new IllegalStateException("CLIENT_IP_TOKEN is empty in a production run, so the backend cannot tell "
                    + "the readers apart: its per-address limits (contact form, newsletter, sign-in, refresh, setup, "
                    + "search) would count the whole Next server as one caller. Set the same CLIENT_IP_TOKEN "
                    + "(openssl rand -hex 32) on the backend and the frontend. A throw-away dev or E2E stack can opt in "
                    + "with APP_ALLOW_DEV_DEFAULTS=true.");
        }
        if (productionMode.active()) {
            SecretStrength.require("CLIENT_IP_TOKEN", clientIp.token(), MIN_LENGTH, "openssl rand -hex 32");
        }
    }
}
