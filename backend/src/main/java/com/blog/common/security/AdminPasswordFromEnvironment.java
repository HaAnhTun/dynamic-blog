package com.blog.common.security;

import com.blog.auth.service.MfaService;
import com.blog.auth.service.RefreshTokenService;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.time.Instant;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Sets the admin password from {@code ADMIN_PASSWORD} when that variable is present.
 *
 * Until this existed, the only way to change the seeded development password was to write
 * a migration containing a hash, which means a deployment either ships the credential
 * documented in a public README or carries a secret in version control. Neither is
 * acceptable for an instance reachable from the internet, and the spec asks for secrets to
 * come from the environment.
 *
 * <h2>Why a startup runner and not a migration</h2>
 *
 * A migration would have to contain the hash, so the secret would live in the repository.
 * Hashing at startup keeps the plaintext in the process environment and the hash in the
 * database, and nothing in between. The cost is that the password is applied on boot
 * rather than on deploy, which for a single-instance Docker Compose deployment is the same
 * moment.
 *
 * <h2>Idempotent, and quiet when there is nothing to do</h2>
 *
 * It verifies the existing hash against the supplied password first and returns if they
 * already match. Argon2 is salted, so re-encoding the same password produces a different
 * string every time — writing unconditionally would mean a database write and a new salt
 * on every single restart, and a log line claiming a change that did not happen.
 *
 * <h2>A real change ends every session</h2>
 *
 * When the configured password does NOT match the stored hash, i.e. the password really changed, every live refresh
 * token of that account is revoked in the same transaction as the hash write: if the site owner changes ADMIN_PASSWORD
 * because they suspect a leak, the session of someone who logged in with the old password does not live on through a
 * 30-day refresh token. Restarting with that same password stops at the check above, so the hash is not rewritten and
 * nobody is signed out. Access tokens already issued (JWTs, not stored) remain usable until they expire, at most 15
 * minutes.
 *
 * The shared {@link PasswordPolicy} (not on the common list, not built around the email, not the development password)
 * applies to a value that is really about to be applied, after the "already correct" check: a changed value that fails
 * it stops the start; an unchanged one that the policy now rejects only gets a WARN, so an existing install does not
 * refuse to start on upgrade.
 *
 * Ordered after {@link DevCredentialWarning} would be wrong: the warning must see the
 * password this runner leaves behind, or an instance that correctly set ADMIN_PASSWORD
 * would still be told it is using the development one. Hence {@code @Order} here and on
 * the warning, with this running first.
 *
 * {@link AdminSeedEmail} ({@code @Order(5)}) runs before this runner: when {@code ADMIN_EMAIL} differs from the
 * default, the seeded admin row already carries that address by the time this runner looks for it.
 */
@Component
@Order(10)
@RequiredArgsConstructor
public class AdminPasswordFromEnvironment implements ApplicationRunner {

    /**
     * Argon2 encodes its own parameters into the hash, so there is no minimum this class
     * needs to enforce for correctness. This floor exists for the operator: a deployment
     * that sets ADMIN_PASSWORD=x has almost certainly made a mistake, and failing loudly at
     * boot is better than silently accepting a one-character password on a public instance.
     */
    static final int MINIMUM_LENGTH = 12;

    private static final Logger log = LoggerFactory.getLogger(AdminPasswordFromEnvironment.class);

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final AdminAccountProperties properties;
    private final RefreshTokenService refreshTokenService;
    private final PasswordPolicy passwordPolicy;
    private final MfaService mfaService;

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        String password = properties.password();
        if (password == null || password.isBlank()) {
            // The ordinary development case. DevCredentialWarning handles saying so, and on a
            // public site (ProductionMode) refuses to start while the dev password still works.
            return;
        }

        if (password.length() < MINIMUM_LENGTH) {
            throw new IllegalStateException("ADMIN_PASSWORD is set but shorter than " + MINIMUM_LENGTH + " characters. "
                    + "Refusing to start rather than accept it: an instance that reaches "
                    + "this code is being deployed deliberately.");
        }

        User admin = userRepository.findByEmail(properties.email()).orElse(null);
        if (admin == null) {
            // Not fatal. The seed migration creates this account, so its absence means
            // somebody has deliberately removed it, and refusing to boot over a password
            // for a user who does not exist would be the wrong failure.
            // No address in the log (docs/SECURITY.md): the setting is named, the value is not.
            log.warn("ADMIN_PASSWORD is set but no user with the configured ADMIN_EMAIL exists; nothing to apply.");
            return;
        }

        if (passwordEncoder.matches(password, admin.getPasswordHash())) {
            // Already correct. Say nothing: a line on every restart saying "no change" is
            // noise that trains an operator to skip the startup log. The one exception is a password the policy of
            // this release would refuse (PasswordPolicy): it keeps working, because refusing to start would lock an
            // existing install out on upgrade, but the operator is told once per start, without the value.
            passwordPolicy
                    .check(password, properties.email())
                    .ifPresent(violation -> log.warn(
                            "ADMIN_PASSWORD is unchanged and still accepted, but it does not meet the password policy"
                                    + " of this release ({}). Set a new value.",
                            violation));
            return;
        }

        // The value is about to be applied: only now does the policy refuse (a changed value that fails it fails the
        // start, like the length check above). The message names the rule, never the value.
        passwordPolicy.check(password, properties.email()).ifPresent(violation -> {
            throw new IllegalStateException("ADMIN_PASSWORD is set to a new value that does not meet the password "
                    + "policy (" + violation + "). Refusing to start rather than apply it.");
        });

        admin.setPasswordHash(passwordEncoder.encode(password));
        userRepository.save(admin);
        // The password really just changed: every open session of this account, including that of someone who knew the
        // old password, dies at the next refresh; every access token already held is rejected at once
        // (tokens_valid_after). Same
        // transaction as the hash write. A restart with that same password already stopped above, so nobody is signed
        // out.
        Instant now = Instant.now();
        int revoked = refreshTokenService.revokeAllSessions(admin.getId(), now);
        // A real change is also the owner's answer to a second step that someone keeps locked or has frozen: the
        // counters
        // and the lock of the account go with the sessions and the pending challenges.
        mfaService.clearSecondStepLock(admin.getId());
        // The value is never logged, here or anywhere. A startup log is the one place a
        // credential survives log rotation and ends up in a support ticket.
        log.info("Applied ADMIN_PASSWORD to userId={}; {} refresh token(s) revoked.", admin.getId(), revoked);
    }
}
