package com.blog.common.security;

import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * Says so, loudly, when the application is running with the documented development
 * password. The alternative is an environment that quietly keeps a credential printed in a
 * public README, which is the kind of thing that stays true until someone notices.
 *
 * In production ({@link ProductionMode}) a warning is not enough: this runner throws and the backend does not start.
 * An opted-in dev machine still only gets a warning, as before. Two rows are checked: the row of {@code ADMIN_EMAIL}, and the row
 * carrying exactly {@value SeedAdmin#EMAIL}, because the seed row stays intact when AdminSeedEmail cannot rename it (the
 * email is already taken), and then it is still ADMIN with the password printed in the README. From the moment Tomcat
 * accepts connections until this runner runs, AuthService already refuses the dev password, so that gap is not open to
 * anyone.
 *
 * It verifies rather than compares hash strings: Argon2 is salted, so a re-hash of the
 * same password is a different string and a string comparison would miss it.
 *
 * Ordered AFTER {@link AdminPasswordFromEnvironment}, and the order is load-bearing: that
 * runner applies ADMIN_PASSWORD at startup, so running first would mean an instance that
 * correctly set a real password was still told it is using the development one — and, on
 * a public site, refused to start.
 */
@Component
@Order(20)
@RequiredArgsConstructor
public class DevCredentialWarning implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DevCredentialWarning.class);

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final AdminAccountProperties properties;
    private final ProductionMode productionMode;

    /**
     * @throws IllegalStateException on a public site when either row still accepts the dev password. The message names
     *                               only the variables to set, no email, no password.
     */
    @Override
    public void run(ApplicationArguments args) {
        Optional<String> stillDev = accountStillOnDevelopmentPassword();
        if (stillDev.isEmpty()) {
            return;
        }
        if (productionMode.active()) {
            throw new IllegalStateException("The admin account still accepts the development password documented in "
                    + "backend/README.md, and this is a production run (no Spring profile dev, no APP_ALLOW_DEV_DEFAULTS=true, "
                    + "or a public SITE_URL). Set ADMIN_PASSWORD (at least 12 characters) and ADMIN_EMAIL (the "
                    + "address you will sign in with), then start again.");
        }
        log.warn("================================================================");
        log.warn("{} is still using the development password documented in", stillDev.get());
        log.warn("backend/README.md. Change it before this instance is reachable");
        log.warn("from anywhere but your own machine.");
        log.warn("================================================================");
    }

    /**
     * Which account still accepts the dev password, as a label for the log and never as its address: the
     * {@code ADMIN_EMAIL} row is checked first, then the row carrying {@value SeedAdmin#EMAIL}.
     */
    private Optional<String> accountStillOnDevelopmentPassword() {
        Set<String> emails = new LinkedHashSet<>();
        String configured = properties.email();
        if (configured != null && !configured.isBlank()) {
            emails.add(configured);
        }
        emails.add(SeedAdmin.EMAIL);
        for (String email : emails) {
            String hash =
                    userRepository.findByEmail(email).map(User::getPasswordHash).orElse(null);
            // A GitHub-only account has no hash: there is no password to try.
            if (hash != null && passwordEncoder.matches(SeedAdmin.DEV_PASSWORD, hash)) {
                return Optional.of(
                        SeedAdmin.EMAIL.equals(email) ? "The seeded admin account" : "The ADMIN_EMAIL account");
            }
        }
        return Optional.empty();
    }
}
