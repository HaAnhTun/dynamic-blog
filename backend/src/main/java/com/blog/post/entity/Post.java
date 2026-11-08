package com.blog.post.entity;

import com.blog.common.text.ReadingTime;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * A post as it is written and read in full: everything {@link PostHead} has, plus the body. The lists do not use this entity but
 * {@link PostCard}, which is the same row without the body.
 */
@Entity
@Table(name = "posts")
@Getter
@NoArgsConstructor
public class Post extends PostHead {

    @Column(nullable = false)
    private String content;

    /** Sets the body and the reading time that is stored with it, so the two cannot disagree. */
    public void setContent(String content) {
        this.content = content;
        setReadingMinutes(ReadingTime.minutes(content));
    }
}
