package com.blog.common.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import java.time.Duration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * Rate limit configuration at startup: the {@code app.rate-limit.*} keys, the default values
 * when nothing is set (application.yml deliberately does not list them), and the path from the keys to the real RateLimiter and
 * LoginConcurrencyLimiter.
 *
 * ApplicationContextRunner, no DB: only RateLimitConfig and the two limiters are built, as when the application starts.
 */
class RateLimitConfigTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(RateLimitConfig.class)
            .withBean(RateLimiter.class)
            .withBean(LoginConcurrencyLimiter.class);

    @Test
    void nothing_set_uses_the_design_defaults() {
        runner.run(context -> {
            assertThat(context).hasNotFailed();
            RateLimitProperties properties = context.getBean(RateLimitProperties.class);
            assertThat(properties.comment().perMinute()).isEqualTo(5);
            assertThat(properties.comment().perHour()).isEqualTo(30);
            assertThat(properties.commentEdit().perTenMinutes()).isEqualTo(20);
            assertThat(properties.like().perMinute()).isEqualTo(30);
            // Two password checks at once, waiting at most 5 seconds.
            assertThat(properties.login().concurrent()).isEqualTo(2);
            assertThat(properties.login().maxWait()).isEqualTo(Duration.ofSeconds(5));
            assertThat(context.getBean(LoginConcurrencyLimiter.class).availablePermits())
                    .isEqualTo(2);
            assertThat(properties.roleChange().perTenMinutes()).isEqualTo(20);
            assertThat(properties.authorApplication().perHour()).isEqualTo(5);
            assertThat(properties.bookmark().perMinute()).isEqualTo(30);
            assertThat(properties.newsletterSignup().perHour()).isEqualTo(3);
            assertThat(properties.newsletterToken().perHour()).isEqualTo(20);
            assertThat(properties.siteContentWrite().perTenMinutes()).isEqualTo(60);
            assertThat(properties.postImportWrite().perTenMinutes()).isEqualTo(60);
            assertThat(properties.articlePreview().perTenMinutes()).isEqualTo(300);
            assertThat(properties.contactClient().perHour()).isEqualTo(5);
            assertThat(properties.contactGlobal().perHour()).isEqualTo(60);
            assertThat(properties.newsletterSignupClient().perHour()).isEqualTo(5);
            assertThat(properties.newsletterSignupGlobal().perHour()).isEqualTo(120);
            assertThat(properties.newsletterTokenClient().perHour()).isEqualTo(40);
            assertThat(properties.newsletterConfirmGlobal().perHour()).isEqualTo(300);
            assertThat(properties.loginClient().perTenMinutes()).isEqualTo(20);
            assertThat(properties.refreshClient().perTenMinutes()).isEqualTo(60);
            assertThat(properties.setupClient().perMinute()).isEqualTo(5);
            assertThat(properties.searchClient().perMinute()).isEqualTo(120);
        });
    }

    @Test
    void keys_of_the_client_address_limits_reach_RateLimiter_and_zero_stops_the_start() {
        runner.withPropertyValues(
                        "app.rate-limit.contact-client.per-hour=2",
                        "app.rate-limit.login-client.per-ten-minutes=1",
                        "app.rate-limit.search-client.per-minute=3")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    RateLimiter limiter = context.getBean(RateLimiter.class);
                    assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113.9"))
                            .isTrue();
                    assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113.9"))
                            .isTrue();
                    assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113.9"))
                            .isFalse();
                    assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "203.0.113.9"))
                            .isTrue();
                    assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "203.0.113.9"))
                            .isFalse();
                });
        runner.withPropertyValues("app.rate-limit.contact-global.per-hour=0")
                .run(context -> assertThat(context)
                        .hasFailed()
                        .getFailure()
                        .hasStackTraceContaining("app.rate-limit.contact-global.per-hour"));
    }

    @Test
    void key_app_rate_limit_post_import_write_reaches_RateLimiter() {
        runner.withPropertyValues("app.rate-limit.post-import-write.per-ten-minutes=2")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(RateLimitProperties.class)
                                    .postImportWrite()
                                    .perTenMinutes())
                            .isEqualTo(2);

                    RateLimiter limiter = context.getBean(RateLimiter.class);
                    UUID user = UUID.randomUUID();
                    limiter.check(RateLimiter.POST_IMPORT_WRITE, user);
                    limiter.check(RateLimiter.POST_IMPORT_WRITE, user);
                    assertThatThrownBy(() -> limiter.check(RateLimiter.POST_IMPORT_WRITE, user))
                            .isInstanceOf(ApiException.class);
                    // The site content bucket of the same person is a different count.
                    limiter.check(RateLimiter.SITE_CONTENT_WRITE, user);
                });
    }

    @Test
    void key_app_rate_limit_article_preview_reaches_RateLimiter() {
        runner.withPropertyValues("app.rate-limit.article-preview.per-ten-minutes=2")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(RateLimitProperties.class)
                                    .articlePreview()
                                    .perTenMinutes())
                            .isEqualTo(2);

                    RateLimiter limiter = context.getBean(RateLimiter.class);
                    UUID user = UUID.randomUUID();
                    limiter.check(RateLimiter.ARTICLE_PREVIEW, user);
                    limiter.check(RateLimiter.ARTICLE_PREVIEW, user);
                    assertThatThrownBy(() -> limiter.check(RateLimiter.ARTICLE_PREVIEW, user))
                            .isInstanceOf(ApiException.class);
                    // The previews, applies and undos of the same person are a different count.
                    limiter.check(RateLimiter.POST_IMPORT_WRITE, user);
                });
    }

    @Test
    void key_app_rate_limit_login_reaches_LoginConcurrencyLimiter() {
        runner.withPropertyValues("app.rate-limit.login.concurrent=3", "app.rate-limit.login.max-wait=250ms")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    RateLimitProperties properties = context.getBean(RateLimitProperties.class);
                    assertThat(properties.login().maxWait()).isEqualTo(Duration.ofMillis(250));
                    assertThat(context.getBean(LoginConcurrencyLimiter.class).availablePermits())
                            .isEqualTo(3);
                });
    }

    @Test
    void key_app_rate_limit_reaches_RateLimiter() {
        runner.withPropertyValues(
                        "app.rate-limit.comment.per-minute=1",
                        "app.rate-limit.comment-edit.per-ten-minutes=2",
                        "app.rate-limit.like.per-minute=3")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    RateLimitProperties properties = context.getBean(RateLimitProperties.class);
                    // A key not set in the same group keeps its default.
                    assertThat(properties.comment().perHour()).isEqualTo(30);

                    RateLimiter limiter = context.getBean(RateLimiter.class);
                    UUID user = UUID.randomUUID();
                    limiter.check(RateLimiter.COMMENT, user);
                    assertThatThrownBy(() -> limiter.check(RateLimiter.COMMENT, user))
                            .isInstanceOf(ApiException.class);
                    limiter.check(RateLimiter.COMMENT_EDIT, user);
                    limiter.check(RateLimiter.COMMENT_EDIT, user);
                    assertThatThrownBy(() -> limiter.check(RateLimiter.COMMENT_EDIT, user))
                            .isInstanceOf(ApiException.class);
                });
    }

    @Test
    void non_positive_limit_makes_the_application_fail_to_start() {
        for (String invalid : new String[] {
            "app.rate-limit.comment.per-minute=0",
            "app.rate-limit.comment.per-hour=-1",
            "app.rate-limit.comment-edit.per-ten-minutes=0",
            "app.rate-limit.like.per-minute=0",
            "app.rate-limit.post-import-write.per-ten-minutes=0",
            "app.rate-limit.article-preview.per-ten-minutes=0",
            "app.rate-limit.post-write.per-ten-minutes=0",
            "app.rate-limit.taxonomy-create.per-hour=0",
            "app.rate-limit.media-upload.per-ten-minutes=0",
            "app.rate-limit.login.concurrent=0",
            "app.rate-limit.login.max-wait=0s"
        }) {
            runner.withPropertyValues(invalid).run(context -> {
                assertThat(context).as(invalid).hasFailed();
                assertThat(context.getStartupFailure())
                        .as(invalid)
                        .rootCause()
                        .hasMessageContaining(invalid.substring(0, invalid.indexOf('=')));
            });
        }
    }
}
