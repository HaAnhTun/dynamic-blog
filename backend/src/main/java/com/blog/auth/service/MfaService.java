package com.blog.auth.service;

import com.blog.auth.dto.MfaEnrollmentConfirmedResponse;
import com.blog.auth.dto.MfaEnrollmentSecretResponse;
import com.blog.auth.dto.MfaRecoveryCodesResponse;
import com.blog.auth.dto.MfaStatusResponse;
import com.blog.auth.dto.MfaVerifiedResponse;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.entity.ChallengePurpose;
import com.blog.auth.entity.MfaChallenge;
import com.blog.auth.entity.UserMfaRecoveryCode;
import com.blog.auth.mfa.MfaProperties;
import com.blog.auth.mfa.MfaSecretCipher;
import com.blog.auth.mfa.MfaSecretCipher.Purpose;
import com.blog.auth.mfa.MfaSecrets;
import com.blog.auth.mfa.RecoveryCodes;
import com.blog.auth.repository.MfaChallengeRepository;
import com.blog.auth.repository.MfaRecoveryCodeRepository;
import com.blog.auth.repository.MfaRepository;
import com.blog.auth.service.MfaVerifier.Method;
import com.blog.auth.service.MfaVerifier.Target;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.CurrentUserService;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Two-step verification: the second step of a sign-in, the forced enrollment of an administrator, and (as the feature
 * grows) the management of the authenticator. Every method that checks a code does it through {@link MfaVerifier}
 * (reserve-then-verify) in one transaction that COMMITS when it ends in an {@link MfaRejection}, because the failed attempt
 * must be counted.
 *
 * Nothing here logs or returns a code, a secret, a recovery code, a challenge or an email. The log carries the user id and a
 * stable event line (docs/SECURITY.md, "Audit events"). The plain secret leaves this class once, in the response of the
 * call that begins an enrollment.
 */
@Service
@RequiredArgsConstructor
public class MfaService {

    private static final Logger log = LoggerFactory.getLogger(MfaService.class);

    private final MfaChallengeService challengeService;
    private final MfaPolicy mfaPolicy;
    private final MfaVerifier verifier;
    private final MfaRepository mfaRepository;
    private final MfaRecoveryCodeRepository recoveryRepository;
    private final MfaChallengeRepository challengeRepository;
    private final UserRepository userRepository;
    private final AuthService authService;
    private final RefreshTokenService refreshTokenService;
    private final EnrollmentWindow enrollmentWindow;
    private final MfaEnrollmentCodeService enrollmentCodes;
    private final MfaSecretCipher cipher;
    private final MfaProperties properties;
    private final SecureRandom random;
    private final Clock clock;

    // --- The second step of a sign-in ---------------------------------------------------------------------

    /**
     * Completes a sign-in: checks the code against the challenge's account and, when it is right, opens the session with a
     * verified second factor (both proofs set to now).
     *
     * @param challenge the raw challenge from the 202 answer of the login
     * @param code      an authenticator code or a recovery code; the shape decides
     * @throws MfaRejection {@code MFA_CHALLENGE_INVALID} (unknown, expired, consumed, used up, another purpose, older than
     *                      the account's cut-off), {@code MFA_CODE_INVALID}, {@code MFA_RATE_LIMITED}, {@code MFA_FROZEN}
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public MfaVerifiedResponse verify(String challenge, String code) {
        User user = userOf(usable(challenge, ChallengePurpose.VERIFY));

        MfaVerifier.Verified verified =
                verifier.check(user.getId(), RefreshTokenService.hash(challenge.strip()), code, Target.LOGIN);

        TokenResponse tokens = authService.issueSession(user, SessionProof.verified(clock.instant()));
        int left = (int) recoveryRepository.countByUserIdAndUsedAtIsNull(user.getId());
        boolean usedRecovery = verified.method() == Method.RECOVERY;
        log.info(
                "mfa verify ok userId={} method={} recoveryLeft={}",
                user.getId(),
                usedRecovery ? "recovery" : "totp",
                left);
        return MfaVerifiedResponse.of(tokens, left, usedRecovery);
    }

    // --- The forced enrollment of a sign-in ---------------------------------------------------------------

    /**
     * Starts the enrollment of an account that must have an authenticator: checks the operator's enrollment code unless the
     * window is open, generates a secret and stores it PENDING (encrypted). Nothing else about the account changes:
     * abandoning the enrollment (a closed tab, a lost phone) leaves it exactly as it was, so a half-done enrollment can
     * never lock anyone out. A second begin overwrites the pending secret.
     *
     * The enrollment code counts toward the challenge's five attempts (reserved before the comparison, given back when it
     * is right), so a wrong guess is never free.
     *
     * @throws MfaRejection {@code MFA_CHALLENGE_INVALID} (also when the account has been enrolled in the meantime) and
     *                      {@code ENROLLMENT_CODE_INVALID}
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public MfaEnrollmentSecretResponse beginEnrollment(String challenge, String enrollmentCode) {
        User user = userOf(usable(challenge, ChallengePurpose.ENROLL));
        String challengeHash = RefreshTokenService.hash(challenge.strip());
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        if (userRepository.lockById(user.getId()).isEmpty()) {
            throw MfaRejection.challengeInvalid();
        }
        if (!enrollmentWindow.isOpen(user.getId())) {
            requireEnrollmentCode(user.getId(), challengeHash, enrollmentCode, now);
        }
        return storePendingSecret(user, now);
    }

    private void requireEnrollmentCode(UUID userId, String challengeHash, String enrollmentCode, Instant now) {
        if (challengeRepository.reserveAttempt(challengeHash, now, MfaChallengeService.MAX_ATTEMPTS) == 0) {
            throw MfaRejection.challengeInvalid();
        }
        if (!enrollmentCodes.matches(enrollmentCode)) {
            challengeRepository.consumeIfExhausted(challengeHash, now, MfaChallengeService.MAX_ATTEMPTS);
            log.warn("mfa enrollment code rejected userId={}", userId);
            throw MfaRejection.enrollmentCodeInvalid();
        }
        challengeRepository.refundAttempt(challengeHash);
    }

    /** Generates a secret, stores it PENDING and returns what the person needs to set up the app. */
    private MfaEnrollmentSecretResponse storePendingSecret(User user, Instant now) {
        byte[] secret = MfaSecrets.generate(random);
        byte[] stored = cipher.encrypt(user.getId(), Purpose.ACTIVE, secret);
        if (mfaRepository.upsertPending(user.getId(), stored, cipher.keyId(), now) == 0) {
            // The account is already enrolled: the challenge is stale.
            throw MfaRejection.challengeInvalid();
        }
        return secretResponse(user, secret);
    }

    private MfaEnrollmentSecretResponse secretResponse(User user, byte[] secret) {
        String account = accountLabel(user);
        return new MfaEnrollmentSecretResponse(
                MfaSecrets.encode(secret),
                MfaSecrets.otpauthUri(properties.issuer(), account, secret),
                properties.issuer(),
                account);
    }

    /**
     * Confirms the forced enrollment with the first code of the new authenticator (same window, replay and attempt rules as
     * a login): the enrollment becomes ACTIVE, ten recovery codes are written (returned here once, never again), the
     * enrollment window is closed, every older session of the account is revoked (so no session that existed before the
     * enrollment, signed in or not, survives it), and a session with a verified second factor is issued.
     *
     * @throws MfaRejection {@code MFA_CHALLENGE_INVALID}, {@code MFA_CODE_INVALID}, {@code MFA_RATE_LIMITED},
     *                      {@code MFA_FROZEN}
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public MfaEnrollmentConfirmedResponse confirmEnrollment(String challenge, String code) {
        User user = userOf(usable(challenge, ChallengePurpose.ENROLL));
        verifier.check(user.getId(), RefreshTokenService.hash(challenge.strip()), code, Target.ENROLLMENT);

        Instant now = clock.instant();
        List<String> recoveryCodes = writeRecoveryCodes(user.getId(), now);
        userRepository.setEnrollmentOpenUntil(user.getId(), null);
        refreshTokenService.revokeAllSessions(user.getId(), now);
        TokenResponse tokens = authService.issueSession(user, SessionProof.verified(now));
        afterCommitOfEnrollment(user);
        log.info("mfa enrolled userId={}", user.getId());
        return new MfaEnrollmentConfirmedResponse(
                tokens.accessToken(),
                tokens.refreshToken(),
                tokens.expiresIn(),
                tokens.refreshExpiresIn(),
                recoveryCodes);
    }

    // --- Management by the signed-in person ---------------------------------------------------------------
    //
    // AccountSecurityService is the front door of these: it has already checked the recent sign-in, the rate limit and
    // the
    // current password (all of which involve work that must not hold a database transaction). Everything here that
    // checks a
    // code does it through MfaVerifier with no challenge, so the same per-account counters apply as at the sign-in: the
    // endpoints of a stolen session are no free guessing oracle.

    /** Why an enrollment went away; the audit line carries it. */
    public enum RemovedBy {
        SELF,
        ADMIN,
        OPERATOR,
        ROLE_CHANGE;

        String logName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /** The status of the signed-in account's two-step verification. */
    @Transactional(readOnly = true)
    public MfaStatusResponse status(User user, boolean passwordManagedByEnvironment) {
        return new MfaStatusResponse(
                mfaPolicy.enrolled(user.getId()),
                mfaPolicy.required(user),
                (int) recoveryRepository.countByUserIdAndUsedAtIsNull(user.getId()),
                user.getPasswordHash() != null,
                passwordManagedByEnvironment);
    }

    /**
     * An author turns two-step verification on (administrators are enrolled by the sign-in itself). The current password,
     * where the account has one, has been checked by the caller; for an account without a password the fresh sign-in is the
     * proof. Stores a PENDING secret and answers it once; nothing about the account changes until the first code.
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public MfaEnrollmentSecretResponse beginSelfEnrollment(UUID userId) {
        User user = requireAuthor(userId);
        if (userRepository.lockById(userId).isEmpty() || mfaPolicy.enrolled(userId)) {
            throw new ApiException(
                    ErrorCode.RESOURCE_CONFLICT, HttpStatus.CONFLICT, "Two-step verification is already turned on");
        }
        return storePendingSecret(user, clock.instant().truncatedTo(ChronoUnit.MICROS));
    }

    /**
     * Confirms the author's enrollment with the first code of the new authenticator. Like the forced enrollment it activates,
     * writes ten recovery codes (answered once), and ends every session of the account, but here the caller survives: a new
     * session is issued with the same start time as the one that made the request, now with a verified second factor.
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public MfaEnrollmentConfirmedResponse confirmSelfEnrollment(UUID userId, String code) {
        User user = requireAuthor(userId);
        SessionProof carried = authService.callerProof();
        verifier.stepUp(userId, code, Target.ENROLLMENT, "enroll_confirm");

        Instant now = clock.instant();
        List<String> recoveryCodes = writeRecoveryCodes(userId, now);
        refreshTokenService.revokeAllSessions(userId, now);
        TokenResponse tokens = authService.issueSession(user, carried.withVerificationAt(now));
        log.info("mfa enrolled userId={}", userId);
        return new MfaEnrollmentConfirmedResponse(
                tokens.accessToken(),
                tokens.refreshToken(),
                tokens.expiresIn(),
                tokens.refreshExpiresIn(),
                recoveryCodes);
    }

    /** Replaces the ten recovery codes; the step-up code may itself be a recovery code (the person who lost the phone). */
    @Transactional(noRollbackFor = MfaRejection.class)
    public MfaRecoveryCodesResponse regenerateRecoveryCodes(UUID userId, String code) {
        verifier.stepUp(userId, code, Target.LOGIN, "recovery_codes");
        List<String> recoveryCodes = writeRecoveryCodes(userId, clock.instant());
        log.info("mfa recovery codes regenerated userId={}", userId);
        return new MfaRecoveryCodesResponse(recoveryCodes);
    }

    /**
     * Starts replacing the authenticator (a new phone). The step-up code is a code of the CURRENT authenticator or a recovery
     * code: an ADMIN never passes through a disabled state, and a person who lost the phone but kept the recovery codes can
     * still get a new authenticator. The new secret waits next to the active one, which keeps working; abandoning the
     * replacement changes nothing. A second begin overwrites the pending secret.
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public MfaEnrollmentSecretResponse beginReplace(UUID userId, String code) {
        User user = userRepository.findById(userId).orElseThrow(MfaRejection::challengeInvalid);
        verifier.stepUp(userId, code, Target.LOGIN, "replace_begin");

        byte[] secret = MfaSecrets.generate(random);
        byte[] stored = cipher.encrypt(userId, Purpose.PENDING, secret);
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        if (mfaRepository.storeReplacement(userId, stored, cipher.keyId(), now) == 0) {
            throw new ApiException(
                    ErrorCode.RESOURCE_CONFLICT, HttpStatus.CONFLICT, "Two-step verification is not turned on");
        }
        return secretResponse(user, secret);
    }

    /**
     * Confirms the replacement with the first code of the NEW authenticator. That secret has never accepted a code, so the
     * code is checked over the same window without comparing the replay guard (otherwise the code typed from the new app in
     * the same 30 seconds as the old app's step-up code would be refused as a replay); its single use is the swap itself.
     * One conditional UPDATE swaps the secret (only if the pending secret is still the one that was read, so two parallel
     * confirmations of one code swap once), the old recovery codes are void and ten new ones are answered, the other
     * sessions end, and the caller gets a new one.
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public MfaEnrollmentConfirmedResponse confirmReplace(UUID userId, String code) {
        User user = userRepository.findById(userId).orElseThrow(MfaRejection::challengeInvalid);
        SessionProof carried = authService.callerProof();
        MfaVerifier.Verified verified = verifier.stepUp(userId, code, Target.REPLACEMENT, "replace_confirm");

        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        byte[] secret = cipher.decrypt(userId, Purpose.PENDING, verified.pendingRead());
        byte[] active = cipher.encrypt(userId, Purpose.ACTIVE, secret);
        if (mfaRepository.swapReplacement(userId, verified.pendingRead(), active, cipher.keyId(), verified.step(), now)
                != 1) {
            throw new ApiException(
                    ErrorCode.RESOURCE_CONFLICT,
                    HttpStatus.CONFLICT,
                    "No new authenticator is waiting to be confirmed");
        }
        List<String> recoveryCodes = writeRecoveryCodes(userId, now);
        refreshTokenService.revokeAllSessions(userId, now);
        TokenResponse tokens = authService.issueSession(user, carried.withVerificationAt(now));
        log.info("mfa authenticator replaced userId={}", userId);
        return new MfaEnrollmentConfirmedResponse(
                tokens.accessToken(),
                tokens.refreshToken(),
                tokens.expiresIn(),
                tokens.refreshExpiresIn(),
                recoveryCodes);
    }

    /**
     * An author turns two-step verification off. An administrator cannot: it is mandatory for them (403
     * {@code MFA_REQUIRED}). Ends every session and issues the caller a new one, whose proof keeps the start time.
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public TokenResponse disable(UUID userId, String code) {
        User user = userRepository.findById(userId).orElseThrow(MfaRejection::challengeInvalid);
        if (user.getRole() == UserRole.ADMIN) {
            throw new ApiException(
                    ErrorCode.MFA_REQUIRED, HttpStatus.FORBIDDEN, "Administrators always use two-step verification");
        }
        SessionProof carried = authService.callerProof();
        verifier.stepUp(userId, code, Target.LOGIN, "disable");

        Instant now = clock.instant();
        removeEnrollment(userId, RemovedBy.SELF);
        refreshTokenService.revokeAllSessions(userId, now);
        return authService.issueSession(user, carried.withVerificationAt(now));
    }

    /**
     * The acting administrator's own code, asked before a change that a stolen session could use to leave a durable foothold (a role
     * change: RoleChangeStepUp). Runs in the caller's transaction, which must COMMIT when it ends in an {@link MfaRejection}, or
     * the failed attempt is not counted; the same reserve-then-verify, the same per-account brakes and the same replay guard as at
     * the sign-in. A missing or blank code is a wrong code but counts nothing: nobody guessed.
     */
    @Transactional(propagation = Propagation.MANDATORY, noRollbackFor = MfaRejection.class)
    public void requireActorCode(UUID actorId, String code) {
        if (code == null || code.isBlank()) {
            throw MfaRejection.codeInvalid();
        }
        verifier.check(actorId, null, code, Target.LOGIN);
    }

    /**
     * An administrator resets the two-step verification of an AUTHOR who lost the device (never of another administrator:
     * that is the server owner's job, docs/SECURITY.md). Needs the administrator's own code. The author's sessions end and
     * nothing is issued; the administrator's own session is untouched.
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public void resetAuthorEnrollment(UUID actorId, UUID targetId, String actorCode) {
        verifier.stepUp(actorId, actorCode, Target.LOGIN, "reset_author");
        User target = userRepository
                .findById(targetId)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.USER_NOT_FOUND, HttpStatus.NOT_FOUND, "User not found: " + targetId));
        if (target.getRole() == UserRole.ADMIN) {
            throw new ApiException(
                    ErrorCode.FORBIDDEN,
                    HttpStatus.FORBIDDEN,
                    "An administrator's two-step verification is reset by the server owner");
        }
        if (target.getRole() != UserRole.AUTHOR) {
            throw new ApiException(ErrorCode.USER_NOT_FOUND, HttpStatus.NOT_FOUND, "User not found: " + targetId);
        }
        userRepository.lockById(targetId);
        removeEnrollment(targetId, RemovedBy.ADMIN, actorId);
        refreshTokenService.revokeAllSessions(targetId, clock.instant());
    }

    /**
     * Deletes the enrollment and the recovery codes of an account, in the caller's transaction, and ends its sign-in
     * challenges. Used for a person turning it off, an administrator resetting an author, the operator, and a demotion to
     * USER (so an orphan cannot be enforced again by a later promotion, when the person may have lost the phone).
     */
    @Transactional
    public void removeEnrollment(UUID userId, RemovedBy by) {
        removeEnrollment(userId, by, null);
    }

    /**
     * {@link #removeEnrollment(UUID, RemovedBy)} for an act of another person: the line names who did it ({@code actorId}),
     * and is written even when the account had no enrollment left, because the reset still ended its sessions and an
     * administrator's act should leave a trace whatever it found.
     */
    void removeEnrollment(UUID userId, RemovedBy by, UUID actorId) {
        int removed = mfaRepository.deleteByUserId(userId);
        recoveryRepository.deleteByUserId(userId);
        challengeRepository.consumeAllForUser(userId, clock.instant());
        if (actorId != null) {
            log.info("mfa enrollment removed userId={} by={} actorId={}", userId, by.logName(), actorId);
        } else if (removed > 0) {
            log.info("mfa enrollment removed userId={} by={}", userId, by.logName());
        }
    }

    /** Clears the failure counters and the lock of an account: a real {@code ADMIN_PASSWORD} change does this. */
    @Transactional
    public void clearSecondStepLock(UUID userId) {
        mfaRepository.clearLock(userId, clock.instant());
    }

    private User requireAuthor(UUID userId) {
        User user = userRepository.findById(userId).orElseThrow(MfaRejection::challengeInvalid);
        if (user.getRole() != UserRole.AUTHOR) {
            throw new ApiException(
                    ErrorCode.FORBIDDEN,
                    HttpStatus.FORBIDDEN,
                    "Administrators are enrolled when they sign in; use Replace authenticator to change the device");
        }
        return user;
    }

    // --- Shared pieces -------------------------------------------------------------------------------------

    /** The challenge behind the raw value, or the one answer for every dead one. */
    private MfaChallenge usable(String challenge, ChallengePurpose purpose) {
        return challengeService.findUsable(challenge, purpose).orElseThrow(() -> {
            log.warn("mfa challenge rejected reason=unknown_or_expired");
            return MfaRejection.challengeInvalid();
        });
    }

    private User userOf(MfaChallenge challenge) {
        User user = userRepository.findById(challenge.getUserId()).orElseThrow(MfaRejection::challengeInvalid);
        // A suspension that landed after the password still wins, before a code is even looked at.
        if (user.getStatus() == UserStatus.SUSPENDED) {
            throw CurrentUserService.suspended();
        }
        return user;
    }

    /**
     * Replaces every recovery code of the account with ten new ones, in the caller's transaction, and returns them in their
     * shown form. Only the SHA-256 of each is stored.
     */
    private List<String> writeRecoveryCodes(UUID userId, Instant now) {
        recoveryRepository.deleteByUserId(userId);
        List<String> normalised = RecoveryCodes.generate(random);
        List<UserMfaRecoveryCode> rows = new ArrayList<>(normalised.size());
        List<String> shown = new ArrayList<>(normalised.size());
        for (String code : normalised) {
            UserMfaRecoveryCode row = new UserMfaRecoveryCode();
            row.setUserId(userId);
            row.setCodeHash(RecoveryCodes.hash(code));
            row.setCreatedAt(now);
            rows.add(row);
            shown.add(RecoveryCodes.format(code));
        }
        recoveryRepository.saveAll(rows);
        return shown;
    }

    /** The code file follows the accounts: deleted, or replaced when another administrator is still pending. */
    private void afterCommitOfEnrollment(User user) {
        if (user.getRole() != UserRole.ADMIN) {
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                enrollmentCodes.afterConfirm();
            }
        });
    }

    /** The label of the account in the authenticator app: the email, or the public slug of a GitHub account. */
    private static String accountLabel(User user) {
        return user.getEmail() != null && !user.getEmail().isBlank() ? user.getEmail() : user.getPublicSlug();
    }
}
