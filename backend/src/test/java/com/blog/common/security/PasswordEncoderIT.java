package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.support.AbstractIntegrationTest;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.crypto.password.PasswordEncoder;

class PasswordEncoderIT extends AbstractIntegrationTest {

    private static final String DEV_PASSWORD = "admin12345";

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private UserRepository userRepository;

    @Test
    void encodesWithArgon2id() {
        String hash = passwordEncoder.encode(DEV_PASSWORD);

        // The prefix is the whole point: a project that silently fell back to bcrypt or
        // to NoOpPasswordEncoder would still pass a matches() assertion.
        assertThat(hash).startsWith("$argon2id$");
        assertThat(passwordEncoder.matches(DEV_PASSWORD, hash)).isTrue();
        assertThat(passwordEncoder.matches("wrong", hash)).isFalse();
    }

    @Test
    void seededAdminPasswordVerifies() {
        User admin = userRepository.findByEmail("admin@blog.local").orElseThrow();

        // Negative control first: the placeholder that V2 seeded must be gone, so this
        // test cannot pass against an unmigrated database.
        assertThat(admin.getPasswordHash()).isNotEqualTo("placeholder-set-during-auth-implementation");
        assertThat(admin.getPasswordHash()).startsWith("$argon2id$");
        assertThat(passwordEncoder.matches(DEV_PASSWORD, admin.getPasswordHash()))
                .isTrue();
        assertThat(passwordEncoder.matches("not-the-password", admin.getPasswordHash()))
                .isFalse();
    }
}
