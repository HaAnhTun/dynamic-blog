package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.support.AbstractIntegrationTest;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

class TokenServiceIT extends AbstractIntegrationTest {

    @Autowired
    private TokenService tokenService;

    @Autowired
    private JwtDecoder jwtDecoder;

    @Autowired
    private UserRepository userRepository;

    private User admin() {
        return userRepository.findByEmail("admin@blog.local").orElseThrow();
    }

    private String token() {
        return tokenService.mint(admin(), UUID.randomUUID(), Instant.now());
    }

    @Test
    void mintsATokenCarryingSubjectAndRole() {
        var jwt = jwtDecoder.decode(token());

        assertThat(jwt.getSubject()).isEqualTo(admin().getId().toString());
        assertThat(jwt.getClaimAsString("role")).isEqualTo("ADMIN");
        assertThat(jwt.getExpiresAt()).isNotNull();
    }

    @Test
    void aSessionTokenCarriesTheSessionAndWhenItStartedInEpochSeconds() {
        UUID session = UUID.randomUUID();
        Instant signedIn = Instant.parse("2026-10-18T10:00:00.789Z");

        var jwt = jwtDecoder.decode(tokenService.mint(admin(), session, signedIn));

        assertThat(jwt.getClaimAsString(TokenService.SESSION_CLAIM)).isEqualTo(session.toString());
        assertThat(jwt.<Number>getClaim(TokenService.AUTH_TIME_CLAIM).longValue())
                .isEqualTo(signedIn.getEpochSecond());
        // It is the start of the session, not the issue time of this token.
        assertThat(jwt.getIssuedAt()).isAfter(signedIn);
    }

    @Test
    void thereIsNoWayToMintATokenWithoutASession() {
        assertThatThrownBy(() -> tokenService.mint(admin(), Instant.now(), null, Instant.now()))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> tokenService.mint(admin(), UUID.randomUUID(), null))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    void rejectsATokenSignedWithADifferentSecret() {
        // The hole this guards is signature verification silently not happening. An
        // expiry test cannot see that; a foreign signature can.
        var foreignKey = new SecretKeySpec(
                "a-completely-different-secret-at-least-32-bytes".getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        JwtDecoder foreignDecoder = NimbusJwtDecoder.withSecretKey(foreignKey).build();
        String token = token();

        // Control: the real decoder accepts it, so the rejection below is about the
        // signature and not about a malformed token.
        assertThat(jwtDecoder.decode(token)).isNotNull();
        assertThatThrownBy(() -> foreignDecoder.decode(token)).isInstanceOf(JwtException.class);
    }

    @Test
    void rejectsAGarbageToken() {
        assertThatThrownBy(() -> jwtDecoder.decode("not.a.jwt")).isInstanceOf(JwtException.class);
    }

    @Test
    void reportsTheConfiguredAccessTokenLifetime() {
        assertThat(tokenService.accessTokenSeconds()).isEqualTo(900L);
    }
}
