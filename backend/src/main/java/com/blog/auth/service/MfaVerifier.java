package com.blog.auth.service;

import com.blog.auth.entity.MfaStatus;
import com.blog.auth.entity.UserMfa;
import com.blog.auth.mfa.MfaSecretCipher;
import com.blog.auth.mfa.MfaSecretCipher.Purpose;
import com.blog.auth.mfa.MfaSecretCipher.UndecryptableException;
import com.blog.auth.mfa.RecoveryCodes;
import com.blog.auth.mfa.RecoveryCodes.Shape;
import com.blog.auth.mfa.Totp;
import com.blog.auth.repository.MfaChallengeRepository;
import com.blog.auth.repository.MfaRecoveryCodeRepository;
import com.blog.auth.repository.MfaRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.user.repository.UserRepository;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Every check of a second-step code goes through here: the login step, the enrollment confirmation, the replacement of an
 * authenticator, every step-up of the signed-in endpoints and the password change. One implementation of reserve-then-verify,
 * so there is exactly one place that decides how many codes an attacker who holds the password may try.
 *
 * <h2>The sequence, in the caller's transaction</h2>
 * <ol>
 *   <li>Lock the account row, then its {@code user_mfa} row ({@code FOR UPDATE}, with {@code lock_timeout} of two seconds:
 *       a timeout answers 429 and evaluates nothing). This serialises every check of the account across challenges and
 *       across backend instances; without it, fifty parallel requests could all read "not locked" before any of them
 *       counted. The lock order is always {@code users}, {@code user_mfa}, {@code mfa_challenge}.</li>
 *   <li>100 or more consecutive failures: 403 {@code MFA_FROZEN}, nothing evaluated.</li>
 *   <li>A lock running: 429 {@code MFA_RATE_LIMITED}, nothing evaluated, no attempt reserved, no counter touched. A correct
 *       code is refused too, otherwise the delay would be no brake.</li>
 *   <li>With a challenge: reserve one of its five attempts with one conditional UPDATE that also repeats the expiry, the
 *       consumption and the account's token cut-off. Zero rows is {@code MFA_CHALLENGE_INVALID}.</li>
 *   <li>Only now evaluate the code.</li>
 *   <li>Write the outcome before commit. A failure counts, sets the next lock and consumes an exhausted challenge, and the
 *       transaction commits with the error ({@link MfaRejection}). A success moves the replay guard (or redeems the recovery
 *       code), clears the counters and, for a challenge, consumes all of the account's challenges.</li>
 * </ol>
 * The caller must be in a transaction that lists {@link MfaRejection} in {@code noRollbackFor}.
 *
 * Nothing here logs a code, a secret, a challenge or an email: only the user id and a coarse reason, and a code that matched
 * outside the window is still refused.
 */
@Component
@RequiredArgsConstructor
public class MfaVerifier {

    /** Which secret the code is checked against. */
    public enum Target {
        /** The active secret, or a recovery code: the login step and every step-up of an enrolled account. */
        LOGIN,
        /** The secret of an enrollment that is still PENDING: its first code activates it. */
        ENROLLMENT,
        /** The replacement secret waiting next to the active one. It has never accepted a code, so no replay comparison. */
        REPLACEMENT
    }

    public enum Method {
        TOTP,
        RECOVERY
    }

    /**
     * @param step         the 30-second step of an accepted authenticator code; 0 for a recovery code
     * @param pendingRead  for {@link Target#REPLACEMENT}, the exact pending ciphertext the code was checked against, so the
     *                     swap can be conditional on it; null otherwise
     */
    public record Verified(Method method, long step, byte[] pendingRead) {}

    private static final Logger log = LoggerFactory.getLogger(MfaVerifier.class);

    private final MfaRepository mfaRepository;
    private final MfaRecoveryCodeRepository recoveryRepository;
    private final MfaChallengeRepository challengeRepository;
    private final UserRepository userRepository;
    private final MfaSecretCipher cipher;
    private final Totp totp;
    private final JdbcTemplate jdbcTemplate;
    private final Clock clock;

    /**
     * @param challengeHash the SHA-256 of the sign-in challenge, or null for a step-up of a signed-in person
     * @param input         what the person typed: an authenticator code, or a recovery code (target {@code LOGIN} only)
     * @throws MfaRejection {@code MFA_CHALLENGE_INVALID}, {@code MFA_CODE_INVALID}, {@code MFA_RATE_LIMITED},
     *                      {@code MFA_FROZEN}
     * @throws MfaBusy      when another check of the account holds the lock for more than two seconds
     */
    @Transactional(propagation = Propagation.MANDATORY, noRollbackFor = MfaRejection.class)
    public Verified check(UUID userId, String challengeHash, String input, Target target) {
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        UserMfa row = lock(userId, challengeHash, target);

        MfaLockout.State state = MfaLockout.stateOf(row.getFailedAttempts(), row.getLockedUntil(), now);
        if (state == MfaLockout.State.FROZEN) {
            log.warn("mfa verify failed userId={} reason=frozen", userId);
            throw MfaRejection.frozen();
        }
        if (state == MfaLockout.State.LOCKED) {
            log.warn("mfa verify failed userId={} reason=locked", userId);
            throw MfaRejection.rateLimited(MfaLockout.secondsLeft(row.getLockedUntil(), now));
        }
        if (challengeHash != null
                && challengeRepository.reserveAttempt(challengeHash, now, MfaChallengeService.MAX_ATTEMPTS) == 0) {
            logChallengeRefused(userId, challengeHash);
            throw MfaRejection.challengeInvalid();
        }

        Evaluation evaluation = evaluate(row, input, target, now);
        if (!evaluation.accepted()) {
            throw recordFailure(row, challengeHash, evaluation.reason(), now);
        }
        recordSuccess(row, challengeHash, evaluation, target, now);
        return new Verified(
                evaluation.method(),
                evaluation.step(),
                target == Target.REPLACEMENT ? row.getPendingSecretCipher() : null);
    }

    /**
     * {@link #check} for a step-up of a signed-in person (no challenge), which also records that it passed: one line with
     * the user id, what the code was for and the method, never the code. Without it the only trace of a correct step-up was
     * the event it allowed, and a refusal of the event hid whether the code had been right.
     *
     * @param purpose a stable word for the log: {@code enroll_confirm}, {@code recovery_codes}, {@code replace_begin},
     *                {@code replace_confirm}, {@code disable}, {@code reset_author}, {@code password_change}
     */
    @Transactional(propagation = Propagation.MANDATORY, noRollbackFor = MfaRejection.class)
    public Verified stepUp(UUID userId, String input, Target target, String purpose) {
        Verified verified = check(userId, null, input, target);
        log.info(
                "mfa step-up ok userId={} purpose={} method={}",
                userId,
                purpose,
                verified.method() == Method.RECOVERY ? "recovery" : "totp");
        return verified;
    }

    // --- The lock ---------------------------------------------------------------------------------------------

    private UserMfa lock(UUID userId, String challengeHash, Target target) {
        Optional<UserMfa> row;
        try {
            jdbcTemplate.execute("SET LOCAL lock_timeout = '2s'");
            if (userRepository.lockById(userId).isEmpty()) {
                throw refusedState(challengeHash, target);
            }
            row = mfaRepository.lockByUserId(userId);
            jdbcTemplate.execute("SET LOCAL lock_timeout = 0");
        } catch (PessimisticLockingFailureException e) {
            throw new MfaBusy();
        }
        if (row.isEmpty()) {
            throw refusedState(challengeHash, target);
        }
        UserMfa locked = row.get();
        boolean usable = switch (target) {
            case LOGIN -> locked.getStatus() == MfaStatus.ACTIVE;
            case ENROLLMENT -> locked.getStatus() == MfaStatus.PENDING;
            case REPLACEMENT -> locked.getStatus() == MfaStatus.ACTIVE && locked.getPendingSecretCipher() != null;
        };
        if (!usable) {
            throw refusedState(challengeHash, target);
        }
        return locked;
    }

    /**
     * The enrollment this check was about is not there (any more). A sign-in step says so with the one challenge answer; a
     * step-up of a signed-in person, which has no challenge, says what is missing.
     */
    private static RuntimeException refusedState(String challengeHash, Target target) {
        if (challengeHash != null) {
            return MfaRejection.challengeInvalid();
        }
        return new ApiException(
                ErrorCode.RESOURCE_CONFLICT,
                HttpStatus.CONFLICT,
                switch (target) {
                    case LOGIN -> "Two-step verification is not turned on";
                    case ENROLLMENT -> "No enrollment is waiting to be confirmed";
                    case REPLACEMENT -> "No new authenticator is waiting to be confirmed";
                });
    }

    // --- The evaluation ---------------------------------------------------------------------------------------

    private record Evaluation(boolean accepted, Method method, long step, String reason) {
        static Evaluation accepted(Method method, long step) {
            return new Evaluation(true, method, step, null);
        }

        static Evaluation refused(String reason) {
            return new Evaluation(false, null, 0, reason);
        }
    }

    private Evaluation evaluate(UserMfa row, String input, Target target, Instant now) {
        Shape shape = RecoveryCodes.shapeOf(input);
        if (shape == Shape.RECOVERY && target == Target.LOGIN) {
            String hash = RecoveryCodes.hash(RecoveryCodes.normalise(input));
            return recoveryRepository.redeem(row.getUserId(), hash, now) == 1
                    ? Evaluation.accepted(Method.RECOVERY, 0)
                    : Evaluation.refused("bad_code");
        }
        if (shape != Shape.TOTP) {
            // Wrong shape (or a recovery code where only a new authenticator's code makes sense): a wrong code, which
            // still counts, so a malformed input is not a cheaper oracle.
            return Evaluation.refused("bad_code");
        }
        byte[] secret;
        try {
            secret = secretOf(row, target);
        } catch (UndecryptableException e) {
            log.error("mfa secret undecryptable userId={}", row.getUserId());
            return Evaluation.refused("bad_code");
        }
        long currentStep = Totp.stepOf(now);
        Totp.Result result = totp.check(secret, RecoveryCodes.totpDigits(input), currentStep);
        if (result.matchedStep().isEmpty()) {
            result.skewSteps()
                    .ifPresent(offset -> log.warn(
                            "mfa code matched outside window userId={} offsetSteps={}", row.getUserId(), offset));
            return Evaluation.refused("bad_code");
        }
        long matched = result.matchedStep().getAsLong();
        // Replay protection (RFC 6238 5.2): a code is accepted only for a step greater than the last accepted one. The
        // replacement secret has never accepted a code, so it has nothing to be replayed against.
        if (target != Target.REPLACEMENT && matched <= row.getLastUsedStep()) {
            return Evaluation.refused("replay");
        }
        return Evaluation.accepted(Method.TOTP, matched);
    }

    private byte[] secretOf(UserMfa row, Target target) {
        if (target == Target.REPLACEMENT) {
            requireKey(row.getPendingKeyId());
            return cipher.decrypt(row.getUserId(), Purpose.PENDING, row.getPendingSecretCipher());
        }
        requireKey(row.getKeyId());
        return cipher.decrypt(row.getUserId(), Purpose.ACTIVE, row.getSecretCipher());
    }

    /** A row written with another key (the key was changed, or the id was damaged) is unreadable, not a server error. */
    private void requireKey(Short storedKeyId) {
        if (storedKeyId == null || storedKeyId != cipher.keyId()) {
            throw new UndecryptableException();
        }
    }

    // --- The outcome ------------------------------------------------------------------------------------------

    private MfaRejection recordFailure(UserMfa row, String challengeHash, String reason, Instant now) {
        UUID userId = row.getUserId();
        MfaLockout.Failure failure = MfaLockout.afterFailure(row.getFailedAttempts(), now);
        mfaRepository.recordFailure(userId, failure.lockedUntil(), now);
        if (challengeHash != null) {
            challengeRepository.consumeIfExhausted(challengeHash, now, MfaChallengeService.MAX_ATTEMPTS);
        }
        log.warn("mfa verify failed userId={} reason={}", userId, reason);
        if (failure.frozenNow()) {
            log.error("mfa second step frozen userId={}", userId);
        }
        return MfaRejection.codeInvalid();
    }

    private void recordSuccess(UserMfa row, String challengeHash, Evaluation evaluation, Target target, Instant now) {
        UUID userId = row.getUserId();
        int written = switch (target) {
            case LOGIN ->
                evaluation.method() == Method.RECOVERY
                        ? mfaRepository.recordRecoveryAccepted(userId, now)
                        : mfaRepository.recordCodeAccepted(userId, evaluation.step(), now);
            case ENROLLMENT -> mfaRepository.activate(userId, evaluation.step(), now);
            // The caller's conditional swap writes the new counters and the step.
            case REPLACEMENT -> 1;
        };
        if (written != 1) {
            // The conditional write is the proof: the row has moved since it was read under the lock. Cannot happen
            // while
            // the lock holds; if it does, nothing was accepted.
            throw recordFailure(row, challengeHash, "replay", now);
        }
        if (challengeHash != null) {
            challengeRepository.consumeAllForUser(userId, now);
        }
    }

    private void logChallengeRefused(UUID userId, String challengeHash) {
        boolean exhausted = challengeRepository
                .findByTokenHash(challengeHash)
                .map(c -> c.getAttempts() >= MfaChallengeService.MAX_ATTEMPTS)
                .orElse(false);
        if (exhausted) {
            log.warn("mfa verify failed userId={} reason=challenge_exhausted", userId);
        } else {
            log.warn("mfa challenge rejected reason=unknown_or_expired");
        }
    }
}
