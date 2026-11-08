package com.blog.author.service;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.author.dto.AuthorApplicationRequest;
import com.blog.author.repository.AuthorApplicationRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.CurrentUserService;
import com.blog.user.service.RoleChangeService;
import com.blog.user.service.RoleChangeStepUp;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;

/**
 * Rate limits for author applications: submitting is counted per applicant, approving is counted in the admin's role-change bucket,
 * and both are blocked before any SQL statement. The buckets and their numbers live in RateLimiterTest, RateLimitConfigTest.
 */
@ExtendWith(MockitoExtension.class)
class AuthorApplicationServiceTest {

    @Mock
    private AuthorApplicationRepository applicationRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private CurrentUserService currentUserService;

    @Mock
    private RoleChangeService roleChangeService;

    @Mock
    private RoleChangeStepUp stepUp;

    @Mock
    private RateLimiter rateLimiter;

    @InjectMocks
    private AuthorApplicationService service;

    @Test
    void submission_counts_in_applicants_author_application_bucket_and_is_blocked_before_any_sql() {
        UUID applicant = UUID.randomUUID();
        when(currentUserService.requireActive()).thenReturn(applicant);
        // Stubbed by applicant only: if the service counts by anyone else, the test breaks.
        doThrow(rateLimited()).when(rateLimiter).check(RateLimiter.AUTHOR_APPLICATION, applicant);

        assertThatThrownBy(() -> service.submit(new AuthorApplicationRequest("Wants to write about Postgres")))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED);
        verifyNoInteractions(applicationRepository, userRepository, roleChangeService);
    }

    @Test
    void approval_counts_in_admins_role_change_bucket_and_is_blocked_before_touching_any_application_or_role() {
        UUID actor = UUID.randomUUID();
        doThrow(rateLimited()).when(rateLimiter).check(RateLimiter.ROLE_CHANGE, actor);

        assertThatThrownBy(() -> service.approve(actor, UUID.randomUUID(), "123456"))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED);
        verifyNoInteractions(applicationRepository, userRepository, roleChangeService, stepUp);
    }

    private static ApiException rateLimited() {
        return new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "Too many requests");
    }
}
