package com.blog.auth.service;

import com.blog.common.config.SecurityProperties;
import com.blog.user.entity.User;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class TokenService {

    /**
     * Who issues the access tokens and for whom they are meant (the {@code iss} and {@code aud} claims). The decoder
     * (SecurityConfig) accepts a token only with exactly these, so a token signed with the same secret for some other purpose
     * is not an access token of this API (audit 075).
     */
    public static final String ISSUER = "blog-backend";

    public static final String AUDIENCE = "blog-api";

    /** The login session the token is bound to; CurrentAccessJwtConverter rejects the token once it has ended. */
    public static final String SESSION_CLAIM = "sid";

    /**
     * When the person last signed in with a first factor, in epoch seconds: the start of the session
     * ({@code refresh_tokens.authenticated_at}), copied unchanged by every rotation. Informational: nothing trusts it.
     * What a session can prove is read from its row (RecentAuthentication), never from this claim.
     */
    public static final String AUTH_TIME_CLAIM = "auth_time";

    private final JwtEncoder jwtEncoder;
    private final SecurityProperties properties;

    /**
     * An access token bound to a login session: it dies with the session (the {@code sid} claim) and carries when that
     * session started ({@code auth_time}). The only way AuthService mints a token for a person who signed in, and the only
     * kind of token the backend accepts: a token without a session is refused (AccessTokenVerifier), so there is no
     * overload that makes one.
     */
    public String mint(User user, UUID sessionId, Instant authenticatedAt) {
        return mint(user, Instant.now(), sessionId, authenticatedAt);
    }

    /**
     * The issue instant is a parameter so a test can mint a token that is already expired, or one issued before an
     * account cut-off, without hand-building a second {@link JwtClaimsSet}.
     *
     * This is the only place that builds a <em>well-formed</em> claim set. That matters
     * because a hand-built copy keeps passing on the day a claim is added here, while
     * silently testing a token the server never issues — so an expired, a foreign-signed or
     * any other valid-shaped token belongs here (see {@code AuthTestSupport}), not in a
     * builder of its own.
     *
     * The remaining hand-built encoders in the test tree are the deliberate exceptions, and
     * they must stay: they build claim sets this method <em>cannot</em> produce — a non-UUID
     * {@code sub}, no {@code sub} claim at all, and a token without a session — to prove those are
     * rejected as 401 rather than crashing as a 500 or being waved through, and
     * {@code SecurityBoundaryIT} signs with a foreign key, which no amount of claim-shaping
     * here would reproduce. Folding those into this method would delete the only coverage of
     * the malformed-token paths, because a method that takes a {@link User} can never emit a
     * subject that is not a UUID, nor a token the verifier must refuse.
     */
    public String mint(User user, Instant issuedAt, UUID sessionId, Instant authenticatedAt) {
        Objects.requireNonNull(sessionId, "sessionId");
        Objects.requireNonNull(authenticatedAt, "authenticatedAt");
        JwtClaimsSet claims = JwtClaimsSet.builder()
                .issuer(ISSUER)
                .audience(List.of(AUDIENCE))
                .claim(SESSION_CLAIM, sessionId.toString())
                // Epoch seconds as a plain number: the encoder writes registered time claims itself, not custom ones.
                .claim(AUTH_TIME_CLAIM, authenticatedAt.getEpochSecond())
                .subject(user.getId().toString())
                .issuedAt(issuedAt)
                .expiresAt(issuedAt.plus(properties.accessTokenTtl()))
                // The role travels in the token, per spec §6, but it is only a hint:
                // CurrentAccessJwtConverter reads the current role from the database for every role.
                .claim("role", user.getRole().name())
                .build();
        return jwtEncoder
                .encode(JwtEncoderParameters.from(JwsHeader.with(() -> "HS256").build(), claims))
                .getTokenValue();
    }

    public long accessTokenSeconds() {
        return properties.accessTokenTtl().toSeconds();
    }
}
