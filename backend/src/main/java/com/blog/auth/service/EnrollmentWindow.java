package com.blog.auth.service;

import com.blog.common.security.ProductionMode;
import com.blog.user.repository.UserRepository;
import java.time.Clock;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * Whether an account may start its two-step enrollment WITHOUT the operator's enrollment code (the classic enrollment
 * hijack is a stranger who holds only the password enrolling an authenticator of their own first).
 *
 * The window is open when
 * <ul>
 *   <li>the run is not production ({@link ProductionMode#active()} is false: the {@code dev} profile or
 *       {@code APP_ALLOW_DEV_DEFAULTS=true} with an empty or loopback {@code SITE_URL}), which is what lets a throw-away E2E
 *       stack enrol without ceremony; a plain install, even one on {@code localhost}, is production; or</li>
 *   <li>{@code users.mfa_enrollment_open_until} is in the future: the first-run setup sets it to one hour after the owner
 *       proved the setup code, and a confirmed enrollment clears it.</li>
 * </ul>
 * Nothing a caller sends can open it.
 */
@Component
@RequiredArgsConstructor
public class EnrollmentWindow {

    private final ProductionMode productionMode;
    private final UserRepository userRepository;
    private final Clock clock;

    public boolean isOpen(UUID userId) {
        if (!productionMode.active()) {
            return true;
        }
        return userRepository
                .findEnrollmentOpenUntil(userId)
                .map(until -> until.isAfter(clock.instant()))
                .orElse(false);
    }
}
