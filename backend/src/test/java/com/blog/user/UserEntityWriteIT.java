package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

import com.blog.auth.service.MfaService;
import com.blog.auth.service.RefreshTokenService;
import com.blog.common.security.AdminAccountProperties;
import com.blog.common.security.AdminPasswordFromEnvironment;
import com.blog.common.security.PasswordPolicy;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.AdditionalAnswers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The V5 columns of users (status, github_id, github_login, avatar_url, last_login_at) and role are READ-ONLY on entity
 * update: saving an unrelated User never writes an old value over a GitHub login, a suspension or a role
 * demotion that has just committed.
 *
 * The real scenario is AdminPasswordFromEnvironment: at startup it loads the admin account, sets a new password hash and saves,
 * in one transaction. The entity has no @DynamicUpdate, so its UPDATE statement writes EVERY updatable column, with the value
 * read at load time. If the columns above were among them, a login (or suspension) that commits between the load and the save would
 * be wiped out: a suspended person is unsuspended, the GitHub link disappears.
 *
 * Runs on an account of its own, not the seed admin: the admin row is shared by the whole test suite, and a run that fails
 * halfway must not leave it suspended.
 */
class UserEntityWriteIT extends AbstractIntegrationTest {

    private static final String NEW_PASSWORD = "mat-khau-moi-cua-admin-it-nhat-12";

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private PasswordPolicy passwordPolicy;

    @Autowired
    private MfaService mfaService;

    private String suffix;

    @BeforeEach
    void setUp() {
        suffix = UUID.randomUUID().toString().substring(0, 8);
    }

    @Test
    void setting_admin_password_at_startup_does_not_overwrite_a_github_login_suspension_or_demotion_committed_midway() {
        String email = "entity-write-runner-" + suffix + "@blog.local";
        // The runner loads the account while it is still ADMIN: writing back the loaded role would re-promote someone
        // who was just demoted.
        UUID id = auth.createAccount(email, UserRole.ADMIN).getId();
        Concurrent change = new Concurrent(auth.nextGithubId(), "dang-nhap-" + suffix);

        // The real repository, with only one committed change wedged in right after the runner's account load: exactly
        // where a real
        // login could land.
        UserRepository racing = mock(UserRepository.class, AdditionalAnswers.delegatesTo(userRepository));
        doAnswer(invocation -> {
                    Optional<User> loaded = userRepository.findByEmail(invocation.getArgument(0));
                    commitInAnotherTransaction(id, change);
                    return loaded;
                })
                .when(racing)
                .findByEmail(email);
        AdminPasswordFromEnvironment runner = new AdminPasswordFromEnvironment(
                racing,
                passwordEncoder,
                adminProperties(email, NEW_PASSWORD),
                refreshTokenService,
                passwordPolicy,
                mfaService);

        // As at startup: run is @Transactional, so the account is a managed entity and the UPDATE runs at commit.
        new TransactionTemplate(transactionManager)
                .executeWithoutResult(status -> runner.run(new DefaultApplicationArguments()));

        Map<String, Object> row = row(id);
        // Control: the runner really did write, after that other change. Without this line, the test would also pass if
        // the runner did nothing.
        assertThat(passwordEncoder.matches(NEW_PASSWORD, (String) row.get("password_hash")))
                .isTrue();
        assertSurvived(row, change);
    }

    @Test
    void saving_a_previously_loaded_User_does_not_overwrite_read_only_columns_but_still_writes_normal_columns() {
        UUID id = auth.createAccount("entity-write-merge-" + suffix + "@blog.local", UserRole.AUTHOR)
                .getId();
        Concurrent change = new Concurrent(auth.nextGithubId(), "luu-lai-" + suffix);

        // Outside a transaction: the entity is detached right away, and save is a merge. The path of every service that
        // loads and saves later.
        User stale = userRepository.findById(id).orElseThrow();
        commitInAnotherTransaction(id, change);
        stale.setDisplayName("New name " + suffix);
        userRepository.save(stale);

        Map<String, Object> row = row(id);
        assertThat(row.get("display_name")).isEqualTo("New name " + suffix);
        assertSurvived(row, change);
    }

    @Test
    void fixture_can_save_a_reader_with_all_columns_while_a_setter_on_an_existing_row_writes_nothing() {
        long githubId = auth.nextGithubId();
        User reader = auth.createReader(githubId, "doc-gia-" + suffix, UserStatus.SUSPENDED);

        // insertable is still true: creation writes all the new columns.
        Map<String, Object> created = row(reader.getId());
        assertThat(created.get("github_id")).isEqualTo(githubId);
        assertThat(created.get("github_login")).isEqualTo("doc-gia-" + suffix);
        assertThat(created.get("avatar_url")).isEqualTo("https://avatars.githubusercontent.com/u/" + githubId + "?v=4");
        assertThat(created.get("status")).isEqualTo("SUSPENDED");
        assertThat(created.get("role")).isEqualTo("USER");
        assertThat(created.get("email")).isNull();
        assertThat(created.get("password_hash")).isNull();
        assertThat(created.get("last_login_at")).isNotNull();

        // The trap documented on User and AuthTestSupport: a setter followed by save silently changes nothing...
        reader.setStatus(UserStatus.ACTIVE);
        reader.setGithubLogin("doi-ten-" + suffix);
        userRepository.save(reader);
        assertThat(row(reader.getId()).get("status")).isEqualTo("SUSPENDED");
        assertThat(row(reader.getId()).get("github_login")).isEqualTo("doc-gia-" + suffix);

        // ...while the SQL path does.
        auth.setStatus(reader.getId(), UserStatus.ACTIVE);
        assertThat(row(reader.getId()).get("status")).isEqualTo("ACTIVE");
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    /**
     * A GitHub login (link, login change, avatar, login time) together with a suspension and a demotion
     * to USER, written the way the real code writes them.
     */
    private record Concurrent(long githubId, String login, String avatarUrl, Instant lastLoginAt) {
        Concurrent(long githubId, String login) {
            this(
                    githubId,
                    login,
                    "https://avatars.githubusercontent.com/u/" + githubId + "?v=4",
                    Instant.now().minus(1, ChronoUnit.MINUTES).truncatedTo(ChronoUnit.MICROS));
        }
    }

    /** Commits on a separate connection (REQUIRES_NEW), even when the caller is inside a transaction. */
    private void commitInAnotherTransaction(UUID id, Concurrent change) {
        TransactionTemplate requiresNew = new TransactionTemplate(transactionManager);
        requiresNew.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        requiresNew.executeWithoutResult(status -> jdbcTemplate.update(
                "UPDATE users SET github_id = ?, github_login = ?, avatar_url = ?, status = 'SUSPENDED', role = 'USER', "
                        + "last_login_at = ?, updated_at = now() WHERE id = ?",
                change.githubId(),
                change.login(),
                change.avatarUrl(),
                Timestamp.from(change.lastLoginAt()),
                id));
    }

    private void assertSurvived(Map<String, Object> row, Concurrent change) {
        assertThat(row.get("status")).isEqualTo("SUSPENDED");
        assertThat(row.get("role")).isEqualTo("USER");
        assertThat(row.get("github_id")).isEqualTo(change.githubId());
        assertThat(row.get("github_login")).isEqualTo(change.login());
        assertThat(row.get("avatar_url")).isEqualTo(change.avatarUrl());
        assertThat(((Timestamp) row.get("last_login_at")).toInstant()).isEqualTo(change.lastLoginAt());
    }

    private Map<String, Object> row(UUID id) {
        return jdbcTemplate.queryForMap(
                "SELECT email, password_hash, display_name, role, status, github_id, "
                        + "github_login, avatar_url, last_login_at FROM users WHERE id = ?",
                id);
    }

    /**
     * Builds the properties through Binder as Spring does at startup, without calling the record's constructor directly: this record
     * will gain more fields, and the test should not break because of that.
     */
    private static AdminAccountProperties adminProperties(String email, String password) {
        return new Binder(new MapConfigurationPropertySource(Map.of(
                        "app.admin.email", email,
                        "app.admin.password", password)))
                .bind("app.admin", AdminAccountProperties.class)
                .get();
    }
}
