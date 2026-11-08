package com.blog.post.mapper;

/**
 * "Part n/m" of a post in a series, counted over the published parts. {@link #NONE} for a post that is not in a series
 * or is not published: the UI then shows no part number.
 *
 * The mapper cannot compute this value itself (it is a pure function of one entity, while the part number depends on
 * the other posts of the series), so the service looks it up in a batch for the whole page and passes it in.
 */
public record PartInfo(Integer partNumber, Integer partCount) {

    public static final PartInfo NONE = new PartInfo(null, null);
}
