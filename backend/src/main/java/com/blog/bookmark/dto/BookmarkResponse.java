package com.blog.bookmark.dto;

/** Whether the post is in the caller's bookmarks: the bookmark button shows exactly this value. */
public record BookmarkResponse(boolean bookmarked) {}
