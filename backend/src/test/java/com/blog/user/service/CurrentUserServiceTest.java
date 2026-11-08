package com.blog.user.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * The gate of every write: the status is read from the DB each time, the access token is not trusted,
 * because the token of someone who was just suspended stays alive for up to 15 minutes.
 */
@ExtendWith(MockitoExtension.class)
class CurrentUserServiceTest {

    @Mock
    private UserRepository userRepository;

    @InjectMocks
    private CurrentUserService currentUserService;

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    private static UUID signedIn() {
        UUID id = UUID.randomUUID();
        Jwt jwt = Jwt.withTokenValue("token")
                .header("alg", "HS256")
                .subject(id.toString())
                .claim("role", "USER")
                .build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));
        return id;
    }

    @Test
    void active_account_returns_the_id_taken_from_the_token() {
        UUID id = signedIn();
        when(userRepository.findStatusById(id)).thenReturn(Optional.of(UserStatus.ACTIVE));

        assertThat(currentUserService.requireActive()).isEqualTo(id);
    }

    @Test
    void suspended_account_gets_403_USER_SUSPENDED_even_though_token_is_still_valid() {
        UUID id = signedIn();
        when(userRepository.findStatusById(id)).thenReturn(Optional.of(UserStatus.SUSPENDED));

        assertThatThrownBy(() -> currentUserService.requireActive())
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.USER_SUSPENDED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.FORBIDDEN);
    }

    @Test
    void account_no_longer_in_db_gets_401_UNAUTHENTICATED() {
        UUID id = signedIn();
        when(userRepository.findStatusById(id)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> currentUserService.requireActive())
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.UNAUTHENTICATED)
                .hasFieldOrPropertyWithValue("status", HttpStatus.UNAUTHORIZED);
    }

    @Test
    void no_logged_in_user_gets_401_without_asking_the_db() {
        assertThatThrownBy(() -> currentUserService.requireActive())
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.UNAUTHENTICATED);
        verifyNoInteractions(userRepository);
    }
}
