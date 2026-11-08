package com.blog.auth.service;

import com.blog.auth.repository.MfaRepository;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * Who needs a second factor: every ADMIN, and an AUTHOR once they have a confirmed enrollment (optional for an AUTHOR,
 * enforced like for an ADMIN from then on). Readers (USER) have no second step.
 *
 * It reads the enrollment, so it is asked at the moments that matter: the first-factor gate and the refresh rotation. It
 * is deliberately not asked on every request (CurrentAccessJwtConverter has no MFA join): the proof is a property of the
 * session, checked when the session is created and each time it rotates.
 */
@Component
@RequiredArgsConstructor
public class MfaPolicy {

    private final MfaRepository mfaRepository;

    public boolean required(User user) {
        return required(user.getRole(), user.getId());
    }

    public boolean required(UserRole role, UUID userId) {
        return role == UserRole.ADMIN || (role == UserRole.AUTHOR && enrolled(userId));
    }

    /** Whether the account has a confirmed enrollment (an abandoned, still PENDING one does not count). */
    public boolean enrolled(UUID userId) {
        return mfaRepository.existsActive(userId);
    }
}
