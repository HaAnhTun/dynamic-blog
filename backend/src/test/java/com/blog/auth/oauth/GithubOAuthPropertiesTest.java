package com.blog.auth.oauth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;

/**
 * GitHub login configuration: when it is enabled, where the callback comes from, and which configuration makes the backend
 * refuse to start.
 *
 * Properties are built through the Binder as Spring builds them at startup, not by calling the constructor directly. The "at startup" part runs
 * the real GithubOAuthConfig in an ApplicationContextRunner: no DB, no web, so it does not cost a Testcontainers
 * context.
 *
 * Every wrong value in this file carries the domain {@value #MARKER}: a startup error may name only the configuration NAME, never the
 * value, because the startup log is where a value lives the longest.
 */
class GithubOAuthPropertiesTest {

    private static final String MARKER = "khong-duoc-in-ra.example";
    private static final String SECRET = "client-secret-khong-duoc-in-ra";
    private static final String CALLBACK = "https://blog.example.com/api/auth/github/callback";
    private static final String LOOPBACK_CALLBACK = "http://localhost:3000/api/auth/github/callback";

    // --- Callback ----------------------------------------------------------------------------------------

    @Test
    void callback_is_GITHUB_REDIRECT_URI_when_present_even_if_SITE_URL_is_also_present() {
        GithubOAuthProperties properties = bind(
                "client-id",
                "itclient",
                "client-secret",
                SECRET,
                "redirect-uri",
                CALLBACK,
                "site-url",
                "https://site-khac.example.com");

        assertThat(properties.effectiveRedirectUri()).isEqualTo(CALLBACK);
        assertThatCode(properties::validateWhenEnabled).doesNotThrowAnyException();
    }

    @ParameterizedTest
    @ValueSource(strings = {"https://blog.example.com", "https://blog.example.com/", "https://blog.example.com//"})
    void without_GITHUB_REDIRECT_URI_callback_is_derived_from_SITE_URL_stripping_all_trailing_slashes(String siteUrl) {
        GithubOAuthProperties properties = bind("client-id", "itclient", "client-secret", SECRET, "site-url", siteUrl);

        assertThat(properties.effectiveRedirectUri()).isEqualTo(CALLBACK);
        assertThatCode(properties::validateWhenEnabled).doesNotThrowAnyException();
    }

    @Test
    void enabled_without_both_GITHUB_REDIRECT_URI_and_SITE_URL_refuses_to_start() {
        GithubOAuthProperties properties = bind("client-id", "itclient", "client-secret", SECRET);

        assertThat(properties.effectiveRedirectUri()).isNull();
        assertThatThrownBy(properties::validateWhenEnabled)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("neither GITHUB_REDIRECT_URI nor SITE_URL");
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "http://" + MARKER + "/api/auth/github/callback",
                "ftp://localhost/api/auth/github/callback",
                "/api/auth/github/callback",
                MARKER + "/api/auth/github/callback",
                "https:" + MARKER,
                "https://" + MARKER + " /api/auth/github/callback"
            })
    void callback_that_is_not_absolute_https_url_is_rejected_naming_only_the_property(String redirectUri) {
        GithubOAuthProperties properties =
                bind("client-id", "itclient", "client-secret", SECRET, "redirect-uri", redirectUri);

        assertThatThrownBy(properties::validateWhenEnabled)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("GITHUB_REDIRECT_URI")
                .hasMessageNotContaining(MARKER)
                .hasNoCause();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "http://localhost:3000/api/auth/github/callback",
                "http://LOCALHOST:3000/api/auth/github/callback",
                "http://127.0.0.1:3100/api/auth/github/callback",
                "http://[::1]:3000/api/auth/github/callback"
            })
    void http_is_accepted_only_on_loopback_for_dev_and_qa_machines(String redirectUri) {
        GithubOAuthProperties properties =
                bind("client-id", "itclient", "client-secret", SECRET, "redirect-uri", redirectUri);

        assertThatCode(properties::validateWhenEnabled).doesNotThrowAnyException();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "https://" + MARKER + "/api/auth/github/callback/",
                "https://" + MARKER + "/api/auth/github/callback?next=/admin",
                "https://" + MARKER + "/api/auth/github/callback?",
                "https://" + MARKER + "/api/auth/github/callback#x",
                "https://" + MARKER + "/login/oauth2/code/github",
                "https://" + MARKER + "/blog/api/auth/github/callback"
            })
    void callback_must_be_exactly_the_Next_route_path_without_query_or_fragment(String redirectUri) {
        GithubOAuthProperties properties =
                bind("client-id", "itclient", "client-secret", SECRET, "redirect-uri", redirectUri);

        assertThatThrownBy(properties::validateWhenEnabled)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("GITHUB_REDIRECT_URI")
                .hasMessageContaining(GithubOAuthProperties.CALLBACK_PATH)
                .hasMessageNotContaining(MARKER);
    }

    @Test
    void SITE_URL_with_sub_path_or_not_absolute_gives_error_naming_SITE_URL() {
        GithubOAuthProperties withPath =
                bind("client-id", "itclient", "client-secret", SECRET, "site-url", "https://" + MARKER + "/blog/");
        GithubOAuthProperties relative = bind("client-id", "itclient", "client-secret", SECRET, "site-url", MARKER);

        assertThatThrownBy(withPath::validateWhenEnabled)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("SITE_URL")
                .hasMessageNotContaining(MARKER);
        assertThatThrownBy(relative::validateWhenEnabled)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("SITE_URL")
                .hasMessageNotContaining(MARKER);
    }

    // --- GitHub address ----------------------------------------------------------------------------------

    @Test
    void github_address_defaults_to_real_github_com_even_when_key_present_but_blank() {
        GithubOAuthProperties defaults =
                bind("client-id", "itclient", "client-secret", SECRET, "redirect-uri", CALLBACK);
        GithubOAuthProperties blanks = bind(
                "client-id",
                "itclient",
                "client-secret",
                SECRET,
                "redirect-uri",
                CALLBACK,
                "provider.authorization-uri",
                "",
                "provider.token-uri",
                " ",
                "provider.user-info-uri",
                "");

        for (GithubOAuthProperties properties : new GithubOAuthProperties[] {defaults, blanks}) {
            assertThat(properties.provider().authorizationUri()).isEqualTo("https://github.com/login/oauth/authorize");
            assertThat(properties.provider().tokenUri()).isEqualTo("https://github.com/login/oauth/access_token");
            assertThat(properties.provider().userInfoUri()).isEqualTo("https://api.github.com/user");
        }
    }

    @Test
    void github_address_can_only_change_to_https_or_a_fake_github_on_loopback() {
        GithubOAuthProperties loopback = bind(
                "client-id",
                "itclient",
                "client-secret",
                SECRET,
                "redirect-uri",
                LOOPBACK_CALLBACK,
                "provider.authorization-uri",
                "http://127.0.0.1:8089/login/oauth/authorize",
                "provider.token-uri",
                "http://127.0.0.1:8089/login/oauth/access_token",
                "provider.user-info-uri",
                "http://127.0.0.1:8089/user");
        assertThatCode(loopback::validateWhenEnabled).doesNotThrowAnyException();

        for (String key : new String[] {"authorization-uri", "token-uri", "user-info-uri"}) {
            GithubOAuthProperties plainHttp = bind(
                    "client-id",
                    "itclient",
                    "client-secret",
                    SECRET,
                    "redirect-uri",
                    CALLBACK,
                    "provider." + key,
                    "http://" + MARKER + "/x");
            assertThatThrownBy(plainHttp::validateWhenEnabled)
                    .as(key)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("app.oauth.github.provider." + key)
                    .hasMessageNotContaining(MARKER);
        }
    }

    // --- A public site keeps GitHub's own addresses ------------------------------------------------------

    @ParameterizedTest
    @ValueSource(strings = {"authorization-uri", "token-uri", "user-info-uri"})
    void on_a_public_site_an_address_that_is_not_github_is_refused_naming_only_the_property(String key) {
        for (String other : new String[] {
            "https://evil.example/x",
            "http://127.0.0.1:9/x",
            "https://github.com.evil.example/x",
            "https://github.com@evil.example/x",
            "https://gist.github.com",
            "https://github.com" + ":8443/x"
        }) {
            GithubOAuthProperties properties = bind(
                    "client-id",
                    "itclient",
                    "client-secret",
                    SECRET,
                    "site-url",
                    "https://blog.example.com",
                    "provider." + key,
                    other);

            assertThatThrownBy(properties::validateWhenEnabled)
                    .as(key + " " + other)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("app.oauth.github.provider." + key)
                    .hasMessageNotContaining("evil.example")
                    .hasMessageNotContaining("127.0.0.1");
        }
    }

    @Test
    void on_a_public_site_a_public_redirect_uri_alone_also_makes_it_production() {
        GithubOAuthProperties properties = bind(
                "client-id",
                "itclient",
                "client-secret",
                SECRET,
                "redirect-uri",
                CALLBACK,
                "provider.user-info-uri",
                "https://evil.example/user");

        assertThatThrownBy(properties::validateWhenEnabled)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("app.oauth.github.provider.user-info-uri")
                .hasMessageNotContaining("evil.example");
    }

    @Test
    void on_a_public_site_githubs_own_addresses_and_the_defaults_are_accepted() {
        assertThatCode(
                        bind("client-id", "itclient", "client-secret", SECRET, "site-url", "https://blog.example.com")
                                ::validateWhenEnabled)
                .doesNotThrowAnyException();
        assertThatCode(bind(
                        "client-id",
                        "itclient",
                        "client-secret",
                        SECRET,
                        "site-url",
                        "https://blog.example.com",
                        "provider.authorization-uri",
                        "https://github.com/login/oauth/authorize",
                        "provider.token-uri",
                        "https://GitHub.com/login/oauth/access_token",
                        "provider.user-info-uri",
                        "https://api.github.com/user")::validateWhenEnabled)
                .doesNotThrowAnyException();
    }

    @Test
    void on_a_loopback_site_the_fake_github_of_the_tests_and_the_e2e_stack_is_still_accepted() {
        for (String site : new String[] {"http://localhost:3000", "http://127.0.0.1:3100", "http://[::1]:3000"}) {
            assertThatCode(bind(
                            "client-id",
                            "itclient",
                            "client-secret",
                            SECRET,
                            "site-url",
                            site,
                            "provider.authorization-uri",
                            "http://127.0.0.1:8089/login/oauth/authorize",
                            "provider.token-uri",
                            "http://127.0.0.1:8089/login/oauth/access_token",
                            "provider.user-info-uri",
                            "http://127.0.0.1:8089/user")::validateWhenEnabled)
                    .as(site)
                    .doesNotThrowAnyException();
        }
    }

    @Test
    void with_github_login_off_nothing_about_the_addresses_is_checked() {
        assertThatCode(
                        bind("site-url", "https://blog.example.com", "provider.user-info-uri", "https://evil.example/u")
                                ::validateWhenEnabled)
                .doesNotThrowAnyException();
    }

    // --- On and off --------------------------------------------------------------------------------------

    @Test
    void enabled_only_with_both_client_id_and_secret_and_when_disabled_nothing_is_checked() {
        assertThat(bind().enabled()).isFalse();
        assertThat(bind().effectiveRedirectUri()).isNull();
        assertThat(bind("client-id", "itclient").enabled()).isFalse();
        assertThat(bind("client-secret", SECRET).enabled()).isFalse();
        assertThat(bind("client-id", "  ", "client-secret", SECRET).enabled()).isFalse();
        assertThat(bind("client-id", "itclient", "client-secret", SECRET).enabled())
                .isTrue();

        // When disabled the remaining wrong configuration does not break startup: the site runs, just without GitHub
        // login.
        GithubOAuthProperties disabledButWrong = bind(
                "client-id",
                "",
                "client-secret",
                "",
                "redirect-uri",
                "http://" + MARKER + "/sai",
                "provider.token-uri",
                "ftp://" + MARKER);
        assertThatCode(disabledButWrong::validateWhenEnabled).doesNotThrowAnyException();
    }

    @Test
    void surrounding_whitespace_in_env_file_values_is_stripped() {
        GithubOAuthProperties properties = bind(
                "client-id",
                " itclient ",
                "client-secret",
                " " + SECRET + "\t",
                "site-url",
                " https://blog.example.com/ ");

        assertThat(properties.clientId()).isEqualTo("itclient");
        assertThat(properties.clientSecret()).isEqualTo(SECRET);
        assertThat(properties.effectiveRedirectUri()).isEqualTo(CALLBACK);
    }

    @Test
    void toString_does_not_print_client_secret() {
        GithubOAuthProperties properties =
                bind("client-id", "itclient", "client-secret", SECRET, "redirect-uri", CALLBACK);

        assertThat(properties.toString())
                .doesNotContain(SECRET)
                .contains("itclient")
                .contains("<set>");
        assertThat(bind().toString()).contains("<blank>");
    }

    // --- At startup --------------------------------------------------------------------------------------

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withUserConfiguration(GithubOAuthConfig.class);

    @Test
    void without_any_GITHUB_property_still_starts_and_has_no_ClientRegistrationRepository() {
        runner.run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(ClientRegistrationRepository.class);
        });
        // Fully empty too: this is exactly what application.yml sets when the environment variable is absent.
        runner.withPropertyValues(
                        "app.oauth.github.client-id=",
                        "app.oauth.github.client-secret=",
                        "app.oauth.github.redirect-uri=",
                        "app.oauth.github.site-url=")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).doesNotHaveBean(ClientRegistrationRepository.class);
                });
    }

    @Test
    void enabled_without_callback_backend_does_not_start() {
        runner.withPropertyValues("app.oauth.github.client-id=itclient", "app.oauth.github.client-secret=" + SECRET)
                .run(context -> {
                    assertThat(context).hasFailed();
                    assertThat(context.getStartupFailure())
                            .rootCause()
                            .hasMessageContaining("neither GITHUB_REDIRECT_URI nor SITE_URL")
                            .hasMessageNotContaining(SECRET);
                });
    }

    @Test
    void fully_enabled_has_exactly_github_registration_with_absolute_callback_and_scope_read_user() {
        runner.withPropertyValues(
                        "app.oauth.github.client-id=itclient",
                        "app.oauth.github.client-secret=" + SECRET,
                        "app.oauth.github.site-url=https://blog.example.com/")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    ClientRegistration github =
                            context.getBean(ClientRegistrationRepository.class).findByRegistrationId("github");
                    assertThat(github).isNotNull();
                    assertThat(github.getClientId()).isEqualTo("itclient");
                    assertThat(github.getClientSecret()).isEqualTo(SECRET);
                    // Absolute, never {baseUrl}: the call to the backend goes through the internal address, not the
                    // site.
                    assertThat(github.getRedirectUri()).isEqualTo(CALLBACK);
                    assertThat(github.getScopes()).containsExactly("read:user");
                    assertThat(github.getClientAuthenticationMethod())
                            .isEqualTo(ClientAuthenticationMethod.CLIENT_SECRET_BASIC);
                    assertThat(github.getProviderDetails().getAuthorizationUri())
                            .isEqualTo("https://github.com/login/oauth/authorize");
                    assertThat(github.getProviderDetails().getTokenUri())
                            .isEqualTo("https://github.com/login/oauth/access_token");
                    assertThat(github.getProviderDetails().getUserInfoEndpoint().getUri())
                            .isEqualTo("https://api.github.com/user");
                    assertThat(github.getProviderDetails().getUserInfoEndpoint().getUserNameAttributeName())
                            .isEqualTo("id");
                });
    }

    @Test
    void application_yml_wires_the_GITHUB_and_SITE_URL_environment_variables_correctly() {
        // A mistyped key in application.yml makes the environment variable silently go nowhere. Set the variable as a
        // system
        // property (which takes precedence over the real environment variable of the test machine) and read it back
        // through the bound properties.
        runner.withInitializer(new ConfigDataApplicationContextInitializer())
                .withSystemProperties(
                        "GITHUB_CLIENT_ID=id-tu-env",
                        "GITHUB_CLIENT_SECRET=" + SECRET,
                        "GITHUB_REDIRECT_URI=",
                        "SITE_URL=https://blog.example.com")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    GithubOAuthProperties properties = context.getBean(GithubOAuthProperties.class);
                    assertThat(properties.clientId()).isEqualTo("id-tu-env");
                    assertThat(properties.clientSecret()).isEqualTo(SECRET);
                    assertThat(properties.siteUrl()).isEqualTo("https://blog.example.com");
                    assertThat(properties.effectiveRedirectUri()).isEqualTo(CALLBACK);
                    assertThat(context).hasSingleBean(ClientRegistrationRepository.class);
                });
        runner.withInitializer(new ConfigDataApplicationContextInitializer())
                .withSystemProperties("GITHUB_CLIENT_ID=", "GITHUB_CLIENT_SECRET=", "GITHUB_REDIRECT_URI=", "SITE_URL=")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(GithubOAuthProperties.class).enabled())
                            .isFalse();
                    assertThat(context).doesNotHaveBean(ClientRegistrationRepository.class);
                });
    }

    // --- Helpers -----------------------------------------------------------------------------------------

    /** Key pairs (without the {@code app.oauth.github.} prefix) and values. */
    private static GithubOAuthProperties bind(String... keyValues) {
        Map<String, String> source = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            source.put("app.oauth.github." + keyValues[i], keyValues[i + 1]);
        }
        return new Binder(new MapConfigurationPropertySource(source))
                .bindOrCreate("app.oauth.github", GithubOAuthProperties.class);
    }
}
