package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.category.dto.CategoryRequest;
import com.blog.category.dto.CategoryResponse;
import com.blog.category.service.CategoryService;
import com.blog.common.security.SeedAdmin;
import com.blog.post.dto.PostCreateRequest;
import com.blog.post.service.PostService;
import com.blog.search.sync.SearchOutboxWorker;
import com.blog.support.AbstractIntegrationTest;
import com.blog.tag.dto.TagRequest;
import com.blog.tag.dto.TagResponse;
import com.blog.tag.service.TagService;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * No {@code MEILI_URL} (shared context, AbstractIntegrationTest): indexing is off, changes write no outbox and the
 * worker does not touch the DB. With it on, see SearchOutboxIT.
 */
class SearchOutboxDisabledIT extends AbstractIntegrationTest {

    @Autowired
    private PostService postService;

    @Autowired
    private CategoryService categoryService;

    @Autowired
    private TagService tagService;

    @Autowired
    private SearchOutboxWorker worker;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void without_meili_url_changes_write_no_outbox_and_worker_does_nothing() {
        String name = "Not synced " + UUID.randomUUID();
        CategoryResponse category = categoryService.create(new CategoryRequest(name, null));
        TagResponse tag = tagService.create(new TagRequest(name));
        UUID post = postService
                .create(
                        SeedAdmin.ID,
                        new PostCreateRequest(name, null, "noi dung", category.id(), Set.of(tag.id()), null))
                .id();
        postService.publish(post, true);
        categoryService.update(category.id(), new CategoryRequest(name + " changed", null));
        tagService.update(tag.id(), new TagRequest(name + " changed"));
        postService.unpublish(post);
        postService.delete(post);

        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM search_outbox", Integer.class))
                .isZero();
        assertThat(worker.runOnce()).isEqualTo(new SearchOutboxWorker.RunSummary(0, 0));
    }
}
