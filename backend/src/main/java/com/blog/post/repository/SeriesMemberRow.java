package com.blog.post.repository;

import java.util.UUID;

/**
 * A post as a member of a series, for placing another post among the members: every status, no entity.
 * {@code part} is the number the author declared, null when none was.
 */
public interface SeriesMemberRow {

    UUID getId();

    String getLanguage();

    Integer getPosition();

    Integer getPart();
}
