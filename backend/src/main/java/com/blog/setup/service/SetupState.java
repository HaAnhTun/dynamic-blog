package com.blog.setup.service;

import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ResultSetExtractor;
import org.springframework.stereotype.Component;

/**
 * The first-run state in {@code app_settings} (V36). Every writer of that state (the setup request and the startup
 * runners) first takes {@link #lockForUpdate()} in its transaction, so they run one after the other: two setup requests
 * cannot both see "required", and a runner cannot act on a state a request has just changed.
 *
 * A missing row reads as "not required": an instance whose state cannot be proven fresh is never claimable.
 */
@Component
@RequiredArgsConstructor
public class SetupState {

    private static final String LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('first-run-setup'))";

    private final JdbcTemplate jdbcTemplate;

    /** A plain read, for the status endpoint and the code runner. */
    public boolean isRequired() {
        return required(
                jdbcTemplate.queryForList("SELECT setup_completed FROM app_settings WHERE id = 1", Boolean.class));
    }

    /**
     * Takes the setup lock until the end of the current transaction, then reads the state with the row locked. Must run
     * inside a transaction: outside one, the lock is released at once.
     */
    public boolean lockForUpdate() {
        jdbcTemplate.query(LOCK_SQL, (ResultSetExtractor<Void>) rs -> null);
        return required(jdbcTemplate.queryForList(
                "SELECT setup_completed FROM app_settings WHERE id = 1 FOR UPDATE", Boolean.class));
    }

    /** Closes setup for good. Call only after {@link #lockForUpdate()} returned true in the same transaction. */
    public void markCompleted() {
        jdbcTemplate.update("UPDATE app_settings SET setup_completed = TRUE, setup_completed_at = now(), "
                + "updated_at = now() WHERE id = 1");
    }

    private static boolean required(List<Boolean> rows) {
        return !rows.isEmpty() && Boolean.FALSE.equals(rows.getFirst());
    }
}
