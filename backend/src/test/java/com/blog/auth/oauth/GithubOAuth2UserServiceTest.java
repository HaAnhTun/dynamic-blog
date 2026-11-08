package com.blog.auth.oauth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.user.entity.UserStatus;
import com.blog.user.service.GithubAccountService;
import com.blog.user.service.GithubAccountService.UserLogin;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.user.DefaultOAuth2User;
import org.springframework.security.oauth2.core.user.OAuth2User;

/**
 * Every failure of the profile-read and account-write step becomes an OAuth2AuthenticationException: any other error
 * escaping the login filter is a 500 without an envelope. A unit test because a DB failure in the middle of a login is something an IT cannot build
 * without breaking the shared DB.
 */
class GithubOAuth2UserServiceTest {

    @SuppressWarnings("unchecked")
    private final OAuth2UserService<OAuth2UserRequest, OAuth2User> github = mock(OAuth2UserService.class);

    private final GithubAccountService accounts = mock(GithubAccountService.class);
    private final GithubOAuth2UserService service = new GithubOAuth2UserService(github, accounts);

    @Test
    void successful_login_returns_principal_carrying_only_blog_account_id() {
        UUID userId = UUID.randomUUID();
        when(github.loadUser(any())).thenReturn(githubUser(Map.of("id", 42, "login", "octocat")));
        when(accounts.recordLogin(new GithubProfile(42, "octocat", "octocat", null)))
                .thenReturn(new UserLogin(userId, UserStatus.ACTIVE, true));

        OAuth2User principal = service.loadUser(null);

        assertThat(principal).isEqualTo(new GithubPrincipal(userId, true));
        assertThat(principal.getName()).isEqualTo(userId.toString());
        assertThat(principal.getAttributes()).isEmpty();
    }

    @Test
    void db_not_answering_becomes_login_failed_with_fixed_message() {
        when(github.loadUser(any())).thenReturn(githubUser(Map.of("id", 42, "login", "octocat")));
        when(accounts.recordLogin(any()))
                .thenThrow(
                        new DataAccessResourceFailureException("Connection to db:5432 refused; key (github_id)=(42)"));

        assertThatThrownBy(() -> service.loadUser(null))
                .isInstanceOfSatisfying(OAuth2AuthenticationException.class, e -> {
                    assertThat(e.getError().getErrorCode()).isEqualTo("login_failed");
                    // The root error's message may copy data (DB address, key values): it must not travel along.
                    assertThat(e.getMessage()).isEqualTo("GitHub login failed");
                    assertThat(e.getCause()).isInstanceOf(DataAccessResourceFailureException.class);
                });
    }

    @Test
    void malformed_profile_becomes_login_failed_and_writes_nothing() {
        when(github.loadUser(any())).thenReturn(githubUser(Map.of("id", "42", "login", "octocat")));

        assertThatThrownBy(() -> service.loadUser(null))
                .isInstanceOfSatisfying(
                        OAuth2AuthenticationException.class,
                        e -> assertThat(e.getError().getErrorCode()).isEqualTo("login_failed"));
        verifyNoInteractions(accounts);
    }

    @Test
    void spring_oauth_error_passes_through_with_original_code() {
        OAuth2AuthenticationException userInfo =
                new OAuth2AuthenticationException(new OAuth2Error("invalid_user_info_response"));
        when(github.loadUser(any())).thenThrow(userInfo);

        assertThatThrownBy(() -> service.loadUser(null)).isSameAs(userInfo);
    }

    @Test
    void suspended_account_becomes_dedicated_user_suspended_error() {
        when(github.loadUser(any())).thenReturn(githubUser(Map.of("id", 42, "login", "octocat")));
        when(accounts.recordLogin(any())).thenReturn(new UserLogin(UUID.randomUUID(), UserStatus.SUSPENDED, false));

        assertThatThrownBy(() -> service.loadUser(null))
                .isInstanceOfSatisfying(
                        GithubOAuth2UserService.SuspendedAccountException.class,
                        e -> assertThat(e.getError().getErrorCode()).isEqualTo("user_suspended"));
    }

    private static OAuth2User githubUser(Map<String, Object> attributes) {
        return new DefaultOAuth2User(List.of(), attributes, "id");
    }
}
