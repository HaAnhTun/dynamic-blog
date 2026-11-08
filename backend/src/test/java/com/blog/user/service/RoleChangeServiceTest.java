package com.blog.user.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.security.SeedAdmin;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserAccess;
import com.blog.user.repository.UserRepository;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@ExtendWith(MockitoExtension.class)
class RoleChangeServiceTest {

    @Mock
    private UserRepository userRepository;

    @Mock
    private RefreshTokenRepository refreshTokenRepository;

    @InjectMocks
    private RoleChangeService service;

    private final UUID actor = UUID.randomUUID();
    private final UUID target = UUID.randomUUID();

    @BeforeEach
    void synchronization() {
        TransactionSynchronizationManager.initSynchronization();
    }

    @AfterEach
    void clear() {
        TransactionSynchronizationManager.clearSynchronization();
    }

    private void actorIs(UserRole role, UserStatus status) {
        when(userRepository.findAccessById(actor)).thenReturn(Optional.of(new UserAccess(role, status)));
    }

    @Test
    void locks_first_then_reads_anything_and_a_real_change_revokes_sessions() {
        actorIs(UserRole.ADMIN, UserStatus.ACTIVE);
        when(userRepository.findRoleById(target)).thenReturn(Optional.of(UserRole.USER));
        when(userRepository.setRoleIfCurrently(target, "AUTHOR", "USER")).thenReturn(1);

        assertThat(service.change(actor, target, UserRole.AUTHOR)).isEqualTo(UserRole.USER);

        InOrder order = inOrder(userRepository, refreshTokenRepository);
        order.verify(userRepository).lockAdminRoster();
        order.verify(userRepository).findAccessById(actor);
        order.verify(userRepository).setRoleIfCurrently(target, "AUTHOR", "USER");
        order.verify(refreshTokenRepository).revokeAllLiveForUser(any(), any());
    }

    @Test
    void caller_demoted_while_waiting_for_the_lock_is_403_and_changes_nothing() {
        actorIs(UserRole.AUTHOR, UserStatus.ACTIVE);

        assertThatThrownBy(() -> service.change(actor, target, UserRole.ADMIN))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.FORBIDDEN));
        verify(userRepository, never()).setRoleIfCurrently(any(), anyString(), anyString());
    }

    @Test
    void caller_suspended_or_gone_is_also_403() {
        actorIs(UserRole.ADMIN, UserStatus.SUSPENDED);
        assertThatThrownBy(() -> service.change(actor, target, UserRole.USER)).isInstanceOf(ApiException.class);

        when(userRepository.findAccessById(actor)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.change(actor, target, UserRole.USER)).isInstanceOf(ApiException.class);
        verify(userRepository, never()).setRoleIfCurrently(any(), anyString(), anyString());
    }

    @Test
    void only_the_site_owner_can_change_the_site_owners_role() {
        actorIs(UserRole.ADMIN, UserStatus.ACTIVE);
        when(userRepository.findRoleById(SeedAdmin.ID)).thenReturn(Optional.of(UserRole.ADMIN));

        assertThatThrownBy(() -> service.change(actor, SeedAdmin.ID, UserRole.USER))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.SITE_OWNER_PROTECTED));
        verify(userRepository, never()).setRoleIfCurrently(any(), anyString(), anyString());
    }

    @Test
    void approving_an_application_only_promotes_readers_someone_already_ADMIN_is_not_demoted() {
        actorIs(UserRole.ADMIN, UserStatus.ACTIVE);
        when(userRepository.findRoleById(target)).thenReturn(Optional.of(UserRole.ADMIN));

        assertThat(service.promoteIfReader(actor, target, UserRole.AUTHOR)).isEqualTo(UserRole.ADMIN);
        verify(userRepository, never()).setRoleIfCurrently(any(), anyString(), anyString());
        verify(refreshTokenRepository, never()).revokeAllLiveForUser(any(), any());
    }

    @Test
    void suspended_account_cannot_be_given_a_role_and_nothing_is_revoked() {
        actorIs(UserRole.ADMIN, UserStatus.ACTIVE);
        when(userRepository.findRoleById(target)).thenReturn(Optional.of(UserRole.USER));
        when(userRepository.setRoleIfCurrently(target, "AUTHOR", "USER")).thenReturn(0);
        when(userRepository.findStatusById(target)).thenReturn(Optional.of(UserStatus.SUSPENDED));

        assertThatThrownBy(() -> service.change(actor, target, UserRole.AUTHOR))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.ROLE_TARGET_SUSPENDED));
        verify(refreshTokenRepository, never()).revokeAllLiveForUser(any(), any());
    }
}
