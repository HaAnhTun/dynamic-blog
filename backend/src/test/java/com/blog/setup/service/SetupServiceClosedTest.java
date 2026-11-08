package com.blog.setup.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.security.PasswordPolicy;
import com.blog.setup.dto.SetupRequest;
import jakarta.validation.Validator;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;

/**
 * A completed instance answers {@code /setup} without opening a transaction (issue 033). Taking the setup lock means a
 * database connection and a serialized turn, so a crowd that sends requests to a finished instance (each address is allowed
 * five a minute and the map of addresses evicts, so the crowd can be as large as it likes) could otherwise queue
 * lock-taking transactions behind one another. Completion is permanent, so a plain read of the flag decides first; the
 * locked read inside the transaction still decides for an instance that is not completed.
 */
class SetupServiceClosedTest {

    private final RateLimiter rateLimiter = mock(RateLimiter.class);
    private final SetupState state = mock(SetupState.class);
    private final SetupCodeStore codeStore = mock(SetupCodeStore.class);
    private final PlatformTransactionManager transactionManager = mock(PlatformTransactionManager.class);
    private final SetupService service = new SetupService(
            rateLimiter,
            state,
            codeStore,
            mock(SetupAccounts.class),
            mock(PasswordEncoder.class),
            mock(PasswordPolicy.class),
            mock(Validator.class),
            transactionManager);

    private static final ClientAddress CLIENT = new ClientAddress("203.0.113.9");
    private static final SetupRequest FORM =
            new SetupRequest("code", "owner@example.com", "a-long-password", "Owner", null);

    @Test
    void a_completed_instance_is_a_404_before_any_transaction_or_lock() {
        when(state.isRequired()).thenReturn(false);

        assertThatThrownBy(() -> service.complete(FORM, CLIENT)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.SETUP_CLOSED);
            assertThat(e.getStatus().value()).isEqualTo(404);
        });

        verifyNoInteractions(transactionManager);
        verify(state, never()).lockForUpdate();
        verify(codeStore, never()).matches(any());
        // The per-address count still comes first and the wrong-code count is not charged: nothing was compared.
        verify(rateLimiter).check(RateLimiter.SETUP_CLIENT, CLIENT.key());
        verify(rateLimiter, never()).check(RateLimiter.SETUP, RateLimiter.SETUP_GLOBAL_KEY);
    }

    @Test
    void an_instance_that_is_not_completed_still_decides_inside_the_locked_transaction() {
        when(state.isRequired()).thenReturn(true);
        when(transactionManager.getTransaction(any())).thenReturn(mock(TransactionStatus.class));
        when(state.lockForUpdate()).thenReturn(false);

        // Completed by someone else between the plain read and the lock: the locked read has the last word.
        assertThatThrownBy(() -> service.complete(FORM, CLIENT))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.SETUP_CLOSED));

        verify(state).lockForUpdate();
    }

    @Test
    void a_wrong_code_on_a_fresh_instance_is_counted_against_the_process_after_the_comparison() {
        when(state.isRequired()).thenReturn(true);
        when(transactionManager.getTransaction(any())).thenReturn(mock(TransactionStatus.class));
        when(state.lockForUpdate()).thenReturn(true);
        when(codeStore.matches("code")).thenReturn(false);

        assertThatThrownBy(() -> service.complete(FORM, CLIENT))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.SETUP_CODE_INVALID));

        verify(rateLimiter).check(RateLimiter.SETUP, RateLimiter.SETUP_GLOBAL_KEY);
    }
}
