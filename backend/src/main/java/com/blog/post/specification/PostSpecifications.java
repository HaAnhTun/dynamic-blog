package com.blog.post.specification;

import com.blog.post.entity.PostHead;
import com.blog.post.entity.PostStatus;
import java.util.UUID;
import org.springframework.data.jpa.domain.Specification;

/**
 * Filters of the post lists, over any {@link PostHead}: the lists read {@code PostCard} (no body), a few callers could read
 * {@code Post}. The attributes are named by string and exist on the head.
 */
public final class PostSpecifications {

    private PostSpecifications() {}

    /**
     * Restricts a listing to one author. Compares the foreign key rather than joining to
     * {@code users}: the id is already on the posts row, so this needs no join at all.
     */
    public static <T extends PostHead> Specification<T> authoredBy(UUID authorId) {
        return (root, query, cb) -> cb.equal(root.get("author").get("id"), authorId);
    }

    /** Posts that their author has not deleted (V49); an ADMIN's list does not use it and shows the hidden ones as ARCHIVED. */
    public static <T extends PostHead> Specification<T> notDeleted() {
        return (root, query, cb) -> cb.isNull(root.get("deletedAt"));
    }

    /** Posts by the person with this public handle ({@code ?author=}): a join to {@code users}. */
    public static <T extends PostHead> Specification<T> authoredByPublicSlug(String publicSlug) {
        return (root, query, cb) -> cb.equal(root.get("author").get("publicSlug"), publicSlug);
    }

    public static <T extends PostHead> Specification<T> isFeatured() {
        return (root, query, cb) -> cb.isTrue(root.get("featured"));
    }

    public static <T extends PostHead> Specification<T> hasStatus(PostStatus status) {
        return (root, query, cb) -> cb.equal(root.get("status"), status);
    }

    public static <T extends PostHead> Specification<T> hasLanguage(String language) {
        return (root, query, cb) -> cb.equal(root.get("language"), language);
    }

    public static <T extends PostHead> Specification<T> inCategorySlug(String categorySlug) {
        return (root, query, cb) -> cb.equal(root.get("category").get("slug"), categorySlug);
    }

    public static <T extends PostHead> Specification<T> hasTagSlug(String tagSlug) {
        return (root, query, cb) -> {
            query.distinct(true);
            return cb.equal(root.join("tags").get("slug"), tagSlug);
        };
    }
}
