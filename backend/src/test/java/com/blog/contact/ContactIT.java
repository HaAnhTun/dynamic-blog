package com.blog.contact;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.newsletter.mail.MailFailure;
import com.blog.newsletter.mail.MailMessage;
import com.blog.newsletter.mail.MailMessage.Kind;
import com.blog.newsletter.mail.MailTransport;
import com.blog.newsletter.mail.MailTransportException;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogAssertions;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The contact form on a database of its own (V42): the public {@code POST /api/v1/contact/messages} and the ADMIN-only
 * inbox {@code /api/v1/admin/contact/**}. The table is cleared before every test, so counts and the newest-first order
 * can be checked exactly.
 *
 * {@code app.contact.recipient} is set and the transport is an in-process fake ({@link CapturingMailTransport},
 * {@code @Primary}): no mail leaves the machine. The case of an empty recipient is in ContactServiceTest and in the
 * SecurityMatrixIT row of the public endpoint (which runs with the default configuration).
 *
 * Every request goes through the real filter chain with a real token: the access rules are URL rules, and a test that
 * preset a SecurityContext would pass even if the rules were deleted.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import({AuthTestSupport.class, ContactIT.TestBeans.class})
@TestPropertySource(
        properties = {
            "app.oauth.github.client-id=",
            "app.oauth.github.client-secret=",
            "app.oauth.github.redirect-uri=",
            "app.oauth.github.site-url=http://localhost:3000",
            "app.admin.github-id=",
            "app.security.refresh-token-cleanup-cron=-",
            "app.newsletter.worker-enabled=false",
            "app.search.worker-enabled=false",
            "app.search.reconcile-cron=-",
            "app.contact.recipient=" + ContactIT.RECIPIENT
        })
class ContactIT {

    static final String RECIPIENT = "owner-inbox@example.com";
    private static final String PUBLIC = "/api/v1/contact/messages";
    private static final String ADMIN = "/api/v1/admin/contact/messages";
    private static final String UNREAD = "/api/v1/admin/contact/unread-count";
    private static final String TEXT = "Hello, I would like to ask about your latest article.";

    @DynamicPropertySource
    static void isolatedDatabase(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "contact_it");
    }

    /** Keeps every mail instead of sending it, or throws according to {@link #failure}. */
    static final class CapturingMailTransport implements MailTransport {
        final List<MailMessage> sent = new CopyOnWriteArrayList<>();
        volatile Function<MailMessage, MailFailure> failure = message -> null;

        @Override
        public void send(MailMessage message) {
            MailFailure failed = failure.apply(message);
            if (failed != null) {
                throw new MailTransportException(failed);
            }
            sent.add(message);
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class TestBeans {
        @Bean
        @Primary
        CapturingMailTransport capturingMailTransport() {
            return new CapturingMailTransport();
        }
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private CapturingMailTransport transport;

    private String admin;
    private String suffix;

    @BeforeEach
    void cleanSlate() {
        // The statement below deletes every contact message: only ever on this class's own DB.
        assertThat(jdbcTemplate.queryForObject("SELECT current_database()", String.class))
                .isEqualTo("contact_it");
        jdbcTemplate.update("DELETE FROM contact_messages");
        transport.sent.clear();
        transport.failure = message -> null;
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
    }

    // --- The public endpoint -----------------------------------------------------------------------------

    @Test
    void a_message_is_202_with_a_constant_body_stored_cleaned_and_mailed_once_and_nothing_private_is_logged()
            throws Exception {
        String email = address("visitor");
        String name = "Visitor " + suffix;
        String subject = "Question " + suffix;
        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            ResultActions result = send(Map.of(
                    "name", "  " + name + "\r\n",
                    "email", "  " + email.toUpperCase() + " ",
                    "subject", subject + "\nBcc: attacker@example.com",
                    "message", "  " + TEXT + "\r\nSecond line  ",
                    "locale", "vi"));

            assertThat(result.andReturn().getResponse().getStatus()).isEqualTo(202);
            assertThat(result.andReturn().getResponse().getContentAsString())
                    .isEqualTo("{\"data\":{\"status\":\"RECEIVED\"}}");

            Map<String, Object> row = jdbcTemplate.queryForMap("SELECT * FROM contact_messages");
            assertThat(row.get("name")).isEqualTo(name);
            assertThat(row.get("email")).isEqualTo(email);
            assertThat(row.get("subject")).isEqualTo(subject + "Bcc: attacker@example.com");
            assertThat(row.get("message")).isEqualTo(TEXT + "\nSecond line");
            assertThat(row.get("locale")).isEqualTo("vi");
            assertThat(row.get("read_at")).isNull();
            assertThat(row.get("created_at")).isNotNull();

            assertThat(transport.sent).hasSize(1);
            MailMessage mail = transport.sent.getFirst();
            assertThat(mail.kind()).isEqualTo(Kind.CONTACT);
            assertThat(mail.id()).isEqualTo(row.get("id"));
            assertThat(mail.to()).isEqualTo(RECIPIENT);
            assertThat(mail.replyTo()).isEqualTo(email);
            assertThat(mail.subject()).isEqualTo("Contact: " + subject + "Bcc: attacker@example.com");
            assertThat(mail.body()).contains(name, email, "Locale: vi", TEXT + "\nSecond line");
            assertThat(mail.listUnsubscribe()).isNull();
        } finally {
            releaseLogs(logs);
        }
        LogAssertions.assertNoValues(logs.list, name, email, subject, TEXT, "Second line");
    }

    @Test
    void subject_and_locale_are_optional() throws Exception {
        String email = address("minimal");

        assertThat(statusOf(send(Map.of("name", "Minimal", "email", email, "message", TEXT))))
                .isEqualTo(202);
        assertThat(statusOf(send(Map.of("name", "Empty", "email", address("empty"), "subject", "", "message", TEXT))))
                .isEqualTo(202);

        assertThat(jdbcTemplate.queryForList("SELECT subject, locale FROM contact_messages"))
                .allSatisfy(row -> {
                    assertThat(row.get("subject")).isNull();
                    assertThat(row.get("locale")).isNull();
                });
        assertThat(transport.sent)
                .extracting(MailMessage::subject)
                .containsOnly("Contact: new message from the contact form");
    }

    @Test
    void a_mail_failure_keeps_the_row_answers_202_and_logs_only_the_id_and_a_code() throws Exception {
        transport.failure = message -> MailFailure.CONNECTION_FAILED;
        String email = address("unlucky");
        String name = "Unlucky " + suffix;
        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            assertThat(statusOf(send(Map.of("name", name, "email", email, "message", TEXT))))
                    .isEqualTo(202);
        } finally {
            releaseLogs(logs);
        }

        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM contact_messages", Integer.class))
                .isEqualTo(1);
        UUID id = jdbcTemplate.queryForObject("SELECT id FROM contact_messages", UUID.class);
        assertThat(logs.list)
                .extracting(ILoggingEvent::getFormattedMessage)
                .contains("contact mail not sent: id=" + id + " code=CONNECTION_FAILED");
        LogAssertions.assertNoValues(logs.list, name, email, TEXT);
    }

    @Test
    void every_bad_field_is_400_validation_error_and_stores_nothing() throws Exception {
        String email = address("bad");
        List<Map<String, Object>> bad = new ArrayList<>();
        bad.add(Map.of("email", email, "message", TEXT));
        bad.add(Map.of("name", "   ", "email", email, "message", TEXT));
        bad.add(Map.of("name", "n".repeat(101), "email", email, "message", TEXT));
        bad.add(Map.of("name", "Bad", "message", TEXT));
        bad.add(Map.of("name", "Bad", "email", "not-an-address", "message", TEXT));
        bad.add(Map.of("name", "Bad", "email", email, "subject", "s".repeat(151), "message", TEXT));
        bad.add(Map.of("name", "Bad", "email", email));
        bad.add(Map.of("name", "Bad", "email", email, "message", "short"));
        bad.add(Map.of("name", "Bad", "email", email, "message", "m".repeat(5001)));
        bad.add(Map.of("name", "Bad", "email", email, "message", TEXT, "locale", "de"));
        bad.add(Map.of("name", List.of("a"), "email", email, "message", TEXT));

        for (Map<String, Object> body : bad) {
            assertError(send(body), 400, "VALIDATION_ERROR");
        }
        assertError(
                mockMvc.perform(post(PUBLIC).contentType(APPLICATION_JSON).content("{not json")),
                400,
                "VALIDATION_ERROR");
        assertError(mockMvc.perform(post(PUBLIC).contentType(APPLICATION_JSON).content("")), 400, "VALIDATION_ERROR");

        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM contact_messages", Integer.class))
                .isZero();
        assertThat(transport.sent).isEmpty();
    }

    @Test
    void the_sixth_message_of_an_address_in_one_hour_is_429_whatever_the_case_and_other_addresses_are_not_affected()
            throws Exception {
        String email = address("chatty");
        for (int i = 0; i < 5; i++) {
            String variant = i % 2 == 0 ? email : email.toUpperCase();
            assertThat(statusOf(send(Map.of("name", "Chatty", "email", variant, "message", TEXT + i))))
                    .isEqualTo(202);
        }

        assertError(send(Map.of("name", "Chatty", "email", email, "message", TEXT + "again")), 429, "RATE_LIMITED");
        assertError(
                send(Map.of("name", "Chatty", "email", email.toUpperCase(), "message", TEXT + "again")),
                429,
                "RATE_LIMITED");
        assertThat(statusOf(send(Map.of("name", "Other", "email", address("other"), "message", TEXT))))
                .isEqualTo(202);

        assertThat(count("SELECT count(*) FROM contact_messages WHERE lower(email) = ?", email))
                .isEqualTo(5);
        // The refused message was neither stored nor mailed: five for the chatty address and one for the other.
        assertThat(transport.sent).hasSize(6);
    }

    @Test
    void messages_older_than_one_hour_do_not_count() throws Exception {
        String email = address("patient");
        for (int i = 0; i < 5; i++) {
            send(Map.of("name", "Patient", "email", email, "message", TEXT + i));
        }
        assertError(send(Map.of("name", "Patient", "email", email, "message", TEXT)), 429, "RATE_LIMITED");

        jdbcTemplate.update(
                "UPDATE contact_messages SET created_at = now() - interval '61 minutes' WHERE lower(email) = ?", email);

        assertThat(statusOf(send(Map.of("name", "Patient", "email", email, "message", TEXT))))
                .isEqualTo(202);
    }

    @Test
    void parallel_requests_of_one_address_cannot_slip_past_the_limit() throws Exception {
        String email = address("parallel");
        int requests = 14;
        ExecutorService pool = Executors.newFixedThreadPool(requests);
        try {
            List<Future<Integer>> answers = new ArrayList<>();
            for (int i = 0; i < requests; i++) {
                String text = TEXT + i;
                answers.add(
                        pool.submit(() -> statusOf(send(Map.of("name", "Parallel", "email", email, "message", text)))));
            }
            List<Integer> statuses = new ArrayList<>();
            for (Future<Integer> answer : answers) {
                statuses.add(answer.get(30, TimeUnit.SECONDS));
            }
            assertThat(statuses.stream().filter(s -> s == 202).count()).isEqualTo(5);
            assertThat(statuses.stream().filter(s -> s == 429).count()).isEqualTo(requests - 5);
        } finally {
            pool.shutdownNow();
        }
        assertThat(count("SELECT count(*) FROM contact_messages WHERE lower(email) = ?", email))
                .isEqualTo(5);
    }

    @Test
    void the_table_itself_refuses_values_outside_the_documented_lengths() {
        assertThatThrownBy(() -> insert("", "visitor@example.com", null, TEXT))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> insert("n".repeat(101), "visitor@example.com", null, TEXT))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> insert("Name", "e".repeat(255), null, TEXT))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> insert("Name", "visitor@example.com", "s".repeat(151), TEXT))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> insert("Name", "visitor@example.com", null, "too short"))
                .isInstanceOf(DataIntegrityViolationException.class);
        insert("n".repeat(100), "visitor@example.com", "s".repeat(150), "m".repeat(10));
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM contact_messages", Integer.class))
                .isEqualTo(1);
    }

    // --- The admin inbox ---------------------------------------------------------------------------------

    @Test
    void the_inbox_lists_newest_first_in_pages_with_the_project_envelope_and_the_unread_count() throws Exception {
        List<UUID> ids = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            UUID id = UUID.randomUUID();
            ids.add(id);
            jdbcTemplate.update(
                    """
                    INSERT INTO contact_messages (id, name, email, subject, message, locale, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, now() - ? * interval '1 minute')""",
                    id,
                    "Name " + i,
                    "visitor" + i + "@example.com",
                    i == 1 ? null : "Subject " + i,
                    "Message number " + i + " with enough text",
                    i == 2 ? null : "en",
                    10 - i);
        }

        JsonNode first =
                readJson(get(ADMIN).param("page", "0").param("size", "2").header("Authorization", admin), 200);
        assertThat(first.path("data")).hasSize(2);
        assertThat(first.path("data").get(0).path("id").asString())
                .isEqualTo(ids.get(2).toString());
        assertThat(first.path("data").get(1).path("id").asString())
                .isEqualTo(ids.get(1).toString());
        assertThat(first.path("pagination").path("page").asInt()).isZero();
        assertThat(first.path("pagination").path("size").asInt()).isEqualTo(2);
        assertThat(first.path("pagination").path("totalElements").asInt()).isEqualTo(3);
        assertThat(first.path("pagination").path("totalPages").asInt()).isEqualTo(2);

        JsonNode item = first.path("data").get(0);
        assertThat(item.propertyNames())
                .containsExactlyInAnyOrder(
                        "id", "name", "email", "subject", "message", "locale", "createdAt", "readAt");
        assertThat(item.path("name").asString()).isEqualTo("Name 2");
        assertThat(item.path("email").asString()).isEqualTo("visitor2@example.com");
        assertThat(item.path("subject").asString()).isEqualTo("Subject 2");
        assertThat(item.path("locale").isNull()).isTrue();
        assertThat(item.path("readAt").isNull()).isTrue();
        assertThat(OffsetDateTime.parse(item.path("createdAt").asString())).isNotNull();
        assertThat(first.path("data").get(1).path("subject").isNull()).isTrue();

        JsonNode second =
                readJson(get(ADMIN).param("page", "1").param("size", "2").header("Authorization", admin), 200);
        assertThat(second.path("data")).hasSize(1);
        assertThat(second.path("data").get(0).path("id").asString())
                .isEqualTo(ids.get(0).toString());

        assertThat(readJson(get(UNREAD).header("Authorization", admin), 200)
                        .path("data")
                        .path("count")
                        .asInt())
                .isEqualTo(3);
        // Defaults, and an oversized or negative request is clamped rather than refused.
        assertThat(readJson(get(ADMIN).header("Authorization", admin), 200)
                        .path("pagination")
                        .path("size")
                        .asInt())
                .isEqualTo(20);
        JsonNode clamped = readJson(
                        get(ADMIN).param("size", "100000").param("page", "-4").header("Authorization", admin), 200)
                .path("pagination");
        assertThat(clamped.path("size").asInt()).isEqualTo(100);
        assertThat(clamped.path("page").asInt()).isZero();
    }

    @Test
    void reading_is_idempotent_204_keeps_the_first_read_time_and_lowers_the_unread_count() throws Exception {
        UUID id = storeThroughApi("reader");
        UUID other = storeThroughApi("unread");
        assertThat(unreadCount()).isEqualTo(2);

        assertThat(status(post(ADMIN + "/" + id + "/read").header("Authorization", admin)))
                .isEqualTo(204);
        OffsetDateTime firstRead = readAt(id);
        assertThat(firstRead).isNotNull();
        assertThat(unreadCount()).isEqualTo(1);

        assertThat(status(post(ADMIN + "/" + id + "/read").header("Authorization", admin)))
                .isEqualTo(204);
        assertThat(readAt(id)).isEqualTo(firstRead);
        assertThat(readAt(other)).isNull();
        assertThat(unreadCount()).isEqualTo(1);

        JsonNode list = readJson(get(ADMIN).header("Authorization", admin), 200);
        for (JsonNode item : list.path("data")) {
            boolean isRead = item.path("id").asString().equals(id.toString());
            assertThat(item.path("readAt").isNull()).isEqualTo(!isRead);
        }
    }

    @Test
    void deleting_is_204_once_and_an_unknown_id_is_404_for_delete_and_read() throws Exception {
        UUID id = storeThroughApi("goner");

        assertThat(status(delete(ADMIN + "/" + id).header("Authorization", admin)))
                .isEqualTo(204);
        assertThat(count("SELECT count(*) FROM contact_messages WHERE id = ?", id))
                .isZero();

        assertError(
                mockMvc.perform(delete(ADMIN + "/" + id).header("Authorization", admin)),
                404,
                "CONTACT_MESSAGE_NOT_FOUND");
        assertError(
                mockMvc.perform(post(ADMIN + "/" + UUID.randomUUID() + "/read").header("Authorization", admin)),
                404,
                "CONTACT_MESSAGE_NOT_FOUND");
        // An id that is not a UUID is a malformed request, like every other admin path with an id.
        assertError(
                mockMvc.perform(delete(ADMIN + "/not-a-uuid").header("Authorization", admin)), 400, "VALIDATION_ERROR");
    }

    @Test
    void only_an_admin_may_use_the_inbox_anonymous_is_401_and_an_author_or_reader_is_403() throws Exception {
        UUID id = storeThroughApi("guarded");
        User author = auth.createAuthor("contact-author-" + suffix + "@example.com");
        User reader = auth.createAccount("contact-reader-" + suffix + "@example.com", UserRole.USER);
        List<Function<String, MockHttpServletRequestBuilder>> requests = List.of(
                token -> withToken(get(ADMIN), token),
                token -> withToken(get(UNREAD), token),
                token -> withToken(post(ADMIN + "/" + id + "/read"), token),
                token -> withToken(delete(ADMIN + "/" + id), token));

        for (Function<String, MockHttpServletRequestBuilder> request : requests) {
            assertError(mockMvc.perform(request.apply(null)), 401, "UNAUTHENTICATED");
            assertError(mockMvc.perform(request.apply(auth.bearerFor(author))), 403, "FORBIDDEN");
            assertError(mockMvc.perform(request.apply(auth.bearerFor(reader))), 403, "FORBIDDEN");
        }

        // Nothing was read or deleted by the refused calls.
        assertThat(count("SELECT count(*) FROM contact_messages WHERE id = ? AND read_at IS NULL", id))
                .isEqualTo(1);
    }

    @Test
    void the_public_path_has_no_other_method_and_the_inbox_is_not_public() throws Exception {
        assertError(mockMvc.perform(get(PUBLIC)), 401, "UNAUTHENTICATED");
        assertError(mockMvc.perform(delete(PUBLIC)), 401, "UNAUTHENTICATED");
        assertError(mockMvc.perform(post(ADMIN).contentType(APPLICATION_JSON).content("{}")), 401, "UNAUTHENTICATED");
    }

    // --- Helpers -----------------------------------------------------------------------------------------

    private ResultActions send(Map<String, Object> body) throws Exception {
        return mockMvc.perform(
                post(PUBLIC).contentType(APPLICATION_JSON).content(objectMapper.writeValueAsString(body)));
    }

    private UUID storeThroughApi(String stem) throws Exception {
        String email = address(stem);
        assertThat(statusOf(send(Map.of("name", "Name " + stem, "email", email, "message", TEXT))))
                .isEqualTo(202);
        return jdbcTemplate.queryForObject("SELECT id FROM contact_messages WHERE email = ?", UUID.class, email);
    }

    private void insert(String name, String email, String subject, String message) {
        jdbcTemplate.update(
                "INSERT INTO contact_messages (id, name, email, subject, message) VALUES (?, ?, ?, ?, ?)",
                UUID.randomUUID(),
                name,
                email,
                subject,
                message);
    }

    private String address(String stem) {
        return "contact-" + stem + "-" + suffix + "@example.com";
    }

    private int statusOf(ResultActions result) {
        return result.andReturn().getResponse().getStatus();
    }

    private int status(MockHttpServletRequestBuilder request) throws Exception {
        return mockMvc.perform(request).andReturn().getResponse().getStatus();
    }

    private JsonNode readJson(MockHttpServletRequestBuilder request, int expectedStatus) throws Exception {
        MockHttpServletResponse response = mockMvc.perform(request).andReturn().getResponse();
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(expectedStatus);
        return objectMapper.readTree(response.getContentAsString());
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        MockHttpServletResponse response = result.andReturn().getResponse();
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(status);
        assertThat(objectMapper
                        .readTree(response.getContentAsString())
                        .path("error")
                        .path("code")
                        .asString())
                .as(response.getContentAsString())
                .isEqualTo(code);
    }

    private static MockHttpServletRequestBuilder withToken(MockHttpServletRequestBuilder request, String token) {
        return token == null ? request : request.header("Authorization", token);
    }

    private int unreadCount() throws Exception {
        return readJson(get(UNREAD).header("Authorization", admin), 200)
                .path("data")
                .path("count")
                .asInt();
    }

    private OffsetDateTime readAt(UUID id) {
        return jdbcTemplate.queryForObject(
                "SELECT read_at FROM contact_messages WHERE id = ?", OffsetDateTime.class, id);
    }

    private int count(String sql, Object argument) {
        Integer total = jdbcTemplate.queryForObject(sql, Integer.class, argument);
        return total == null ? 0 : total;
    }

    private static ListAppender<ILoggingEvent> captureLogs() {
        Logger root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        return logs;
    }

    private static void releaseLogs(ListAppender<ILoggingEvent> logs) {
        ((Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME)).detachAppender(logs);
    }
}
