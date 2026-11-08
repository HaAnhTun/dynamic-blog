package com.blog.like.dto;

/**
 * Likes of a post, or of a comment, as the caller sees them: the like button shows exactly these two values and
 * never adds or subtracts on its own. Never reveals who liked.
 *
 * @param liked the caller liked it; always false for anonymous callers
 * @param count number of likes
 */
public record LikeResponse(boolean liked, long count) {}
