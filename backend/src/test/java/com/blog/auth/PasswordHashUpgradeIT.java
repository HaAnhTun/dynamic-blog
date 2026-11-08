package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.auth.dto.LoginRequest;
import com.blog.auth.service.AuthService;
import com.blog.auth.service.FirstFactorResult;
import com.blog.common.exception.ApiException;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * A stored hash made with weaker Argon2 parameters is replaced by one with the current parameters when its owner signs in
 * with the right password, and only then: a wrong password, a suspension and a concurrent password change leave it alone.
 * The accounts are throw-away readers, so the seeded administrator keeps its state for the other classes.
 */
class PasswordHashUpgradeIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mot-mat-khau-dai-de-thu-nang-cap-hash";
    private static final Pattern MEMORY = Pattern.compile("[$]argon2id[$]v=19[$]m=([0-9]+),");

    @Autowired
    private AuthService authService;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private TransactionTemplate transactionTemplate;

    private User readerWithOldHash() {
        User user = auth.createAccount("nang-cap-" + UUID.randomUUID() + "@blog.local", UserRole.USER);
        String old = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8().encode(PASSWORD);
        jdbcTemplate.update("UPDATE users SET password_hash = ? WHERE id = ?", old, user.getId());
        return user;
    }

    private String hashOf(User user) {
        return jdbcTemplate.queryForObject("SELECT password_hash FROM users WHERE id = ?", String.class, user.getId());
    }

    private static int memoryOf(String hash) {
        Matcher matcher = MEMORY.matcher(hash);
        assertThat(matcher.find()).as("an Argon2id encoding").isTrue();
        return Integer.parseInt(matcher.group(1));
    }

    private static ClientAddress client(String address) {
        return ClientAddress.parse(address).orElseThrow();
    }

    @Test
    void a_successful_sign_in_replaces_a_hash_made_with_weaker_parameters() {
        User user = readerWithOldHash();
        String before = hashOf(user);
        assertThat(memoryOf(before)).isLessThan(19_456);
        String email = user.getEmail();

        FirstFactorResult result = authService.login(new LoginRequest(email, PASSWORD), client("203.0.113.71"));

        assertThat(result).isInstanceOf(FirstFactorResult.Session.class);
        String after = hashOf(user);
        assertThat(after).isNotEqualTo(before);
        assertThat(memoryOf(after)).isGreaterThanOrEqualTo(19_456);
        assertThat(passwordEncoder.matches(PASSWORD, after)).isTrue();
        assertThat(passwordEncoder.upgradeEncoding(after)).isFalse();
    }

    @Test
    void a_second_sign_in_does_not_rewrite_a_current_hash() {
        User user = readerWithOldHash();
        authService.login(new LoginRequest(user.getEmail(), PASSWORD), client("203.0.113.72"));
        String upgraded = hashOf(user);

        authService.login(new LoginRequest(user.getEmail(), PASSWORD), client("203.0.113.72"));

        assertThat(hashOf(user)).isEqualTo(upgraded);
    }

    @Test
    void a_failed_sign_in_leaves_the_stored_hash_unchanged() {
        User user = readerWithOldHash();
        String before = hashOf(user);

        assertThatThrownBy(() -> authService.login(
                        new LoginRequest(user.getEmail(), "mat-khau-sai-hoan-toan"), client("203.0.113.73")))
                .isInstanceOf(ApiException.class);

        assertThat(hashOf(user)).isEqualTo(before);
    }

    @Test
    void the_rewrite_never_overwrites_a_hash_that_changed_in_the_meantime() {
        User user = readerWithOldHash();
        String changed = passwordEncoder.encode("mat-khau-moi-vua-doi-xong-123");
        jdbcTemplate.update("UPDATE users SET password_hash = ? WHERE id = ?", changed, user.getId());

        Integer rows = transactionTemplate.execute(status ->
                userRepository.replacePasswordHash(user.getId(), "$argon2id$not-the-stored-hash", "$argon2id$x"));

        assertThat(rows).isZero();
        assertThat(hashOf(user)).isEqualTo(changed);
    }
}
