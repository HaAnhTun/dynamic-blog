package com.blog.setup.service;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.common.security.ProductionMode;
import com.blog.common.security.SeedAdmin;
import com.blog.setup.config.SetupProperties;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;

/**
 * What the dev-seed lock does when it cannot do its job, and whether the operator can switch it off on a public site. The
 * collaborators are mocks: the decision is under test, the real database part is in SetupStartupRunnersIT.
 *
 * The lock is the first line against the development password of the seeded admin (the login check of AuthService and the
 * refusal of DevCredentialWarning come after it), so on a production run a database error must stop the start (the restart
 * policy then tries again, the runner is idempotent) instead of leaving the default credential in place with one WARN line.
 */
class SetupDevSeedLockTest {

    private static final String DEV_HASH = "$argon2id$hash-of-the-development-password";

    private final SetupState state = mock(SetupState.class);
    private final SetupAccounts accounts = mock(SetupAccounts.class);
    private final PasswordEncoder encoder = mock(PasswordEncoder.class);
    private final PlatformTransactionManager transactions = mock(PlatformTransactionManager.class);
    private final ProductionMode production = mock(ProductionMode.class);

    private SetupDevSeedLock lock(boolean lockDevSeed, boolean productionRun) {
        when(production.active()).thenReturn(productionRun);
        SetupProperties properties = new SetupProperties(null, "./data", lockDevSeed);
        return new SetupDevSeedLock(properties, state, accounts, encoder, transactions, production);
    }

    private void aFreshInstallWithTheDevPassword() {
        when(state.lockForUpdate()).thenReturn(true);
        when(accounts.lockSeedPasswordHash()).thenReturn(List.of(DEV_HASH));
        when(encoder.matches(SeedAdmin.DEV_PASSWORD, DEV_HASH)).thenReturn(true);
    }

    @Test
    void a_database_error_stops_a_production_start() {
        when(state.lockForUpdate()).thenThrow(new DataAccessResourceFailureException("database went away"));

        assertThatThrownBy(() -> lock(true, true).run(new DefaultApplicationArguments()))
                .isInstanceOf(DataAccessResourceFailureException.class);
    }

    @Test
    void a_transaction_that_cannot_start_stops_a_production_start() {
        when(transactions.getTransaction(any(TransactionDefinition.class)))
                .thenThrow(new CannotCreateTransactionException("no connection"));

        assertThatThrownBy(() -> lock(true, true).run(new DefaultApplicationArguments()))
                .isInstanceOf(CannotCreateTransactionException.class);
    }

    @Test
    void a_database_error_on_a_dev_machine_is_one_warning_and_the_start_goes_on() {
        when(state.lockForUpdate()).thenThrow(new DataAccessResourceFailureException("database went away"));

        assertThatCode(() -> lock(true, false).run(new DefaultApplicationArguments()))
                .doesNotThrowAnyException();
    }

    @Test
    void a_production_run_locks_the_dev_password_even_when_the_operator_switched_the_lock_off() {
        aFreshInstallWithTheDevPassword();

        lock(false, true).run(new DefaultApplicationArguments());

        verify(accounts).disableSeedPassword();
    }

    @Test
    void a_dev_machine_can_switch_the_lock_off() {
        aFreshInstallWithTheDevPassword();

        lock(false, false).run(new DefaultApplicationArguments());

        verify(state, never()).lockForUpdate();
        verify(accounts, never()).disableSeedPassword();
    }

    @Test
    void the_lock_on_a_dev_machine_still_disables_the_dev_password() {
        aFreshInstallWithTheDevPassword();

        lock(true, false).run(new DefaultApplicationArguments());

        verify(accounts).disableSeedPassword();
    }
}
