package com.blog.comment.repository;

import com.blog.comment.dto.CommentAdminResponse;
import com.blog.comment.entity.Comment;
import com.blog.comment.entity.CommentStatus;
import com.blog.common.text.LikePattern;
import com.blog.post.entity.Post;
import com.blog.user.entity.User;
import jakarta.persistence.EntityManager;
import jakarta.persistence.criteria.CompoundSelection;
import jakarta.persistence.criteria.CriteriaBuilder;
import jakarta.persistence.criteria.CriteriaQuery;
import jakarta.persistence.criteria.From;
import jakarta.persistence.criteria.Join;
import jakarta.persistence.criteria.Predicate;
import jakarta.persistence.criteria.Root;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.support.PageableExecutionUtils;
import org.springframework.stereotype.Repository;

/**
 * The comment moderation list: filter by status and by post, search by content, login or author name, newest
 * first.
 *
 * A Criteria projection ({@code cb.construct}), no entity loading: the SQL selects exactly the columns of
 * {@link CommentAdminResponse}. From the post only four columns (id, slug, title, status), never the post content:
 * a page of 100 comments on one long post would otherwise read the whole post 100 times. From the author, no
 * email or password hash. Two statements per page (the page and the count; the count is skipped when the first
 * page is not full), none per comment.
 */
@Repository
@RequiredArgsConstructor
public class CommentAdminQuery {

    private final EntityManager entityManager;

    /**
     * One page, newest first by {@code (created_at, id)}: equal timestamps are ordered by id, so two adjacent
     * pages never repeat or skip a comment.
     *
     * @param status  null means every status
     * @param pattern a {@link LikePattern#contains} pattern, matched against the lowercased content, login and author
     *                name; null means no search
     * @param postId  only comments of this post; null means every post. The count query applies the same filter, so
     *                the total and the page count belong to that post
     */
    public Page<CommentAdminResponse> find(CommentStatus status, String pattern, UUID postId, Pageable pageable) {
        CriteriaBuilder cb = entityManager.getCriteriaBuilder();
        CriteriaQuery<CommentAdminResponse> query = cb.createQuery(CommentAdminResponse.class);
        Root<Comment> comment = query.from(Comment.class);
        Join<Comment, User> author = comment.join("author");
        query.select(projection(cb, comment, comment.join("post"), author))
                .where(filters(cb, comment, author, status, pattern, postId))
                .orderBy(cb.desc(comment.get("createdAt")), cb.desc(comment.get("id")));
        List<CommentAdminResponse> content = entityManager
                .createQuery(query)
                .setFirstResult(Math.toIntExact(pageable.getOffset()))
                .setMaxResults(pageable.getPageSize())
                .getResultList();
        return PageableExecutionUtils.getPage(content, pageable, () -> count(status, pattern, postId));
    }

    /** One comment, in the same shape as a row of {@link #find}: the response to a moderation action. */
    public Optional<CommentAdminResponse> findById(UUID id) {
        CriteriaBuilder cb = entityManager.getCriteriaBuilder();
        CriteriaQuery<CommentAdminResponse> query = cb.createQuery(CommentAdminResponse.class);
        Root<Comment> comment = query.from(Comment.class);
        query.select(projection(cb, comment, comment.join("post"), comment.join("author")))
                .where(cb.equal(comment.get("id"), id));
        return entityManager.createQuery(query).getResultList().stream().findFirst();
    }

    private long count(CommentStatus status, String pattern, UUID postId) {
        CriteriaBuilder cb = entityManager.getCriteriaBuilder();
        CriteriaQuery<Long> query = cb.createQuery(Long.class);
        Root<Comment> comment = query.from(Comment.class);
        // user_id is NOT NULL: joining the author drops no rows, so it is needed only when searching by login or name.
        // The post is never needed, even when filtering by post: that condition reads the comment's post_id column
        // directly.
        Join<Comment, User> author = pattern == null ? null : comment.join("author");
        query.select(cb.count(comment)).where(filters(cb, comment, author, status, pattern, postId));
        return entityManager.createQuery(query).getSingleResult();
    }

    /** The order matches the parameter order of the Criteria constructor in {@link CommentAdminResponse}. */
    private static CompoundSelection<CommentAdminResponse> projection(
            CriteriaBuilder cb, Root<Comment> comment, From<Comment, Post> post, From<Comment, User> author) {
        return cb.construct(
                CommentAdminResponse.class,
                comment.get("id"),
                comment.get("content"),
                comment.get("status"),
                comment.get("parentId"),
                comment.get("createdAt"),
                comment.get("editedAt"),
                post.get("id"),
                post.get("slug"),
                post.get("title"),
                post.get("status"),
                author.get("id"),
                author.get("displayName"),
                author.get("githubLogin"),
                author.get("avatarUrl"),
                author.get("role"),
                author.get("status"));
    }

    /** {@code author} is used only when {@code pattern} is present. */
    private static Predicate[] filters(
            CriteriaBuilder cb,
            Root<Comment> comment,
            From<Comment, User> author,
            CommentStatus status,
            String pattern,
            UUID postId) {
        List<Predicate> where = new ArrayList<>(3);
        if (status != null) {
            where.add(cb.equal(comment.get("status"), status));
        }
        if (postId != null) {
            // The id of the post relation is the foreign key comments.post_id itself: compare on that column, no join
            // on posts.
            where.add(cb.equal(comment.get("post").get("id"), postId));
        }
        if (pattern != null) {
            // The pattern is a bind parameter (the String overload of like), never concatenated into the SQL. A null
            // login
            // (password-only account) yields NULL on that side, and the OR still works thanks to the other two sides.
            where.add(cb.or(
                    cb.like(cb.lower(comment.<String>get("content")), pattern, LikePattern.ESCAPE),
                    cb.like(cb.lower(author.<String>get("githubLogin")), pattern, LikePattern.ESCAPE),
                    cb.like(cb.lower(author.<String>get("displayName")), pattern, LikePattern.ESCAPE)));
        }
        return where.toArray(Predicate[]::new);
    }
}
