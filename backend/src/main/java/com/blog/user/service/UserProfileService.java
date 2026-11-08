package com.blog.user.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.security.SeedAdmin;
import com.blog.post.entity.PostStatus;
import com.blog.post.repository.PostRepository;
import com.blog.user.dto.UserProfileResponse;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** The public profile by slug. */
@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class UserProfileService {

    private final UserRepository userRepository;
    private final PostRepository postRepository;

    /**
     * @throws ApiException 404 {@code USER_NOT_FOUND}, the same body for a malformed slug (no SQL run), an unknown slug
     *                      and a suspended account: the asker cannot tell a suspended person from a nonexistent one
     */
    public UserProfileResponse get(String slug) {
        if (!PublicSlugs.isWellFormed(slug)) {
            throw notFound();
        }
        User user = userRepository
                .findByPublicSlugAndStatus(slug, UserStatus.ACTIVE)
                .orElseThrow(this::notFound);
        long published = postRepository.countByAuthorIdAndStatus(user.getId(), PostStatus.PUBLISHED);
        return new UserProfileResponse(
                user.getPublicSlug(),
                user.getDisplayName(),
                user.getGithubLogin(),
                user.getAvatarUrl(),
                SeedAdmin.ID.equals(user.getId()),
                user.getCreatedAt(),
                published);
    }

    private ApiException notFound() {
        return new ApiException(ErrorCode.USER_NOT_FOUND, HttpStatus.NOT_FOUND, "User not found");
    }
}
