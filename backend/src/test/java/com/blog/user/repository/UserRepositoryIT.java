package com.blog.user.repository;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.support.AbstractIntegrationTest;
import com.blog.user.entity.UserRole;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class UserRepositoryIT extends AbstractIntegrationTest {

    @Autowired
    private UserRepository userRepository;

    @Test
    void seededAdminUserIsFoundByEmail() {
        var admin = userRepository.findByEmail("admin@blog.local");

        assertThat(admin).isPresent();
        assertThat(admin.get().getRole()).isEqualTo(UserRole.ADMIN);
        assertThat(admin.get().getDisplayName()).isEqualTo("Admin");
    }
}
