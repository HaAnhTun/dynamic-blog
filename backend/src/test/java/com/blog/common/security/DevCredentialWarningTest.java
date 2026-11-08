package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * The admin dev password at startup: a public site refuses to start, a dev machine only warns as
 * before. Two rows are checked: the row of {@code ADMIN_EMAIL} (already renamed by AdminSeedEmail, and given ADMIN_PASSWORD if set)
 * and the row carrying exactly {@value SeedAdmin#EMAIL}, because a seed row that cannot be renamed (the email already belongs to a user) can still be logged into
 * with the dev password.
 *
 * The repository and encoder are mocks: what must be proven is the decision, not Argon2. The real DB part is in
 * AdminSeedEmailIT and AdminPasswordFromEnvironmentIT.
 */
class DevCredentialWarningTest {

    private static final String DEV_HASH = "$argon2id$hash-cua-admin12345";
    private static final String REAL_HASH = "$argon2id$hash-cua-mat-khau-that";
    private static final String OWNER = "owner@example.com";

    private final UserRepository users = mock(UserRepository.class);
    private final PasswordEncoder encoder = mock(PasswordEncoder.class);

    private final Logger logger = (Logger) LoggerFactory.getLogger(DevCredentialWarning.class);
    private final ListAppender<ILoggingEvent> logs = new ListAppender<>();

    @BeforeEach
    void setUp() {
        logs.start();
        logger.addAppender(logs);
        when(users.findByEmail(anyString())).thenReturn(Optional.empty());
        when(encoder.matches(SeedAdmin.DEV_PASSWORD, DEV_HASH)).thenReturn(true);
        when(encoder.matches(SeedAdmin.DEV_PASSWORD, REAL_HASH)).thenReturn(false);
    }

    @AfterEach
    void release() {
        logger.detachAppender(logs);
    }

    @Test
    void public_site_with_admin_still_on_dev_password_does_not_start_and_error_does_not_copy_value() {
        account(SeedAdmin.EMAIL, DEV_HASH);

        assertThatThrownBy(
                        () -> guard(SeedAdmin.EMAIL, "https://blog.example.com").run(new DefaultApplicationArguments()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("ADMIN_PASSWORD")
                .hasMessageContaining("ADMIN_EMAIL")
                .hasMessageNotContaining(SeedAdmin.DEV_PASSWORD)
                .hasMessageNotContaining(SeedAdmin.EMAIL)
                .hasMessageNotContaining("blog.example.com");
    }

    @Test
    void dev_machine_only_warns_as_before() {
        account(SeedAdmin.EMAIL, DEV_HASH);

        for (String siteUrl : new String[] {null, "", "http://localhost:3000", "http://127.0.0.1:3100"}) {
            logs.list.clear();
            assertThatCode(() -> guard(SeedAdmin.EMAIL, siteUrl).run(new DefaultApplicationArguments()))
                    .as(siteUrl)
                    .doesNotThrowAnyException();
            assertThat(warnings())
                    .as(siteUrl)
                    .anySatisfy(line -> assertThat(line).contains("development password"));
        }
    }

    @Test
    void the_warning_names_the_account_by_role_and_never_writes_an_email_address() {
        // Logs go to Docker, support tickets and aggregators: an address does not belong there (docs/SECURITY.md).
        account(OWNER, DEV_HASH);
        guard(OWNER, "http://localhost:3000").run(new DefaultApplicationArguments());
        assertThat(warnings()).anySatisfy(line -> assertThat(line).contains("development password"));
        assertThat(String.join("\n", warnings())).doesNotContain(OWNER).doesNotContain("@");

        logs.list.clear();
        account(SeedAdmin.EMAIL, DEV_HASH);
        guard(SeedAdmin.EMAIL, "http://localhost:3000").run(new DefaultApplicationArguments());
        assertThat(warnings()).anySatisfy(line -> assertThat(line).contains("development password"));
        assertThat(String.join("\n", warnings()))
                .doesNotContain(SeedAdmin.EMAIL)
                .doesNotContain("@");
    }

    @Test
    void without_the_opt_in_the_dev_password_does_not_start_even_on_localhost_or_with_an_empty_SITE_URL() {
        account(SeedAdmin.EMAIL, DEV_HASH);

        for (String siteUrl : new String[] {null, "", "http://localhost:3000"}) {
            DevCredentialWarning closed = new DevCredentialWarning(
                    users,
                    encoder,
                    new AdminAccountProperties(SeedAdmin.EMAIL, null, null),
                    new ProductionMode(new GithubOAuthProperties(null, null, null, siteUrl, null), false));
            assertThatThrownBy(() -> closed.run(new DefaultApplicationArguments()))
                    .as(String.valueOf(siteUrl))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("ADMIN_PASSWORD");
        }
    }

    @Test
    void real_password_starts_silently_even_on_public_site() {
        account(SeedAdmin.EMAIL, REAL_HASH);

        assertThatCode(() -> guard(SeedAdmin.EMAIL, "https://blog.example.com").run(new DefaultApplicationArguments()))
                .doesNotThrowAnyException();
        assertThat(logs.list).isEmpty();
        // Control: the dev password really was tried on that row, not skipped.
        verify(encoder).matches(SeedAdmin.DEV_PASSWORD, REAL_HASH);
    }

    @Test
    void renamed_ADMIN_EMAIL_row_still_on_dev_password_is_also_blocked() {
        // AdminSeedEmail already renamed the seed row, but ADMIN_PASSWORD is not set: renaming the email is not enough.
        account(OWNER, DEV_HASH);

        assertThatThrownBy(() -> guard(OWNER, "https://blog.example.com").run(new DefaultApplicationArguments()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageNotContaining(OWNER);
    }

    @Test
    void remaining_admin_blog_local_row_with_dev_password_is_also_blocked_even_if_ADMIN_EMAIL_row_has_real_password() {
        // ADMIN_EMAIL already belongs to another account so the seed row cannot be renamed: it is still
        // admin@blog.local / admin12345.
        account(OWNER, REAL_HASH);
        account(SeedAdmin.EMAIL, DEV_HASH);

        assertThatThrownBy(() -> guard(OWNER, "https://blog.example.com").run(new DefaultApplicationArguments()))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void empty_ADMIN_EMAIL_still_checks_admin_blog_local_row() {
        account(SeedAdmin.EMAIL, DEV_HASH);

        assertThatThrownBy(() -> guard("", "https://blog.example.com").run(new DefaultApplicationArguments()))
                .isInstanceOf(IllegalStateException.class);
        verify(users, never()).findByEmail("");
    }

    @Test
    void account_without_password_or_nonexistent_has_nothing_to_block() {
        // An account that only logs in with GitHub (password_hash NULL): do not hand null to the encoder.
        account(OWNER, null);

        assertThatCode(() -> guard(OWNER, "https://blog.example.com").run(new DefaultApplicationArguments()))
                .doesNotThrowAnyException();
        verify(encoder, never()).matches(any(), isNull());
        assertThat(logs.list).isEmpty();
    }

    private void account(String email, String passwordHash) {
        User user = new User();
        user.setEmail(email);
        user.setPasswordHash(passwordHash);
        when(users.findByEmail(email)).thenReturn(Optional.of(user));
    }

    private DevCredentialWarning guard(String adminEmail, String siteUrl) {
        return new DevCredentialWarning(
                users,
                encoder,
                new AdminAccountProperties(adminEmail, null, null),
                new ProductionMode(new GithubOAuthProperties(null, null, null, siteUrl, null), true));
    }

    private List<String> warnings() {
        return logs.list.stream()
                .filter(event -> event.getLevel() == Level.WARN)
                .map(ILoggingEvent::getFormattedMessage)
                .toList();
    }
}
