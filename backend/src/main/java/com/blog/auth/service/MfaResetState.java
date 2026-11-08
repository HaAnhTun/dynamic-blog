package com.blog.auth.service;

import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * The operator-reset marker in {@code app_settings.mfa_reset_applied_hash} (V44): the SHA-256 of the
 * {@code MFA_RESET_TOKEN} whose reset has already been applied. {@code app_settings} is one row with fixed columns (V36),
 * not a key-value store, so the marker is a column. Reached the way {@code SetupState} reaches the same row.
 *
 * It stores a hash, never the token: the database never holds a value the operator can still use.
 */
@Component
@RequiredArgsConstructor
public class MfaResetState {

    private final JdbcTemplate jdbcTemplate;

    /** The hash of the last applied token; empty when no reset was ever applied (or the row is missing). */
    public Optional<String> appliedHash() {
        List<String> rows =
                jdbcTemplate.queryForList("SELECT mfa_reset_applied_hash FROM app_settings WHERE id = 1", String.class);
        return rows.isEmpty() ? Optional.empty() : Optional.ofNullable(rows.getFirst());
    }

    /** Records that the reset of this token hash was applied; call it in the transaction that did the reset. */
    public void markApplied(String tokenHash) {
        jdbcTemplate.update(
                "UPDATE app_settings SET mfa_reset_applied_hash = ?, updated_at = now() WHERE id = 1", tokenHash);
    }
}
