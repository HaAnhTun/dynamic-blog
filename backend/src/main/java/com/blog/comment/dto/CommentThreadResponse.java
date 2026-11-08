package com.blog.comment.dto;

import java.util.List;

/**
 * A root comment and its currently visible replies, oldest first. At most 30 replies per root, so replies need no
 * pagination.
 */
public record CommentThreadResponse(CommentResponse comment, List<CommentResponse> replies) {}
