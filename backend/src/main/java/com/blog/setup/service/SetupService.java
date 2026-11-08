package com.blog.setup.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.security.PasswordPolicy;
import com.blog.common.security.SeedAdmin;
import com.blog.common.text.UserText;
import com.blog.setup.dto.SetupCompletedResponse;
import com.blog.setup.dto.SetupRequest;
import com.blog.setup.dto.SetupStatusResponse;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validator;
import java.util.Comparator;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * First-run setup: the first person who proves control of the server (the setup code) becomes the site owner, once.
 *
 * The order of the checks is the security of this endpoint:
 * <ol>
 *   <li>the rate limit of this client address, before anything else, counting EVERY attempt, a correct code included (so
 *       one caller cannot use up the quota of everyone, and an address that has used its own is refused even with the
 *       right code);</li>
 *   <li>a plain read of the completion flag, without a transaction or a lock: completion is permanent, so a finished
 *       instance answers 404 {@code SETUP_CLOSED} at once, however many requests arrive (issue 033: each locked
 *       transaction holds a database connection and waits its turn behind the others);</li>
 *   <li>the setup lock and the {@code app_settings} row ({@link SetupState}): parallel requests run one at a time, so
 *       exactly one can claim; the flag is read again under the lock, and once completed every request gets 404
 *       {@code SETUP_CLOSED}, a replayed code included;</li>
 *   <li>the code, compared in constant time: 403 {@code SETUP_CODE_INVALID}, one answer for every wrong or missing
 *       code. Only a WRONG code is then counted against the whole process (once the ceiling of wrong codes is passed the
 *       answer is 429 instead of 403); a right code never is. So a crowd that keeps the process-wide count full can no
 *       longer keep the real owner from claiming (issue 033). The price is that guesses are bounded per client address,
 *       not for the whole process: that is safe for the generated code (256 bits) and for a {@code SETUP_TOKEN} of the
 *       length the documentation asks for;</li>
 *   <li>only then the form, the password policy ({@link PasswordPolicy}: length, common passwords, the email local part)
 *       and the email uniqueness (400 {@code VALIDATION_ERROR}), so nobody without the code learns which accounts
 *       exist.</li>
 * </ol>
 * The claim, the end of the seed row's sessions (refresh tokens and access tokens) and the completion are one
 * transaction; the code file is deleted after the commit. Nothing here logs or returns the code, the password or the
 * email.
 */
@Service
public class SetupService {

    private static final Logger log = LoggerFactory.getLogger(SetupService.class);

    private final RateLimiter rateLimiter;
    private final SetupState state;
    private final SetupCodeStore codeStore;
    private final SetupAccounts accounts;
    private final PasswordEncoder passwordEncoder;
    private final PasswordPolicy passwordPolicy;
    private final Validator validator;
    private final TransactionTemplate transactionTemplate;

    public SetupService(
            RateLimiter rateLimiter,
            SetupState state,
            SetupCodeStore codeStore,
            SetupAccounts accounts,
            PasswordEncoder passwordEncoder,
            PasswordPolicy passwordPolicy,
            Validator validator,
            PlatformTransactionManager transactionManager) {
        this.rateLimiter = rateLimiter;
        this.state = state;
        this.codeStore = codeStore;
        this.accounts = accounts;
        this.passwordEncoder = passwordEncoder;
        this.passwordPolicy = passwordPolicy;
        this.validator = validator;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    public SetupStatusResponse status() {
        return new SetupStatusResponse(state.isRequired());
    }

    /**
     * @param request the form; null is treated like an empty form (wrong code)
     * @param client  where the request comes from (ClientAddressResolver)
     * @throws ApiException 429 {@code RATE_LIMITED} (this client address, or too many wrong codes for the whole process);
     *                      404 {@code SETUP_CLOSED}; 403 {@code SETUP_CODE_INVALID};
     *                      400 {@code VALIDATION_ERROR} (a field, or the email belongs to another account)
     */
    public SetupCompletedResponse complete(SetupRequest request, ClientAddress client) {
        // Outside the transaction: a flood of attempts from one address is refused without taking a database
        // connection.
        rateLimiter.check(RateLimiter.SETUP_CLIENT, client.key());
        if (!state.isRequired()) {
            throw closed();
        }
        SetupRequest form = request != null ? request : new SetupRequest(null, null, null, null, null);
        UUID owner;
        try {
            owner = transactionTemplate.execute(status -> claim(form));
        } catch (ApiException e) {
            if (e.getCode() == ErrorCode.SETUP_CODE_INVALID) {
                // After the transaction has rolled back and the compare has failed: only now does the attempt use a
                // turn
                // of the process-wide count of wrong codes, which answers 429 once it is full.
                rateLimiter.check(RateLimiter.SETUP, RateLimiter.SETUP_GLOBAL_KEY);
            }
            throw e;
        }
        codeStore.discard();
        log.info("first-run setup completed: the site owner account {} was claimed", owner);
        return new SetupCompletedResponse(true);
    }

    private UUID claim(SetupRequest form) {
        if (!state.lockForUpdate()) {
            throw closed();
        }
        if (!codeStore.matches(form.setupCode())) {
            throw new ApiException(ErrorCode.SETUP_CODE_INVALID, HttpStatus.FORBIDDEN, "The setup code is not valid");
        }
        validate(form);
        passwordPolicy.require("password", form.password(), form.email(), null);
        String displayName = UserText.cleanName(form.displayName());
        if (displayName.isEmpty()) {
            throw invalid("displayName: must not be blank");
        }
        if (accounts.emailTakenByAnother(form.email(), SeedAdmin.ID)) {
            throw invalid("email: already belongs to another account");
        }
        UUID owner = accounts.claimOwner(form.email(), passwordEncoder.encode(form.password()), displayName);
        accounts.endAllSessions(owner);
        accounts.openMfaEnrollmentWindow(owner);
        state.markCompleted();
        return owner;
    }

    /** The first violation, in a stable order (field name, then message); the message never contains the value. */
    private void validate(SetupRequest form) {
        validator.validate(form).stream()
                .min(Comparator.comparing((ConstraintViolation<SetupRequest> v) ->
                                v.getPropertyPath().toString())
                        .thenComparing(ConstraintViolation::getMessage))
                .ifPresent(v -> {
                    throw invalid(v.getPropertyPath() + ": " + v.getMessage());
                });
    }

    private static ApiException closed() {
        return new ApiException(ErrorCode.SETUP_CLOSED, HttpStatus.NOT_FOUND, "Setup is not available");
    }

    private static ApiException invalid(String message) {
        return new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, message);
    }
}
