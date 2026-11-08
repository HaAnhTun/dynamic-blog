package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.support.AbstractIntegrationTest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Schema V27: two indexes on the foreign-key side of the taxonomy, {@code idx_post_tags_tag_id} and
 * {@code idx_posts_category_id}. Next to UserSchemaIT because it does the same job: checking with SQL what the migration left behind.
 *
 * Two things are checked. The definition is exactly as in the migration (pg_indexes): table, columns and the ORDER of the columns, since (tag_id, post_id) is what
 * lets "which posts carry this tag" read only the index. And the foreign-key lookups can use them: at the test's data size
 * the planner is right to choose a seq scan, so seq scan is turned off to show that the remaining path is the new index, not a skip scan through the whole primary
 * key (post_id, tag_id) nor a scan of the whole posts table (without V27, the by-category query is "Seq Scan ...
 * Disabled: true"). Like PostSearchAndFeaturedIT with the GIN index.
 */
class TaxonomyIndexSchemaIT extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void v27_has_tag_index_on_post_tags_and_category_index_on_posts() {
        assertThat(indexDefinition("post_tags", "idx_post_tags_tag_id"))
                .isEqualTo("CREATE INDEX idx_post_tags_tag_id ON public.post_tags USING btree (tag_id, post_id)");
        assertThat(indexDefinition("posts", "idx_posts_category_id"))
                .isEqualTo("CREATE INDEX idx_posts_category_id ON public.posts USING btree (category_id)");
    }

    @Test
    void taxonomy_foreign_key_lookups_use_the_new_indexes() {
        String tag = UUID.randomUUID().toString();
        String category = UUID.randomUUID().toString();
        String other = UUID.randomUUID().toString();
        // Exactly the code's queries, or exactly the form of query Postgres itself runs for a foreign key. EXPLAIN
        // only, no query is run.
        Map<String, String> byTag = new LinkedHashMap<>();
        byTag.put(
                "count posts of the tag on merge (TagRepository.countPosts)",
                "select count(*) from post_tags where tag_id = '" + tag + "'");
        byTag.put(
                "copy posts to the target tag on merge (TagRepository.copyPosts)",
                "insert into post_tags (post_id, tag_id) select post_id, '" + other
                        + "' from post_tags where tag_id = '" + tag + "' on conflict do nothing");
        byTag.put(
                "ON DELETE CASCADE on tag delete or merge", "DELETE FROM ONLY post_tags WHERE tag_id = '" + tag + "'");
        Map<String, String> byCategory = new LinkedHashMap<>();
        byCategory.put(
                "count posts before deleting the category (CategoryRepository.countPosts)",
                "select count(p1_0.id) from posts p1_0 where p1_0.category_id = '" + category + "'");
        byCategory.put(
                "NO ACTION foreign key check on category delete or merge",
                "SELECT 1 FROM ONLY posts x WHERE category_id = '" + category + "' FOR KEY SHARE OF x");
        byCategory.put(
                "move posts on category merge (CategoryRepository.movePosts)",
                "update posts set category_id = '" + other + "' where category_id = '" + category + "'");

        byTag.forEach((label, sql) -> {
            String plan = planWithoutSeqScan(sql);
            assertThat(plan).as("%s:%n%s", label, plan).contains("idx_post_tags_tag_id");
        });
        byCategory.forEach((label, sql) -> {
            String plan = planWithoutSeqScan(sql);
            assertThat(plan)
                    .as("%s:%n%s", label, plan)
                    .contains("idx_posts_category_id")
                    .doesNotContain("Seq Scan");
        });
    }

    private String indexDefinition(String table, String index) {
        List<String> definitions = jdbcTemplate.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ? AND indexname = ?",
                String.class,
                table,
                index);
        assertThat(definitions).as("%s on %s", index, table).hasSize(1);
        return definitions.getFirst();
    }

    /**
     * EXPLAIN (not ANALYZE: write statements do not run) with seq scan off, on ONE connection inside a rolled-back transaction:
     * SET LOCAL ends when the transaction ends, so it does not leak into that connection's next borrower in another test.
     */
    private String planWithoutSeqScan(String sql) {
        return jdbcTemplate.execute((ConnectionCallback<String>) connection -> {
            connection.setAutoCommit(false);
            try (Statement statement = connection.createStatement()) {
                statement.execute("SET LOCAL enable_seqscan = off");
                return String.join("\n", lines(statement, "EXPLAIN " + sql));
            } finally {
                connection.rollback();
                connection.setAutoCommit(true);
            }
        });
    }

    private static List<String> lines(Statement statement, String sql) throws SQLException {
        List<String> lines = new ArrayList<>();
        try (ResultSet rows = statement.executeQuery(sql)) {
            while (rows.next()) {
                lines.add(rows.getString(1));
            }
        }
        return lines;
    }
}
