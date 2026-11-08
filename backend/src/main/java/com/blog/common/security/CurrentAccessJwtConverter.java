package com.blog.common.security;

import com.blog.auth.service.AccessTokenVerifier;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

/**
 * The access token's claims are not trusted for authority. On every request the account is read from the DB, for every
 * role:
 * <ul>
 *   <li>the current role and status decide the authority, so a demotion or a suspension takes effect immediately. A
 *       suspended account, or one that no longer exists, has no authority at all (403, not 401);
 *   <li>a token issued before the account's {@code tokens_valid_after} is revoked (401): logout of every session, a
 *       password change, a role change, a suspension;
 *   <li>a token is revoked (401) once the login session named by its {@code sid} claim has no live refresh token left (a
 *       logout, a detected reuse of a refresh token of that session), so a logout kills the access token of that session at
 *       once. This is one indexed lookup, by session AND subject: the claim is required, and a session of another account
 *       does not count (audit 112).
 * </ul>
 * A DB error means refusal (503).
 */
@Component
@RequiredArgsConstructor
public class CurrentAccessJwtConverter implements Converter<Jwt, AbstractAuthenticationToken> {

    private final AccessTokenVerifier verifier;

    @Override
    public AbstractAuthenticationToken convert(Jwt jwt) {
        return new JwtAuthenticationToken(jwt, authoritiesOf(verifier.currentRole(jwt)), jwt.getSubject());
    }

    private static List<GrantedAuthority> authoritiesOf(Optional<String> role) {
        return role.filter(r -> !r.isBlank())
                .<List<GrantedAuthority>>map(r -> List.of(new SimpleGrantedAuthority("ROLE_" + r)))
                .orElse(List.of());
    }
}
