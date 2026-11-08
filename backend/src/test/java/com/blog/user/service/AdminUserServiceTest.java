package com.blog.user.service;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verifyNoInteractions;

import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.search.sync.SearchOutbox;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;

/** Rate limit of the role-change path. The bucket and its numbers live in RateLimiterTest, RateLimitConfigTest. */
@ExtendWith(MockitoExtension.class)
class AdminUserServiceTest {

    @Mock
    private UserRepository userRepository;

    @Mock
    private RefreshTokenRepository refreshTokenRepository;

    @Mock
    private RoleChangeService roleChangeService;

    @Mock
    private RoleChangeStepUp stepUp;

    @Mock
    private RateLimiter rateLimiter;
    // A change writes the search outbox; without this mock @InjectMocks would pass null. The write rule is checked on a
    // real DB and
    // Meilisearch in SearchOutboxIT.
    @Mock
    private SearchOutbox searchOutbox;

    @InjectMocks
    private AdminUserService adminUserService;

    @Test
    void role_change_counts_in_calling_admins_role_change_bucket_and_is_blocked_before_touching_any_account() {
        UUID actor = UUID.randomUUID();
        UUID target = UUID.randomUUID();
        // Stubbed by the calling admin only: if the service counts by the person being changed, the test breaks.
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "Too many requests"))
                .when(rateLimiter)
                .check(RateLimiter.ROLE_CHANGE, actor);

        assertThatThrownBy(() -> adminUserService.setRole(actor, target, UserRole.ADMIN, "123456"))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED);
        verifyNoInteractions(roleChangeService, userRepository, refreshTokenRepository, stepUp);
    }
}
