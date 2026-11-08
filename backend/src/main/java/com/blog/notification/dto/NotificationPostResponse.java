package com.blog.notification.dto;

/**
 * The post of a notification: a published post, read at response time so a slug that just changed still gives the
 * right link. Never includes the post content.
 */
public record NotificationPostResponse(String slug, String title) {}
