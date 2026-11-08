package com.blog.author.dto;

import java.time.Instant;

/**
 * The caller's application, for the /profile page.
 *
 * @param application  the latest application; null when none has ever been submitted
 * @param canApply     whether a new application can be submitted right now: the caller is a reader (USER), has no
 *                     pending application, and is not within 30 days after a rejection
 * @param reapplyAfter when that 30-day period ends; null when no rejection is still holding this user back
 */
public record MyAuthorApplicationResponse(
        AuthorApplicationResponse application, boolean canApply, Instant reapplyAfter) {}
