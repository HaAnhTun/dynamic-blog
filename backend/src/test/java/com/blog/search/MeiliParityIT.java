package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.fixtures.vi.SearchParityVi;
import com.blog.search.dto.SearchGroup;
import com.blog.search.dto.SearchItem;
import com.blog.search.service.MeiliSearchProvider;
import com.blog.search.service.PostgresSearchProvider;
import com.blog.search.service.SearchRequest;
import com.blog.search.service.SearchType;
import com.blog.search.service.StaticSearchContent;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Postgres <-> Meilisearch parity on the same data: a fixed set of queries runs through both providers, with the same
 * category filter so that only this data set is visible. For queries without typos, Meilisearch must not lose any
 * post that Postgres finds, except exactly one kind: {@code C++}/{@code C#}, where Postgres drops {@code +}/{@code #} and
 * matches every post with a standalone letter "c" (posts that never contain that token). Differences are printed
 * (lines {@code PARITY|}) for the record; ranking is not judged.
 *
 * Also covers the acceptance queries: prefix ({@code spri}), typo ({@code playwrigth}), two-way diacritic folding,
 * technical tokens.
 */
class MeiliParityIT extends MeiliIntegrationTest {

    @Autowired
    private PostgresSearchProvider postgres;

    @Autowired
    private MeiliSearchProvider meilisearch;

    /** Short name of a post -> title, Markdown body. */
    private static final Map<String, String[]> FIXTURE = fixture();

    private static Map<String, String[]> fixture() {
        Map<String, String[]> posts = new LinkedHashMap<>();
        posts.put("hoc-may", new String[] {SearchParityVi.HOC_MAY_TITLE, SearchParityVi.HOC_MAY_BODY});
        posts.put("hoc-may-khong-dau", new String[] {"Hoc may khong dau", "Ghi chu viet khong dau ve hoc may."});
        posts.put("duong-ong", new String[] {SearchParityVi.DUONG_ONG_TITLE, SearchParityVi.DUONG_ONG_BODY});
        posts.put("spring-boot", new String[] {SearchParityVi.SPRING_BOOT_TITLE, SearchParityVi.SPRING_BOOT_BODY});
        posts.put("springboot", new String[] {SearchParityVi.SPRINGBOOT_TITLE, SearchParityVi.SPRINGBOOT_BODY});
        posts.put("postgresql", new String[] {SearchParityVi.POSTGRESQL_TITLE, SearchParityVi.POSTGRESQL_BODY});
        posts.put("snake-case", new String[] {SearchParityVi.SNAKE_CASE_TITLE, SearchParityVi.SNAKE_CASE_BODY});
        posts.put("json-loads", new String[] {SearchParityVi.JSON_LOADS_TITLE, SearchParityVi.JSON_LOADS_BODY});
        posts.put("cpp", new String[] {"Template trong C++", SearchParityVi.CPP_BODY});
        posts.put("csharp", new String[] {"LINQ trong C#", SearchParityVi.CSHARP_BODY});
        posts.put("c-thuan", new String[] {SearchParityVi.C_PURE_TITLE, SearchParityVi.C_PURE_BODY});
        posts.put("nextjs", new String[] {"App Router", SearchParityVi.NEXTJS_BODY});
        posts.put("azure-functions", new String[] {SearchParityVi.FUNCTIONS_TITLE, SearchParityVi.FUNCTIONS_BODY});
        posts.put("playwright", new String[] {SearchParityVi.PLAYWRIGHT_TITLE, SearchParityVi.PLAYWRIGHT_BODY});
        return posts;
    }

    /** Query -> whether it has a typo (typo queries are exempt from the "no lost posts" rule). */
    private static final Map<String, Boolean> QUERIES = queries();

    private static Map<String, Boolean> queries() {
        Map<String, Boolean> queries = new LinkedHashMap<>();
        for (String q : List.of(
                SearchParityVi.QUERY_HOC_MAY,
                "hoc may",
                SearchParityVi.QUERY_DUONG_ONG,
                "duong ong",
                SearchParityVi.QUERY_DUONG,
                "Spring Boot",
                "SpringBoot",
                "PostgreSQL",
                "snake_case",
                "json.loads",
                "C++",
                "C#",
                "Next.js",
                "Azure Functions",
                "Playwright")) {
            queries.put(q, false);
        }
        queries.put("playwrigth", true);
        return queries;
    }

    @Test
    void meilisearch_loses_no_post_postgres_finds_and_passes_acceptance_queries() throws Exception {
        String marker = uniqueWord();
        Taxon category = createCategory("Parity " + marker, null);
        Map<String, String> textOf = new LinkedHashMap<>();
        for (Map.Entry<String, String[]> post : FIXTURE.entrySet()) {
            UUID id = publish(post.getValue()[0], post.getValue()[1], null, category);
            slugToName.put(slugOf(id), post.getKey());
            textOf.put(post.getKey(), (post.getValue()[0] + " " + post.getValue()[1]).toLowerCase(Locale.ROOT));
        }
        reindex();

        List<String> differences = new ArrayList<>();
        for (Map.Entry<String, Boolean> query : QUERIES.entrySet()) {
            String q = query.getKey();
            Set<String> pg = postgresNames(q, category);
            Set<String> meili = meili(q, category);
            Set<String> onlyPg = new LinkedHashSet<>(pg);
            onlyPg.removeAll(meili);
            Set<String> onlyMeili = new LinkedHashSet<>(meili);
            onlyMeili.removeAll(pg);
            String line = "PARITY|q=" + q + "|postgres=" + pg + "|meilisearch=" + meili + "|onlyPostgres=" + onlyPg
                    + "|onlyMeilisearch=" + onlyMeili;
            System.out.println(line);
            if (!onlyPg.isEmpty() || !onlyMeili.isEmpty()) {
                differences.add(line);
            }
            if (!query.getValue()) {
                // Losing a post is only accepted when it never contains the queried token (Postgres reads C++/C# as
                // "c").
                for (String lost : onlyPg) {
                    assertThat(q)
                            .as("Meilisearch lost post %s for query %s", lost, q)
                            .isIn("C++", "C#");
                    assertThat(textOf.get(lost)).as(lost).doesNotContain(q.toLowerCase(Locale.ROOT));
                }
            }
        }
        System.out.println("PARITY|differences=" + differences.size());

        // Acceptance: prefix, typo, two-way diacritic folding, technical tokens.
        assertThat(meili("spri", category)).contains("spring-boot", "springboot");
        assertThat(meili("playwrigth", category)).contains("playwright");
        assertThat(meili("hoc may", category)).contains("hoc-may", "hoc-may-khong-dau");
        assertThat(meili(SearchParityVi.QUERY_HOC_MAY, category)).contains("hoc-may", "hoc-may-khong-dau");
        assertThat(meili("duong ong", category)).contains("duong-ong");
        assertThat(meili(SearchParityVi.QUERY_DUONG_ONG, category)).contains("duong-ong");
        assertThat(meili("C++", category)).containsExactly("cpp");
        assertThat(meili("C#", category)).containsExactly("csharp");
        assertThat(meili("loads", category)).contains("json-loads");
        assertThat(meili("json.loads", category)).contains("json-loads");
        assertThat(meili("snake_case", category)).contains("snake-case");
        assertThat(meili("Next.js", category)).contains("nextjs");
        assertThat(meili("Spring Boot", category)).contains("spring-boot", "springboot");
        assertThat(meili("SpringBoot", category)).contains("spring-boot", "springboot");
        assertThat(meili("PostgreSQL", category)).contains("postgresql");
        assertThat(meili("Azure Functions", category)).contains("azure-functions");
        // No letters, no digits: nothing matches in either engine. Sent as is, Meilisearch treats it as an empty
        // search and returns every post of the filter.
        for (String q : List.of("!!", "--", "+", "?!")) {
            assertThat(meili(q, category)).as(q).isEmpty();
            assertThat(postgresNames(q, category)).as(q).isEmpty();
        }
        // Postgres cannot do these (whole-word, dropping + and #): exactly why Meilisearch exists.
        assertThat(postgresNames("spri", category)).isEmpty();
        assertThat(postgresNames("loads", category)).isEmpty();
        assertThat(postgresNames("C++", category)).contains("csharp", "c-thuan");

        // A few extra queries outside the list, only to record them (no assertions).
        for (String q : List.of("nextjs", "receive", "c", "spring", "json", "ong", "sp")) {
            System.out.println("PARITY-EXTRA|q=" + q + "|postgres=" + postgresNames(q, category) + "|meilisearch="
                    + meili(q, category));
        }
    }

    @Test
    void both_engines_return_the_same_ids_per_group_for_vi_en_and_no_language() throws Exception {
        LanguageData data = bilingualData();
        reindex();

        Map<SearchType, Set<String>> vi = assertSameGroups(data.marker(), "vi");
        Map<SearchType, Set<String>> en = assertSameGroups(data.marker(), "en");
        Map<SearchType, Set<String>> every = assertSameGroups(data.marker(), null);

        assertThat(vi.get(SearchType.POST))
                .containsExactlyInAnyOrder("post:" + slugOf(data.viMain()), "post:" + slugOf(data.viOnlyPost()));
        assertThat(vi.get(SearchType.TOPIC))
                .containsExactlyInAnyOrder(
                        "category:" + data.both().slug(),
                        "category:" + data.viOnly().slug(),
                        "tag:" + data.tag().slug());
        assertThat(en.get(SearchType.POST))
                .containsExactlyInAnyOrder("post:" + slugOf(data.enTranslation()), "post:" + slugOf(data.enOnlyPost()));
        // A category whose only en post is a draft or unpublished is absent in en, and so are the authors of those
        // posts.
        assertThat(en.get(SearchType.TOPIC))
                .containsExactlyInAnyOrder(
                        "category:" + data.both().slug(),
                        "category:" + data.enOnly().slug(),
                        "tag:" + data.tag().slug());
        assertThat(every.get(SearchType.POST)).hasSize(4);
        assertThat(every.get(SearchType.TOPIC))
                .containsExactlyInAnyOrder(
                        "category:" + data.both().slug(),
                        "category:" + data.viOnly().slug(),
                        "category:" + data.enOnly().slug(),
                        "tag:" + data.tag().slug());
        for (Map<SearchType, Set<String>> groups : List.of(vi, en, every)) {
            assertThat(groups.get(SearchType.SERIES))
                    .containsExactly("series:" + data.series().slug());
        }
        assertThat(vi.get(SearchType.AUTHOR)).hasSize(1);
        assertThat(en.get(SearchType.AUTHOR)).hasSize(1);
        assertThat(every.get(SearchType.AUTHOR)).hasSize(2);
        assertThat(vi.get(SearchType.AUTHOR)).doesNotContainAnyElementsOf(en.get(SearchType.AUTHOR));
    }

    @Test
    void both_engines_keep_static_pages_and_case_studies_in_every_language() throws Exception {
        StaticSearchContent.Page page = staticContent.pages().getFirst();
        StaticSearchContent.CaseStudy study = staticContent.caseStudies().getFirst();
        reindex();
        for (String lang : new String[] {"vi", "en", null}) {
            Set<String> pagesPg = ids(postgres.search(typed(page.title(), SearchType.PAGE, lang)))
                    .getOrDefault(SearchType.PAGE, Set.of());
            Set<String> pagesMeili = ids(meilisearch.search(typed(page.title(), SearchType.PAGE, lang)))
                    .getOrDefault(SearchType.PAGE, Set.of());
            assertThat(pagesPg).as("pages %s", lang).contains("page:" + page.href());
            assertThat(pagesMeili).as("pages %s", lang).isEqualTo(pagesPg);
            Set<String> studiesPg = ids(postgres.search(typed(study.title(), SearchType.CASE_STUDY, lang)))
                    .getOrDefault(SearchType.CASE_STUDY, Set.of());
            Set<String> studiesMeili = ids(meilisearch.search(typed(study.title(), SearchType.CASE_STUDY, lang)))
                    .getOrDefault(SearchType.CASE_STUDY, Set.of());
            assertThat(studiesPg).as("case studies %s", lang).contains("case-study:" + study.slug());
            assertThat(studiesMeili).as("case studies %s", lang).isEqualTo(studiesPg);
        }
    }

    private static SearchRequest typed(String text, SearchType type, String language) {
        return new SearchRequest(text, type, 10, 0, 50, null, List.of(), null, language);
    }

    /** Runs the marker through both providers for one language (null: all) and returns the shared ids per group. */
    private Map<SearchType, Set<String>> assertSameGroups(String marker, String language) {
        SearchRequest request = new SearchRequest(marker, null, 10, 0, 50, null, List.of(), null, language);
        Map<SearchType, Set<String>> pg = ids(postgres.search(request));
        Map<SearchType, Set<String>> meili = ids(meilisearch.search(request));
        assertThat(meili).as("groups for lang=%s", language).isEqualTo(pg);
        return pg;
    }

    private static Map<SearchType, Set<String>> ids(List<SearchGroup> groups) {
        Map<SearchType, Set<String>> ids = new LinkedHashMap<>();
        for (SearchGroup group : groups) {
            Set<String> set = new LinkedHashSet<>();
            group.items().forEach(item -> set.add(item.id()));
            ids.put(group.type(), set);
        }
        return ids;
    }

    @Autowired
    private StaticSearchContent staticContent;

    /** Slug of a post -> short name in {@link #FIXTURE}. */
    private final Map<String, String> slugToName = new LinkedHashMap<>();

    private Set<String> meili(String q, Taxon category) {
        return names(meilisearch.search(request(q, category.slug())));
    }

    private Set<String> postgresNames(String q, Taxon category) {
        return names(postgres.search(request(q, category.slug())));
    }

    private static SearchRequest request(String q, String category) {
        return new SearchRequest(q, SearchType.POST, 10, 0, 50, category, List.of(), null);
    }

    private Set<String> names(List<SearchGroup> groups) {
        Set<String> names = new LinkedHashSet<>();
        for (SearchGroup group : groups) {
            assertThat(group.type()).isEqualTo(SearchType.POST);
            for (SearchItem item : group.items()) {
                names.add(
                        slugToName.getOrDefault(item.post().slug(), item.post().slug()));
            }
        }
        return names;
    }
}
