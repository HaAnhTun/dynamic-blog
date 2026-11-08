package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

/**
 * Every request that can change something under {@code /api/v1/admin/**} leaves one line with the acting account, the method,
 * the path, the handler and the status; a read leaves none; and the line holds neither the token nor an address nor the
 * body. An administrator's or an author's write is attributable, a refused one is on record, and nothing had to remember to
 * log it.
 */
@AutoConfigureMockMvc
class AdminAuditLogIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthTestSupport auth;

    private static List<String> audit(LogCapture logs) {
        return logs.messages().stream()
                .filter(message -> message.startsWith("admin request"))
                .toList();
    }

    @Test
    void a_write_is_logged_with_who_what_and_how_it_ended_and_a_read_is_not() throws Exception {
        User admin = auth.createAccount("kiem-toan-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        String adminBearer = auth.bearerFor(admin);
        User reader = auth.createReader(auth.nextGithubId(), "kiem-toan-" + UUID.randomUUID());

        try (LogCapture logs = LogCapture.of(AdminAuditInterceptor.class)) {
            mockMvc.perform(get("/api/v1/admin/users").header("Authorization", adminBearer))
                    .andExpect(status().isOk());
            assertThat(audit(logs)).as("a read").isEmpty();

            mockMvc.perform(patch("/api/v1/admin/users/" + reader.getId() + "/status")
                            .header("Authorization", adminBearer)
                            .contentType(APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of("status", "SUSPENDED"))))
                    .andExpect(status().isOk());
            // A request that is refused or malformed is on record too, with the status it got.
            mockMvc.perform(patch("/api/v1/admin/users/" + reader.getId() + "/status")
                            .header("Authorization", adminBearer)
                            .contentType(APPLICATION_JSON)
                            .content("{\"status\":\"NOT_A_STATUS\"}"))
                    .andExpect(status().isBadRequest());

            assertThat(audit(logs))
                    .containsExactly(
                            "admin request actor=" + admin.getId() + " method=PATCH path=/api/v1/admin/users/"
                                    + reader.getId() + "/status handler=AdminUserController.setStatus status=200",
                            "admin request actor=" + admin.getId() + " method=PATCH path=/api/v1/admin/users/"
                                    + reader.getId() + "/status handler=AdminUserController.setStatus status=400");
            logs.assertNeverLogged(
                    adminBearer.substring("Bearer ".length()), admin.getEmail(), "SUSPENDED", "NOT_A_STATUS");
        }
    }

    @Test
    void an_author_write_names_the_author_and_a_query_string_is_never_logged() throws Exception {
        User author = auth.createAuthor("kiem-toan-tac-gia-" + UUID.randomUUID() + "@blog.local");

        try (LogCapture logs = LogCapture.of(AdminAuditInterceptor.class)) {
            mockMvc.perform(post("/api/v1/admin/posts")
                            .param("secretQuery", "do-not-log-this-search-text")
                            .header("Authorization", auth.bearerFor(author))
                            .contentType(APPLICATION_JSON)
                            .content("{\"title\":\"Bai kiem toan\",\"content\":\"noi dung\"}"))
                    .andExpect(status().isCreated());

            assertThat(audit(logs))
                    .singleElement()
                    .asString()
                    .startsWith("admin request actor=" + author.getId() + " method=POST path=/api/v1/admin/posts ")
                    .endsWith("status=201")
                    .doesNotContain("do-not-log-this-search-text")
                    .doesNotContain("Bai kiem toan");
        }
    }

    @Test
    void the_public_api_and_the_account_endpoints_are_not_part_of_it() throws Exception {
        try (LogCapture logs = LogCapture.of(AdminAuditInterceptor.class)) {
            mockMvc.perform(get("/api/v1/posts")).andExpect(status().isOk());
            mockMvc.perform(post("/api/v1/auth/logout")
                            .contentType(APPLICATION_JSON)
                            .content("{\"refreshToken\":\"khong-ton-tai\"}"))
                    .andReturn();

            assertThat(audit(logs)).isEmpty();
        }
    }
}
