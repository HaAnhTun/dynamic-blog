package com.blog.comment.dto;

import java.util.List;

/**
 * One page of a post's comments: threads in oldest-first order.
 *
 * @param nextCursor value for {@code ?after=} of the next page; null on the last page. It is the position
 *                   (timestamp, id) of the last root comment on the page, so comments added or removed between
 *                   two loads cannot make the next page repeat or skip any comment.
 */
public record CommentPage(List<CommentThreadResponse> threads, String nextCursor) {}
