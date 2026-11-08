package com.blog.series.entity;

import com.blog.common.i18n.LocalizedText;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/**
 * A run of posts read in order. Same mold as Category, with {@code title} in place of {@code name}.
 *
 * There is no list of posts here: membership and position live on posts ({@code series_id}, {@code series_position})
 * and are written only by dedicated SQL, inside one "detach the whole series, then assign 1..n" transaction. An
 * {@code @OneToMany} relation would open a second write path (through the collection) which the unique constraint on
 * position cannot tolerate.
 */
@Entity
@Table(name = "series")
@Getter
@Setter
@NoArgsConstructor
public class Series {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false)
    private String title;

    @Column(nullable = false, unique = true)
    private String slug;

    /** Localized names per locale; the base columns are the default locale and the fallback. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false)
    private Map<String, LocalizedText> translations = new HashMap<>();

    private String description;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }
}
