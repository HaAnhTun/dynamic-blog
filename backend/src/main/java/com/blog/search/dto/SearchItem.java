package com.blog.search.dto;

import com.blog.post.dto.PostSummaryResponse;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * One result. Null fields are absent from the JSON.
 *
 * @param id   {@code <type>:<slug or path>}, never an internal id
 * @param post only in the post group: the public summary for the full result row of {@code /search}, without {@code status}
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SearchItem(
        String id,
        List<Segment> title,
        List<Segment> description,
        String href,
        ItemMeta meta,
        @JsonIgnoreProperties("status") PostSummaryResponse post) {}
