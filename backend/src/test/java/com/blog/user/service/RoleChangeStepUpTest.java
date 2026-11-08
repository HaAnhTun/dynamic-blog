package com.blog.user.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

import com.blog.auth.service.MfaRejection;
import com.blog.auth.service.MfaService;
import com.blog.auth.service.RecentAuthentication;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.user.entity.UserRole;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.mockito.InOrder;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;

/** Which role changes want the second proof (audit 111), and in which order the proofs are looked at. */
@ExtendWith(MockitoExtension.class)
class RoleChangeStepUpTest {

    private static final UUID ACTOR = UUID.randomUUID();

    @Mock
    private RecentAuthentication recentAuthentication;

    @Mock
    private MfaService mfaService;

    @InjectMocks
    private RoleChangeStepUp stepUp;

    @ParameterizedTest(name = "{0} to {1}: {2}")
    @CsvSource({
        "USER,AUTHOR,true",
        "USER,ADMIN,true",
        "AUTHOR,ADMIN,true",
        "ADMIN,AUTHOR,true",
        "ADMIN,USER,true",
        // Taking privilege from a non-admin needs nothing, and a change to the role the account has is no change.
        "AUTHOR,USER,false",
        "USER,USER,false",
        "AUTHOR,AUTHOR,false",
        "ADMIN,ADMIN,false"
    })
    void a_change_to_or_from_admin_or_a_reader_becoming_an_author_is_a_step_up(
            UserRole from, UserRole to, boolean needed) {
        assertThat(RoleChangeStepUp.required(from, to)).isEqualTo(needed);
    }

    @Test
    void the_recent_sign_in_is_checked_before_the_code_is_looked_at() {
        stepUp.require(ACTOR, UserRole.USER, UserRole.AUTHOR, "123456");

        InOrder order = inOrder(recentAuthentication, mfaService);
        order.verify(recentAuthentication).require();
        order.verify(mfaService).requireActorCode(ACTOR, "123456");
    }

    @Test
    void an_old_sign_in_stops_everything_before_the_code_is_looked_at_or_counted() {
        doThrow(new ApiException(ErrorCode.REAUTHENTICATION_REQUIRED, HttpStatus.UNAUTHORIZED, "Sign in again"))
                .when(recentAuthentication)
                .require();

        assertThatThrownBy(() -> stepUp.require(ACTOR, UserRole.AUTHOR, UserRole.ADMIN, "123456"))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.REAUTHENTICATION_REQUIRED);
        verifyNoInteractions(mfaService);
    }

    @Test
    void a_refused_code_reaches_the_caller_as_the_rejection_that_must_commit() {
        doThrow(MfaRejection.codeInvalid()).when(mfaService).requireActorCode(ACTOR, "000000");

        assertThatThrownBy(() -> stepUp.require(ACTOR, UserRole.USER, UserRole.AUTHOR, "000000"))
                .isInstanceOf(MfaRejection.class)
                .hasFieldOrPropertyWithValue("code", ErrorCode.MFA_CODE_INVALID);
        verify(recentAuthentication).require();
    }

    @Test
    void a_change_that_needs_nothing_asks_for_nothing() {
        stepUp.require(ACTOR, UserRole.AUTHOR, UserRole.USER, null);
        stepUp.require(ACTOR, UserRole.ADMIN, UserRole.ADMIN, null);

        verifyNoInteractions(recentAuthentication, mfaService);
    }
}
