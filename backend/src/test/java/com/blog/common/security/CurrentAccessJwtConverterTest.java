package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.auth.service.AccessTokenVerifier;
import com.blog.auth.service.RefreshTokenService;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserAccess;
import com.blog.user.repository.UserRepository;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.authentication.AuthenticationServiceException;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * The role and status are read from the DB for every role; the token cut-off and the session claim revoke tokens.
 * The real effect through the filter chain (403 right after a demotion, lock or deletion) is in AdminAuthorizationIT.
 */
@ExtendWith(MockitoExtension.class)
class CurrentAccessJwtConverterTest {

    private final UUID id = UUID.randomUUID();

    @Mock
    private UserRepository userRepository;

    @Mock
    private RefreshTokenService refreshTokenService;

    private CurrentAccessJwtConverter converter;

    @BeforeEach
    void setUp() {
        converter = new CurrentAccessJwtConverter(new AccessTokenVerifier(userRepository, refreshTokenService));
        // By default the session the token names is live and belongs to the subject; the tests of the session say
        // otherwise.
        lenient().when(refreshTokenService.isSessionLive(any(), any())).thenReturn(true);
    }

    @Test
    void USER_claim_follows_current_role_in_DB() {
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.ACTIVE)));

        assertThat(authorities(converter.convert(jwt(id.toString(), "USER")))).containsExactly("ROLE_USER");
    }

    @Test
    void token_issued_before_tokens_valid_after_is_rejected() {
        Instant cutOff = Instant.now();
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.ACTIVE, cutOff)));

        assertThatThrownBy(() -> converter.convert(
                        jwtIssuedAt(cutOff.minusSeconds(5), UUID.randomUUID().toString())))
                .isInstanceOf(InvalidBearerTokenException.class);
    }

    @Test
    void token_issued_after_tokens_valid_after_keeps_the_role_from_DB() {
        Instant cutOff = Instant.now();
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.AUTHOR, UserStatus.ACTIVE, cutOff)));

        assertThat(authorities(converter.convert(
                        jwtIssuedAt(cutOff.plusSeconds(1), UUID.randomUUID().toString()))))
                .containsExactly("ROLE_AUTHOR");
    }

    @Test
    void token_issued_in_the_same_second_as_the_cut_off_is_accepted() {
        Instant cutOff = Instant.parse("2026-01-01T10:00:00.900Z");
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.ACTIVE, cutOff)));

        assertThat(authorities(converter.convert(jwtIssuedAt(
                        Instant.parse("2026-01-01T10:00:00Z"), UUID.randomUUID().toString()))))
                .containsExactly("ROLE_USER");
    }

    @Test
    void token_whose_session_has_ended_is_rejected() {
        UUID sid = UUID.randomUUID();
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.ACTIVE)));
        when(refreshTokenService.isSessionLive(id, sid)).thenReturn(false);

        assertThatThrownBy(() -> converter.convert(jwtIssuedAt(Instant.now(), sid.toString())))
                .isInstanceOf(InvalidBearerTokenException.class);
    }

    @Test
    void token_whose_session_belongs_to_another_account_is_rejected() {
        // The lookup is by session AND subject: a live session of somebody else is not this account's session.
        UUID sid = UUID.randomUUID();
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.ADMIN, UserStatus.ACTIVE)));
        when(refreshTokenService.isSessionLive(id, sid)).thenReturn(false);
        lenient()
                .when(refreshTokenService.isSessionLive(UUID.randomUUID(), sid))
                .thenReturn(true);

        assertThatThrownBy(() -> converter.convert(jwtIssuedAt(Instant.now(), sid.toString())))
                .isInstanceOf(InvalidBearerTokenException.class);
    }

    @Test
    void token_without_a_session_claim_is_rejected_and_no_session_is_looked_up() {
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.ADMIN, UserStatus.ACTIVE)));

        assertThatThrownBy(() -> converter.convert(jwtIssuedAt(Instant.now(), null)))
                .isInstanceOf(InvalidBearerTokenException.class);
        verifyNoInteractions(refreshTokenService);
    }

    @Test
    void token_whose_session_is_live_is_accepted() {
        UUID sid = UUID.randomUUID();
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.ACTIVE)));
        when(refreshTokenService.isSessionLive(id, sid)).thenReturn(true);

        assertThat(authorities(converter.convert(jwtIssuedAt(Instant.now(), sid.toString()))))
                .containsExactly("ROLE_USER");
    }

    @Test
    void token_with_a_session_claim_that_is_not_a_UUID_is_rejected() {
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.USER, UserStatus.ACTIVE)));

        assertThatThrownBy(() -> converter.convert(jwtIssuedAt(Instant.now(), "not-a-uuid")))
                .isInstanceOf(InvalidBearerTokenException.class);
    }

    @ParameterizedTest(name = "claim {0}, DB {1} → ROLE_{1}")
    @CsvSource({"ADMIN, AUTHOR", "AUTHOR, ADMIN", "ADMIN, USER", "AUTHOR, AUTHOR"})
    void privileged_claim_follows_current_role_in_DB(String claim, UserRole current) {
        when(userRepository.findAccessById(id)).thenReturn(Optional.of(new UserAccess(current, UserStatus.ACTIVE)));

        AbstractAuthenticationToken token = converter.convert(jwt(id.toString(), claim));

        assertThat(authorities(token)).containsExactly("ROLE_" + current.name());
        // The principal is still the Jwt and the name is sub: AuthenticatedUser.requireUserId reads from there.
        assertThat(token).isInstanceOf(JwtAuthenticationToken.class);
        assertThat(token.getPrincipal()).isInstanceOf(Jwt.class);
        assertThat(token.getName()).isEqualTo(id.toString());
        assertThat(token.isAuthenticated()).isTrue();
    }

    @Test
    void locked_account_has_no_authority() {
        when(userRepository.findAccessById(id))
                .thenReturn(Optional.of(new UserAccess(UserRole.ADMIN, UserStatus.SUSPENDED)));

        assertThat(converter.convert(jwt(id.toString(), "ADMIN")).getAuthorities())
                .isEmpty();
    }

    @Test
    void account_that_no_longer_exists_has_no_authority() {
        when(userRepository.findAccessById(id)).thenReturn(Optional.empty());

        assertThat(converter.convert(jwt(id.toString(), "AUTHOR")).getAuthorities())
                .isEmpty();
    }

    @Test
    void sub_that_is_not_a_UUID_gives_no_authority_and_does_not_read_DB() {
        assertThat(converter.convert(jwt("khong-phai-uuid", "ADMIN")).getAuthorities())
                .isEmpty();
        verifyNoInteractions(userRepository);
    }

    @Test
    void DB_failure_is_rejected_with_AuthenticationServiceException_without_guessing_authority() {
        when(userRepository.findAccessById(id)).thenThrow(new DataAccessResourceFailureException("DB does not answer"));

        assertThatThrownBy(() -> converter.convert(jwt(id.toString(), "ADMIN")))
                .isInstanceOf(AuthenticationServiceException.class)
                .hasCauseInstanceOf(DataAccessResourceFailureException.class);
    }

    private Jwt jwtIssuedAt(Instant issuedAt, String sid) {
        Jwt.Builder builder = Jwt.withTokenValue("token")
                .header("alg", "HS256")
                .subject(id.toString())
                .claim("role", "USER")
                .issuedAt(issuedAt)
                .expiresAt(issuedAt.plusSeconds(900));
        if (sid != null) {
            builder.claim("sid", sid);
        }
        return builder.build();
    }

    /** A token with a session claim (any session: the lookup is stubbed live by default). */
    private static Jwt jwt(String subject, String role) {
        return Jwt.withTokenValue("token")
                .header("alg", "HS256")
                .subject(subject)
                .claim("role", role)
                .claim("sid", UUID.randomUUID().toString())
                .build();
    }

    private static List<String> authorities(AbstractAuthenticationToken token) {
        return token.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .toList();
    }
}
