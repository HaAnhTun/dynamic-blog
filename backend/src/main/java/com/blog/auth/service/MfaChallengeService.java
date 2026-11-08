package com.blog.auth.service;

import com.blog.auth.entity.ChallengePurpose;
import com.blog.auth.entity.FirstFactor;
import com.blog.auth.entity.MfaChallenge;
import com.blog.auth.mfa.MfaProperties;
import com.blog.auth.repository.MfaChallengeRepository;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The challenge between the first factor and the session: 256 bits of {@link SecureRandom}, stored only as a SHA-256 (the
 * reasoning of the refresh token, V7), single use, an attempt counter in the database and a short life
 * ({@code app.mfa.challenge-ttl}, 5 minutes by default).
 *
 * A second sign-in of the same account does NOT invalidate older challenges: someone who holds the password must not be able
 * to kill the owner's pending challenge. At most {@value #MAX_LIVE} stay live per account, and the 21st sign-in is refused
 * (429) rather than evicting the oldest, for the same reason. All of an account's challenges end when any one of them
 * succeeds or when the account's token cut-off moves (password change, sign out everywhere, role change, operator reset).
 */
@Service
@RequiredArgsConstructor
public class MfaChallengeService {

    /** Live challenges one account may hold. */
    public static final int MAX_LIVE = 20;

    /** Codes evaluated per challenge; then it is consumed and the person signs in again. */
    public static final int MAX_ATTEMPTS = 5;

    private static final Logger log = LoggerFactory.getLogger(MfaChallengeService.class);
    private static final int CHALLENGE_BYTES = 32;

    private final MfaChallengeRepository challengeRepository;
    private final UserRepository userRepository;
    private final MfaProperties properties;
    private final EnrollmentWindow enrollmentWindow;
    private final MfaEnrollmentCodeService enrollmentCodes;
    private final SecureRandom random;
    private final Clock clock;

    /** What the client is told; {@code rawToken} is shown once and never stored. */
    public record Issued(
            String rawToken, ChallengePurpose purpose, long expiresInSeconds, boolean enrollmentCodeRequired) {

        @Override
        public String toString() {
            return "Issued[rawToken=<hidden>, purpose=" + purpose + ", expiresInSeconds=" + expiresInSeconds
                    + ", enrollmentCodeRequired=" + enrollmentCodeRequired + "]";
        }
    }

    /**
     * Creates a challenge for an account that has just passed the first factor. The caller holds the account's row lock
     * ({@code UserRepository.lockById}), so the count of live challenges is exact.
     *
     * @throws MfaRejection 429 {@code MFA_RATE_LIMITED} when the account already holds {@value #MAX_LIVE} live challenges
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Issued issue(User user, ChallengePurpose purpose, FirstFactor firstFactor) {
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        if (challengeRepository.countLive(user.getId(), now) >= MAX_LIVE) {
            throw MfaRejection.rateLimited(null);
        }
        byte[] bytes = new byte[CHALLENGE_BYTES];
        random.nextBytes(bytes);
        String raw = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);

        MfaChallenge challenge = new MfaChallenge();
        challenge.setTokenHash(RefreshTokenService.hash(raw));
        challenge.setUserId(user.getId());
        challenge.setPurpose(purpose);
        challenge.setFirstFactor(firstFactor);
        challenge.setCreatedAt(now);
        challenge.setExpiresAt(now.plus(properties.challengeTtl()));
        challengeRepository.save(challenge);

        boolean codeRequired = purpose == ChallengePurpose.ENROLL && !enrollmentWindow.isOpen(user.getId());
        if (codeRequired) {
            // A promotion to ADMIN at runtime has no code file until the next restart: make sure there is one to ask
            // for.
            enrollmentCodes.ensureForPendingAdmin();
        }
        log.info("mfa challenge issued userId={} purpose={} firstFactor={}", user.getId(), purpose, firstFactor);
        return new Issued(raw, purpose, properties.challengeTtl().toSeconds(), codeRequired);
    }

    /**
     * A challenge created before the account's {@code tokens_valid_after} is dead (a password change, a sign-out everywhere,
     * a role change or an operator reset ended every session and every pending sign-in). Compared at full resolution, not
     * with the second truncation access tokens get: a second of slack would let a challenge created in the same second,
     * before the bump, survive.
     */
    private boolean predatesCutOff(MfaChallenge challenge) {
        return userRepository
                .findAccessById(challenge.getUserId())
                .map(access -> access.tokensValidAfter() != null
                        && challenge.getCreatedAt().isBefore(access.tokensValidAfter()))
                .orElse(true);
    }

    /**
     * The challenge behind a raw value, if it can still be used for this purpose. This is the quick look that tells the
     * caller whose account to lock; the decisive check is the conditional reservation of an attempt
     * ({@link MfaChallengeRepository#reserveAttempt}), which repeats every condition under the account lock.
     */
    @Transactional(readOnly = true)
    public Optional<MfaChallenge> findUsable(String rawToken, ChallengePurpose purpose) {
        if (rawToken == null || rawToken.isBlank()) {
            return Optional.empty();
        }
        Instant now = clock.instant();
        return challengeRepository
                .findByTokenHash(RefreshTokenService.hash(rawToken.strip()))
                .filter(c -> c.getPurpose() == purpose
                        && c.getConsumedAt() == null
                        && c.getExpiresAt().isAfter(now)
                        && !predatesCutOff(c));
    }
}
