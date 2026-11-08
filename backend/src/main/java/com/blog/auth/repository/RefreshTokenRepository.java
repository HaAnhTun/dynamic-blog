package com.blog.auth.repository;

import com.blog.auth.entity.RefreshToken;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface RefreshTokenRepository extends JpaRepository<RefreshToken, UUID> {
    Optional<RefreshToken> findByTokenHash(String tokenHash);

    /**
     * Only the owner of a token, without loading anything: a rotation learns whose account row to lock before it reads the
     * token itself (RefreshTokenService.rotate). A scalar query puts no entity in the persistence context, so the token read
     * after the lock is a fresh read, not a copy loaded before the lock.
     */
    @Query("select rt.user.id from RefreshToken rt where rt.tokenHash = :tokenHash")
    Optional<UUID> findUserIdByTokenHash(String tokenHash);

    /**
     * The same lookup with the owning user joined in.
     *
     * `rotate` hands its caller the User so a token can be minted for it, and the plain
     * finder above returns a lazy proxy. This project sets
     * `spring.jpa.open-in-view: false`, so the session closes when the @Transactional
     * method returns and the first read of that proxy throws
     * LazyInitializationException — in production exactly as in a test. A targeted
     * `join fetch` fixes it in one query, without making the association EAGER for every
     * query that only needs to revoke a row, and without a side-effecting "touch" line
     * that reads like dead code and invites deletion.
     */
    @Query("select rt from RefreshToken rt join fetch rt.user where rt.tokenHash = :tokenHash")
    Optional<RefreshToken> findByTokenHashWithUser(String tokenHash);

    /**
     * Revokes a token only if it is still live, and reports how many rows that changed.
     *
     * This is what makes rotation safe against two requests arriving together. A plain
     * read-then-save does not: under READ_COMMITTED both transactions see
     * `revokedAt == null` before either commits, both proceed, and each mints an
     * unrelated new token so there is no unique collision to stop it — measured, both
     * callers succeeded and one token became two live ones. Postgres locks the row for
     * the duration of this UPDATE, so exactly one of two concurrent callers gets 1 back
     * and the other gets 0 and has lost the race.
     */
    @Modifying
    @Query("update RefreshToken rt set rt.revokedAt = :now "
            + "where rt.tokenHash = :tokenHash and rt.revokedAt is null")
    int revokeIfLive(String tokenHash, Instant now);

    /**
     * Revokes every live refresh token of one person, returning the number of tokens just revoked. Used on suspension:
     * a suspended person keeps no session past the next access token expiry. Also used when ADMIN_PASSWORD really
     * changes (AdminPasswordFromEnvironment) and when a reused token is detected (RefreshTokenService.rotate).
     *
     * A token revoked earlier keeps its {@code revokedAt}: the history of "when was this token reused" is not
     * overwritten. Like {@link #revokeIfLive}, the caller must already be inside a transaction.
     *
     * The caller must also have written the account row first ({@code UserRepository.bumpTokensValidAfter}, a role or
     * status change): that UPDATE takes the lock a rotation of the same person takes before it reads its token and
     * inserts the successor (RefreshTokenService.rotate), so a rotation is either entirely before this statement (the
     * successor is committed and revoked here) or entirely after it (the token is already revoked and nothing is
     * issued). Without it a rotation that overlaps this statement would leave one live successor (audit 113).
     *
     * A bulk revocation also ends the expiry of the tokens it revokes ({@code expiresAt} becomes {@code now}, never
     * extending an expiry that has already passed). Only a token revoked ON ITS OWN (rotation, logout) that is still
     * unexpired counts as reuse when it comes back: an old device reopening with a token killed during a suspension,
     * password change or role change gets EXPIRED, without triggering one more sign-out of every session. The next
     * cleanup (RefreshTokenCleanup) deletes these rows since they have expired.
     */
    @Modifying
    @Query("update RefreshToken rt set rt.revokedAt = :now, "
            + "rt.expiresAt = case when rt.expiresAt > :now then :now else rt.expiresAt end "
            + "where rt.user.id = :userId and rt.revokedAt is null")
    int revokeAllLiveForUser(UUID userId, Instant now);

    /**
     * Revokes every live refresh token of ONE login session (the lineage of rotations of a single sign-in on a single device),
     * returning the number of tokens just revoked. The reuse detection uses it (RefreshTokenService.rotate): a token that is
     * replayed after its grace period ends the session it belongs to, successor included, and leaves the person's other
     * sessions alone (audit 104). Like {@link #revokeAllLiveForUser} it ends the expiry of the tokens it revokes, so each of
     * them gets EXPIRED when it comes back instead of triggering one more detection; the caller must already be inside a
     * transaction and holding the account row lock.
     */
    @Modifying
    @Query("update RefreshToken rt set rt.revokedAt = :now, "
            + "rt.expiresAt = case when rt.expiresAt > :now then :now else rt.expiresAt end "
            + "where rt.sessionId = :sessionId and rt.revokedAt is null")
    int revokeAllLiveForSession(UUID sessionId, Instant now);

    /**
     * Revokes every live refresh token of one login session and nothing else: unlike {@link #revokeAllLiveForSession} the expiry
     * stays, so a token that comes back after a sign-out is REVOKED (and, after the grace period, a reuse), exactly as before
     * the sign-out ended the whole lineage. Used by the sign-out (RefreshTokenService.revoke); the caller must already be inside
     * a transaction and holding the account row lock.
     */
    @Modifying
    @Query("update RefreshToken rt set rt.revokedAt = :now where rt.sessionId = :sessionId and rt.revokedAt is null")
    int revokeLiveForSession(UUID sessionId, Instant now);

    /**
     * Whether a login session OF THIS PERSON still has a live refresh token (not revoked, not expired): the per-request
     * check of an access token's {@code sid} claim (CurrentAccessJwtConverter). The session must belong to the subject of
     * the token: a session id alone would let the token of one account stand on the session of another (audit 112). Served
     * by the partial index {@code idx_refresh_tokens_live_session}.
     */
    @Query("select count(rt) > 0 from RefreshToken rt where rt.sessionId = :sessionId and rt.user.id = :userId "
            + "and rt.revokedAt is null and rt.expiresAt > :now")
    boolean existsLiveSession(UUID sessionId, UUID userId, Instant now);

    /**
     * The live refresh token of a login session of this person, newest first: where a signed-in request reads the proof of
     * its own session (when it started, whether a second factor was verified) before {@code revokeAllSessions} ends it and
     * a new session is issued with the same start time.
     */
    @Query("select rt from RefreshToken rt where rt.sessionId = :sessionId and rt.user.id = :userId "
            + "and rt.revokedAt is null and rt.expiresAt > :now order by rt.createdAt desc")
    List<RefreshToken> findLiveBySessionId(UUID sessionId, UUID userId, Instant now);

    /**
     * Ends the expiry of one token (never extends it). Reuse detection calls it on the reused token itself, so each
     * token triggers only once (RefreshTokenService.rotate).
     */
    @Modifying
    @Query("update RefreshToken rt set rt.expiresAt = :now where rt.id = :id and rt.expiresAt > :now")
    int expire(UUID id, Instant now);

    /**
     * The nightly cleanup (RefreshTokenCleanup): deletes expired tokens and tokens revoked before
     * {@code revokedBefore}, returning the number of rows deleted. One statement, reading nothing first: running with
     * nothing to delete, or two instances running at once, is harmless. A live token ({@code revoked_at} NULL, not
     * expired) never matches.
     *
     * There is no index on these two columns: one scan per night over a table of a few thousand rows is cheaper than an
     * index that must be updated on every login and every token rotation.
     */
    @Modifying
    @Query(
            value = "delete from refresh_tokens where expires_at < :now or revoked_at < :revokedBefore",
            nativeQuery = true)
    int deleteExpiredOrRevokedBefore(Instant now, Instant revokedBefore);
}
