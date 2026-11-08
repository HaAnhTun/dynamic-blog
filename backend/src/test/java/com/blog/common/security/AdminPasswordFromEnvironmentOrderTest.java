package com.blog.common.security;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.auth.service.MfaService;
import com.blog.auth.service.RefreshTokenService;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * The order of the checks of the startup runner: the password policy runs only after the "already correct" check, and a
 * refused value is never hashed or written. A unit test, because only mocks can see the order.
 */
class AdminPasswordFromEnvironmentOrderTest {

    private static final String EMAIL = "owner@example.test";

    private final UserRepository users = mock(UserRepository.class);
    private final PasswordEncoder encoder = mock(PasswordEncoder.class);
    private final RefreshTokenService refreshTokens = mock(RefreshTokenService.class);
    private final MfaService mfa = mock(MfaService.class);
    private final PasswordPolicy policy = org.mockito.Mockito.spy(new PasswordPolicy());

    private AdminPasswordFromEnvironment runner(String password) {
        return new AdminPasswordFromEnvironment(
                users, encoder, new AdminAccountProperties(EMAIL, password, null), refreshTokens, policy, mfa);
    }

    private User admin() {
        User admin = new User();
        admin.setPasswordHash("stored-hash");
        when(users.findByEmail(EMAIL)).thenReturn(Optional.of(admin));
        return admin;
    }

    @Test
    void the_policy_is_asked_only_after_the_encoder_compared_the_value_with_the_stored_hash() {
        admin();
        when(encoder.matches("welcome12345", "stored-hash")).thenReturn(true);

        runner("welcome12345").run(new DefaultApplicationArguments());

        InOrder order = inOrder(encoder, policy);
        order.verify(encoder).matches("welcome12345", "stored-hash");
        order.verify(policy).check("welcome12345", EMAIL);
        verify(users, never()).save(any());
    }

    @Test
    void a_new_value_that_fails_the_policy_is_never_hashed_or_saved() {
        admin();
        when(encoder.matches("welcome12345", "stored-hash")).thenReturn(false);

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> runner("welcome12345").run(new DefaultApplicationArguments()))
                .isInstanceOf(IllegalStateException.class);

        verify(encoder, never()).encode(any());
        verify(users, never()).save(any());
        verify(refreshTokens, never()).revokeAllSessions(any(), any());
        verify(mfa, never()).clearSecondStepLock(any());
    }

    @Test
    void a_value_that_meets_the_policy_is_applied() {
        User admin = admin();
        admin.setId(java.util.UUID.randomUUID());
        when(encoder.matches("plum-tractor-violin-9", "stored-hash")).thenReturn(false);
        when(encoder.encode("plum-tractor-violin-9")).thenReturn("new-hash");

        runner("plum-tractor-violin-9").run(new DefaultApplicationArguments());

        verify(users).save(admin);
        verify(refreshTokens).revokeAllSessions(any(), any());
        // A real change also clears the brake on the account's second step.
        verify(mfa).clearSecondStepLock(admin.getId());
    }
}
