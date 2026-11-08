package com.blog.author.repository;

import com.blog.author.entity.AuthorApplication;
import com.blog.author.entity.AuthorApplicationStatus;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface AuthorApplicationRepository extends JpaRepository<AuthorApplication, UUID> {

    /** The latest application of a user (idx_author_applications_user). */
    Optional<AuthorApplication> findFirstByUserIdOrderByCreatedAtDescIdDesc(UUID userId);

    /** A page of applications by status, with the applicant (one JOIN, not one query per application). */
    @EntityGraph(attributePaths = "user")
    Page<AuthorApplication> findByStatus(AuthorApplicationStatus status, Pageable pageable);

    /** Decision time of the most recent rejection; empty when this user has never been rejected. */
    @Query("select max(a.decidedAt) from AuthorApplication a where a.userId = :userId"
            + " and a.status = com.blog.author.entity.AuthorApplicationStatus.REJECTED")
    Optional<Instant> findLastRejectedAt(UUID userId);

    /**
     * Inserts a PENDING application. If the user already has a PENDING one, the one-pending-per-user index blocks it and
     * {@code DO NOTHING} skips it, even when the other application is not committed yet (this statement waits for it):
     * two simultaneous submissions yield exactly one application, with no duplicate-key error.
     *
     * @return 1 when inserted; 0 when the user already has a PENDING application
     */
    @Modifying
    @Query(value = """
            INSERT INTO author_applications (id, user_id, motivation)
            VALUES (:id, :userId, CAST(:motivation AS text))
            ON CONFLICT (user_id) WHERE status = 'PENDING' DO NOTHING""", nativeQuery = true)
    int insertPending(UUID id, UUID userId, String motivation);

    /**
     * Decides an application that is still PENDING. Two simultaneous decisions: the later one waits for the row lock, then
     * sees the application already decided and changes nothing. Clears the persistence context so the following read
     * of the application sees the new status.
     *
     * @param status name of {@link AuthorApplicationStatus#APPROVED} or {@link AuthorApplicationStatus#REJECTED}
     * @return 1 when decided; 0 when the application does not exist or is no longer PENDING
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = """
            UPDATE author_applications SET status = :status, decided_at = now(), decided_by = :actorId
            WHERE id = :id AND status = 'PENDING'""", nativeQuery = true)
    int decideIfPending(UUID id, String status, UUID actorId);
}
