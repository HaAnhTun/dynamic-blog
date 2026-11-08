package com.blog.auth.oauth;

import com.blog.user.entity.UserStatus;
import com.blog.user.service.GithubAccountService;
import com.blog.user.service.GithubAccountService.UserLogin;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.user.OAuth2User;

/**
 * Reads the GitHub profile and then records the login on the blog account.
 *
 * <h2>Every error becomes an OAuth2AuthenticationException</h2>
 *
 * Spring's login filter only hands an {@code AuthenticationException} to the failure handler; any other exception
 * escapes as a 500 through {@code /error}. So here, apart from OAuth2AuthenticationException itself (Spring's
 * profile-read error, which already carries its code), everything else (DB not answering, malformed profile,
 * anything) is wrapped as {@value #LOGIN_FAILED}, and GithubLoginFailureHandler returns a 401 OAUTH_LOGIN_FAILED with an
 * error envelope instead of a 500. The wrapping exception's message is a fixed sentence: the message of the original
 * error (a SQL error, for example) may copy data.
 *
 * The result is a {@link GithubPrincipal}: only the blog account id. The GitHub token stops here.
 */
public class GithubOAuth2UserService implements OAuth2UserService<OAuth2UserRequest, OAuth2User> {

    static final String LOGIN_FAILED = "login_failed";
    static final String USER_SUSPENDED = "user_suspended";

    /** Reads GitHub's {@code GET /user} (a DefaultOAuth2UserService with timeouts, see GithubHttpClients). */
    private final OAuth2UserService<OAuth2UserRequest, OAuth2User> github;

    private final GithubAccountService accounts;

    public GithubOAuth2UserService(
            OAuth2UserService<OAuth2UserRequest, OAuth2User> github, GithubAccountService accounts) {
        this.github = github;
        this.accounts = accounts;
    }

    @Override
    public OAuth2User loadUser(OAuth2UserRequest request) throws OAuth2AuthenticationException {
        UserLogin login;
        try {
            OAuth2User githubUser = github.loadUser(request);
            login = accounts.recordLogin(GithubProfile.from(githubUser.getAttributes()));
        } catch (OAuth2AuthenticationException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new OAuth2AuthenticationException(new OAuth2Error(LOGIN_FAILED), "GitHub login failed", e);
        }
        if (login.status() == UserStatus.SUSPENDED) {
            throw new SuspendedAccountException();
        }
        return new GithubPrincipal(login.userId(), login.created());
    }

    /**
     * The account is suspended: 403 USER_SUSPENDED. A class of its own rather than just an error code, because an
     * OAuth error code can also come from the callback's {@code error} parameter, which anyone can type; the failure
     * handler recognizes this class, not the string.
     */
    static final class SuspendedAccountException extends OAuth2AuthenticationException {

        private static final long serialVersionUID = 1L;

        SuspendedAccountException() {
            super(new OAuth2Error(USER_SUSPENDED), "This account is suspended");
        }
    }
}
