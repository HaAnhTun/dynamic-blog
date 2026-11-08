package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.security.SeedAdmin;
import com.blog.fixtures.vi.IdentityViNames;
import com.blog.support.AbstractIntegrationTest;
import com.blog.user.service.PublicSlugs;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * V32 on a database that already holds real users: Flyway builds a separate DB up to V31, the test writes rows like the running
 * site has (colliding logins, a login that already looks like "base-2", the same created_at, a Vietnamese name, an empty or NULL login, a name with
 * no usable character left, a very long name), and only then runs V32. No Spring context needed: only the migration's SQL is checked.
 */
class UserPublicSlugMigrationIT {

    private static final Instant T0 = Instant.parse("2020-01-01T00:00:00Z");

    /** A row that exists before V32: login (null is a password account), name, seconds after T0, and the expected slug. */
    private record Account(UUID id, String login, String displayName, int second, String expected) {}

    private final AtomicLong githubIds = new AtomicLong(1_000);

    @Test
    void v32_fills_slug_for_every_old_row_by_created_at_then_id_without_suffix_clash_and_builds_all_constraints() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("public_slug_migration_it");
        Flyway.configure().dataSource(dataSource).target("31").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);

        String a30 = "a".repeat(30);
        String x39 = "x".repeat(39);
        // Two rows with the same created_at: the smaller id goes first.
        UUID tieFirst = UUID.fromString("00000000-0000-0000-0000-00000000aaa1");
        UUID tieSecond = UUID.fromString("00000000-0000-0000-0000-00000000aaa2");
        List<Account> accounts = List.of(
                // A login that already looks like "octocat-2", older than the two octocats: their suffixes must skip
                // it.
                account("octocat-2", "Person A", 1, "octocat-2"),
                account("octocat", "Person B", 2, "octocat"),
                account("OctoCat", "Person C", 3, "octocat-3"),
                new Account(tieSecond, "trung-gio", "Person E", 4, "trung-gio-2"),
                new Account(tieFirst, "trung-gio", "Person D", 4, "trung-gio"),
                account(null, IdentityViNames.NGUYEN_VAN_DUC, 5, "nguyen-van-duc"),
                account("", IdentityViNames.TRAN_THI_ANH_DAO, 6, "tran-thi-anh-dao"),
                account(null, "!!! ???", 7, "nguoi-dung"),
                account(null, "日本語", 8, "nguoi-dung-2"),
                account(null, a30 + " " + "b".repeat(30), 9, a30 + "-" + "b".repeat(9)),
                // The cut at 40 lands right after "-": no "-" is left at the end.
                account(null, x39 + " yyy", 10, x39),
                account(null, IdentityViNames.DUONG_DAN_PADDED, 11, "duong-dan"),
                account(null, IdentityViNames.NGUYEN_VAN_DUC, 12, "nguyen-van-duc-2"));
        for (Account account : accounts) {
            insert(jdbc, account);
        }

        Flyway.configure().dataSource(dataSource).target("32").load().migrate();

        for (Account account : accounts) {
            assertThat(slugOf(jdbc, account.id()))
                    .as("%s / %s", account.login(), account.displayName())
                    .isEqualTo(account.expected());
            // The same rule as new rows (PublicSlugs): the Java base is the expected slug before the suffix.
            assertThat(account.expected())
                    .as("Java root of %s", account.displayName())
                    .startsWith(PublicSlugs.baseOf(account.login(), account.displayName()));
        }
        // The seed admin of V2 (created at migrate time, after all the rows above): the base comes from the name
        // "Admin".
        assertThat(slugOf(jdbc, SeedAdmin.ID)).isEqualTo("admin");

        // NOT NULL, UNIQUE, CHECK and the column length.
        UUID id = UUID.randomUUID();
        assertThatThrownBy(() -> jdbc.update(
                        "INSERT INTO users (id, email, password_hash, display_name, role) "
                                + "VALUES (?, ?, 'x', 'Missing slug', 'USER')",
                        id,
                        id + "@blog.local"))
                .isInstanceOf(DataIntegrityViolationException.class);
        List<String> rejected =
                new ArrayList<>(List.of("octocat", "Octocat", "a--b", "-a", "a-", "a b", IdentityViNames.D_STROKE, ""));
        rejected.add("a".repeat(65));
        for (String slug : rejected) {
            assertThatThrownBy(() -> insertWithSlug(jdbc, slug))
                    .as("slug '%s'", slug)
                    .isInstanceOf(DataIntegrityViolationException.class);
        }
        insertWithSlug(jdbc, "abc-123-" + "z".repeat(56));
    }

    private Account account(String login, String displayName, int second, String expected) {
        return new Account(UUID.randomUUID(), login, displayName, second, expected);
    }

    /** A row with a login is a GitHub reader; a row without a login is a password account (chk_users_has_credential). */
    private void insert(JdbcTemplate jdbc, Account account) {
        Timestamp createdAt = Timestamp.from(T0.plusSeconds(account.second()));
        if (account.login() == null) {
            jdbc.update(
                    "INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) "
                            + "VALUES (?, ?, 'x', ?, 'AUTHOR', ?, ?)",
                    account.id(),
                    account.id() + "@blog.local",
                    account.displayName(),
                    createdAt,
                    createdAt);
        } else {
            jdbc.update(
                    "INSERT INTO users (id, github_id, github_login, display_name, role, created_at, updated_at) "
                            + "VALUES (?, ?, ?, ?, 'USER', ?, ?)",
                    account.id(),
                    githubIds.incrementAndGet(),
                    account.login(),
                    account.displayName(),
                    createdAt,
                    createdAt);
        }
    }

    private void insertWithSlug(JdbcTemplate jdbc, String slug) {
        UUID id = UUID.randomUUID();
        jdbc.update(
                "INSERT INTO users (id, email, password_hash, display_name, role, public_slug) "
                        + "VALUES (?, ?, 'x', 'Has slug', 'USER', ?)",
                id,
                id + "@blog.local",
                slug);
    }

    private static String slugOf(JdbcTemplate jdbc, UUID id) {
        return jdbc.queryForObject("SELECT public_slug FROM users WHERE id = ?", String.class, id);
    }
}
