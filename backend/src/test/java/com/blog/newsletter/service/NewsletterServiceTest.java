package com.blog.newsletter.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.I18nProperties;
import com.blog.common.i18n.Languages;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.newsletter.repository.NewsletterRepository;
import com.blog.newsletter.repository.NewsletterRepository.Subscriber;
import com.blog.support.RateLimitTestProperties;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;

/**
 * The newsletter limits without a database: a signup is counted against the client address, the submitted address and the
 * whole site, none of it visible to the caller; confirm is counted against the client address and the whole site before the
 * token is looked at, unsubscribe against the client address only (a stray token must never block a real unsubscribe). The
 * SQL and the token rules are proved in NewsletterIT.
 */
class NewsletterServiceTest {

    private static final Instant NOW = Instant.parse("2026-03-04T10:15:30Z");
    private static final ClientAddress CLIENT =
            ClientAddress.parse("203.0.113.9").orElseThrow();
    private static final ClientAddress OTHER =
            ClientAddress.parse("203.0.113.10").orElseThrow();
    /** Shaped like a real token (43 characters of base64url), but not one that exists. */
    private static final String TOKEN = "A".repeat(43);

    private final NewsletterRepository repository = mock(NewsletterRepository.class);
    private final NewsletterTokens tokens = new NewsletterTokens("k".repeat(32).getBytes(StandardCharsets.UTF_8));
    private final Languages languages = new Languages(new I18nProperties(List.of("vi", "en"), "vi"));
    private final Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);

    private NewsletterService service(Map<String, String> limits) {
        return new NewsletterService(
                repository, tokens, new RateLimiter(RateLimitTestProperties.with(limits)), languages, clock);
    }

    private int queued() {
        ArgumentCaptor<String> emails = ArgumentCaptor.forClass(String.class);
        verify(repository, atLeast(0)).requestConfirmation(emails.capture(), anyString(), any());
        return emails.getAllValues().size();
    }

    @Test
    void many_different_addresses_from_one_client_queue_at_most_the_client_limit_and_all_answer_alike() {
        NewsletterService service = service(Map.of("newsletter-signup-client.per-hour", "3"));

        for (int i = 0; i < 10; i++) {
            // None of the ten calls throws: the caller cannot tell a queued signup from a refused one.
            int n = i;
            assertThatCode(() -> service.subscribe("reader+" + n + "@example.com", "en", CLIENT))
                    .doesNotThrowAnyException();
        }

        assertThat(queued()).isEqualTo(3);
    }

    @Test
    void another_client_address_still_queues_its_own_signups() {
        NewsletterService service = service(Map.of("newsletter-signup-client.per-hour", "2"));
        for (int i = 0; i < 5; i++) {
            service.subscribe("first+" + i + "@example.com", null, CLIENT);
        }
        for (int i = 0; i < 5; i++) {
            service.subscribe("second+" + i + "@example.com", null, OTHER);
        }

        assertThat(queued()).isEqualTo(4);
    }

    @Test
    void one_address_submitted_from_many_clients_is_still_limited_per_address() {
        NewsletterService service = service(Map.of());
        for (int i = 0; i < 8; i++) {
            service.subscribe(
                    "same@example.com",
                    "vi",
                    ClientAddress.parse("198.51.100." + (i + 1)).orElseThrow());
        }

        // The default is 3 per address and hour, whoever asks.
        assertThat(queued()).isEqualTo(3);
    }

    @Test
    void the_whole_site_has_a_ceiling_on_queued_confirmations_that_many_clients_together_cannot_pass() {
        NewsletterService service = service(Map.of("newsletter-signup-global.per-hour", "4"));
        for (int i = 0; i < 10; i++) {
            service.subscribe(
                    "reader+" + i + "@example.com",
                    "en",
                    ClientAddress.parse("198.51.100." + (i + 1)).orElseThrow());
        }

        assertThat(queued()).isEqualTo(4);
    }

    @Test
    void a_signup_refused_for_its_address_does_not_use_up_a_turn_of_the_whole_site_ceiling() {
        NewsletterService service =
                service(Map.of("newsletter-signup.per-hour", "1", "newsletter-signup-global.per-hour", "2"));

        service.subscribe("a@example.com", "en", CLIENT);
        // Refused for the address (1 per hour): it must not count as one of the two queued mails of the site.
        service.subscribe("a@example.com", "en", OTHER);
        service.subscribe("b@example.com", "en", OTHER);
        service.subscribe("c@example.com", "en", OTHER);

        assertThat(queued()).isEqualTo(2);
        verify(repository).requestConfirmation(eq("a@example.com"), anyString(), any());
        verify(repository).requestConfirmation(eq("b@example.com"), anyString(), any());
        verify(repository, never()).requestConfirmation(eq("c@example.com"), anyString(), any());
    }

    @Test
    void a_bad_address_is_400_and_uses_no_turn() {
        NewsletterService service = service(Map.of("newsletter-signup-client.per-hour", "1"));

        for (int i = 0; i < 5; i++) {
            assertThatThrownBy(() -> service.subscribe("not-an-address", "en", CLIENT))
                    .isInstanceOfSatisfying(
                            ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR));
        }
        service.subscribe("good@example.com", "en", CLIENT);

        assertThat(queued()).isEqualTo(1);
    }

    @Test
    void confirm_is_counted_against_the_client_address_before_the_token_is_looked_at() {
        NewsletterService service = service(Map.of("newsletter-token-client.per-hour", "2"));

        for (int i = 0; i < 2; i++) {
            assertThatThrownBy(() -> service.confirm("not-a-token", CLIENT))
                    .isInstanceOfSatisfying(
                            ApiException.class,
                            e -> assertThat(e.getCode()).isEqualTo(ErrorCode.NEWSLETTER_TOKEN_INVALID));
        }
        assertThatThrownBy(() -> service.confirm(TOKEN, CLIENT)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED);
            assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        });
        verifyNoInteractions(repository);

        // Another client address is not affected.
        assertThatThrownBy(() -> service.confirm("not-a-token", OTHER))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.NEWSLETTER_TOKEN_INVALID));
    }

    @Test
    void unsubscribe_is_counted_against_the_same_client_address_quota_as_confirm() {
        NewsletterService service = service(Map.of("newsletter-token-client.per-hour", "2"));

        assertThatThrownBy(() -> service.confirm("not-a-token", CLIENT)).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> service.unsubscribe("not-a-token", CLIENT))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.NEWSLETTER_TOKEN_INVALID));
        assertThatThrownBy(() -> service.unsubscribe("not-a-token", CLIENT))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED));
    }

    @Test
    void the_whole_site_has_a_ceiling_on_confirmations() {
        NewsletterService service = service(Map.of("newsletter-confirm-global.per-hour", "3"));

        for (int i = 0; i < 3; i++) {
            assertThatThrownBy(() -> service.confirm(
                            "not-a-token",
                            ClientAddress.parse("198.51.100." + 1).orElseThrow()))
                    .isInstanceOfSatisfying(
                            ApiException.class,
                            e -> assertThat(e.getCode()).isEqualTo(ErrorCode.NEWSLETTER_TOKEN_INVALID));
        }

        assertThatThrownBy(() -> service.confirm("not-a-token", OTHER))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED));
        verify(repository, times(0)).confirm(any(), any());
    }

    @Test
    void garbage_confirm_and_unsubscribe_tokens_from_many_clients_cannot_block_a_real_unsubscribe() {
        // A tight whole-site confirm ceiling, so the flood below would use up any shared budget many times over.
        NewsletterService service = service(Map.of("newsletter-confirm-global.per-hour", "3"));
        UUID subscriberId = UUID.randomUUID();
        String email = "reader@example.com";
        when(repository.lockSubscriber(subscriberId))
                .thenReturn(Optional.of(new Subscriber(subscriberId, email, "en")));

        for (int i = 0; i < 30; i++) {
            ClientAddress flooder = ClientAddress.parse("198.51.100." + (i + 1)).orElseThrow();
            assertThatThrownBy(() -> service.confirm("not-a-token", flooder)).isInstanceOf(ApiException.class);
            // Never a 429 for a stray unsubscribe token: it is simply invalid.
            assertThatThrownBy(() -> service.unsubscribe("not-a-token", flooder))
                    .isInstanceOfSatisfying(
                            ApiException.class,
                            e -> assertThat(e.getCode()).isEqualTo(ErrorCode.NEWSLETTER_TOKEN_INVALID));
        }

        // A real unsubscribe from a fresh address is still honored: one-click unsubscribes of mail providers included.
        service.unsubscribe(
                tokens.unsubscribeToken(subscriberId),
                ClientAddress.parse("203.0.113.77").orElseThrow());

        verify(repository).suppress(eq(tokens.suppressionHash(email)), any());
        verify(repository).deleteSubscriber(subscriberId);
    }

    @Test
    void unsubscribes_do_not_use_up_the_whole_site_confirm_ceiling() {
        NewsletterService service = service(Map.of("newsletter-confirm-global.per-hour", "2"));

        for (int i = 0; i < 20; i++) {
            ClientAddress client = ClientAddress.parse("198.51.100." + (i + 1)).orElseThrow();
            assertThatThrownBy(() -> service.unsubscribe("not-a-token", client)).isInstanceOf(ApiException.class);
        }

        // The first confirmation of the hour still gets as far as the token lookup.
        assertThatThrownBy(() -> service.confirm(TOKEN, OTHER))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.NEWSLETTER_TOKEN_INVALID));
        verify(repository).lockPendingByTokenHash(NewsletterTokens.sha256Hex(TOKEN));
    }
}
