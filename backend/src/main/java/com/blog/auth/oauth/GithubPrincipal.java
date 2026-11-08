package com.blog.auth.oauth;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.core.user.OAuth2User;

/**
 * The person who just logged in with GitHub, as GithubOAuth2UserService hands it to Spring: only the blog account id
 * and "whether it was just created". It keeps no GitHub token, email or GitHub profile: GithubLoginSuccessHandler only
 * needs the id to issue the blog's token pair.
 *
 * @param userId  id of the users row
 * @param created true when this login created the account
 */
record GithubPrincipal(UUID userId, boolean created) implements OAuth2User {

    @Override
    public Map<String, Object> getAttributes() {
        return Map.of();
    }

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        return List.of();
    }

    /** Spring uses it as the principal name of the OAuth2AuthorizedClient (the store keeps nothing, but a name is still required). */
    @Override
    public String getName() {
        return userId.toString();
    }
}
