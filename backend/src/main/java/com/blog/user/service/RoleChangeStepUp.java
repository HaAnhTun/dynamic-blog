package com.blog.user.service;

import com.blog.auth.service.MfaService;
import com.blog.auth.service.RecentAuthentication;
import com.blog.common.exception.ApiException;
import com.blog.user.entity.UserRole;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * The second proof a role change wants (audit 111). Granting or taking away a privileged role is what a stolen administrator
 * session would use to leave a durable foothold (a new administrator, a new author), so, like the other changes that could turn a
 * stolen session into a takeover (the password, the authenticator, the reset of an author), it needs a sign-in from the last
 * minutes AND the acting administrator's own code. The change is a step-up when it is to or from ADMIN, or makes a reader an
 * AUTHOR; taking an author back to a reader needs none.
 *
 * The caller asks it with the role the target has NOW, read under the roster lock that every role change takes, so the answer cannot
 * be outdated by another change. The order is the one of every step-up: the recent sign-in first, before any code is looked at or
 * counted, then the code (through the same reserve-then-verify as every other second-step check, so the same per-account brakes
 * apply). A refusal of the code is an {@code MfaRejection}: the transaction of the caller must list it in {@code noRollbackFor}, or
 * the failed attempt is not counted.
 */
@Component
@RequiredArgsConstructor
public class RoleChangeStepUp {

    private final RecentAuthentication recentAuthentication;
    private final MfaService mfaService;

    /** Whether a change of role from {@code from} to {@code to} wants the proof. A change to the role the account has wants none. */
    public static boolean required(UserRole from, UserRole to) {
        if (from == to) {
            return false;
        }
        return from == UserRole.ADMIN || to == UserRole.ADMIN || (from == UserRole.USER && to == UserRole.AUTHOR);
    }

    /**
     * @param code what the administrator typed: an authenticator code or a recovery code; missing counts as a wrong code, without
     *             being counted against the account (nothing was guessed)
     * @throws ApiException 401 {@code REAUTHENTICATION_REQUIRED} when the session started too long ago; 401
     *                      {@code MFA_CODE_INVALID}, 429 {@code MFA_RATE_LIMITED}, 403 {@code MFA_FROZEN} (all {@code MfaRejection})
     */
    public void require(UUID actorId, UserRole from, UserRole to, String code) {
        if (!required(from, to)) {
            return;
        }
        recentAuthentication.require();
        mfaService.requireActorCode(actorId, code);
    }
}
