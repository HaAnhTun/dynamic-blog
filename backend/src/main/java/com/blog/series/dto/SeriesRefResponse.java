package com.blog.series.dto;

import java.util.UUID;

/**
 * The series a post belongs to, inside the post DTO.
 *
 * @param position   for a published post the same number as {@code partNumber}, so a gap in the stored positions (a part
 *                   that is a draft, or was detached) is never visible to a reader; for a post that is not published (admin
 *                   API only) the stored position, starting at 1 and possibly with gaps. Used only for ordering and as a
 *                   stable number; never used to write "Part n".
 * @param partNumber 1-based order of the post among the PUBLISHED parts of the series: the "n" in "Part n/m".
 *                   Null when the post is not published.
 * @param partCount  number of published parts of the series: the "m" in "Part n/m". Null when the post is not published.
 */
public record SeriesRefResponse(
        UUID id, String slug, String title, int position, Integer partNumber, Integer partCount) {}
