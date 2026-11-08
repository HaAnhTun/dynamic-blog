package com.blog.samplecontent.service;

import com.blog.category.dto.CategoryRequest;
import com.blog.category.dto.CategoryResponse;
import com.blog.category.service.CategoryService;
import com.blog.common.i18n.Languages;
import com.blog.common.i18n.LocalizedText;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.post.dto.PostCreateRequest;
import com.blog.post.entity.Post;
import com.blog.post.repository.PostRepository;
import com.blog.post.service.PostService;
import com.blog.post.service.PostTranslationService;
import com.blog.samplecontent.dto.SampleContentResponse;
import com.blog.samplecontent.service.SampleCatalog.SampleItem;
import com.blog.samplecontent.service.SampleCatalog.SamplePost;
import com.blog.series.dto.SeriesAdminResponse;
import com.blog.series.dto.SeriesRequest;
import com.blog.series.service.SeriesService;
import com.blog.tag.dto.TagRequest;
import com.blog.tag.dto.TagResponse;
import com.blog.tag.service.TagService;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Loads the packaged sample content: four published posts (two articles, each in English and Vietnamese, linked as
 * translations), the series "Getting started", the category "Guides" and two tags. Everything goes through the services
 * that the admin screens use, so slugs, translation groups, search indexing and the rules of each service apply as for any
 * other write.
 *
 * Idempotent: an item that already exists (a post with the same slug, a series, category or tag with the same name, ignoring
 * letter case) is left alone and counted as skipped. The series gets its posts only when this call creates it, and never a
 * post that already belongs to another series. One transaction, under the translation write lock (the first lock, like
 * every group write). Never logs content.
 *
 * Publishing queues the newsletter issue of a post for the first publish, like any publish: subscribers of a site that
 * already has some receive the sample posts as new posts.
 */
@Service
public class SampleContentService {

    private static final Logger log = LoggerFactory.getLogger(SampleContentService.class);

    private final PostService postService;
    private final PostTranslationService translationService;
    private final CategoryService categoryService;
    private final TagService tagService;
    private final SeriesService seriesService;
    private final PostRepository postRepository;
    private final Languages languages;
    private final RateLimiter rateLimiter;
    private final SampleCatalog catalog;

    public SampleContentService(
            PostService postService,
            PostTranslationService translationService,
            CategoryService categoryService,
            TagService tagService,
            SeriesService seriesService,
            PostRepository postRepository,
            Languages languages,
            RateLimiter rateLimiter) {
        this.postService = postService;
        this.translationService = translationService;
        this.categoryService = categoryService;
        this.tagService = tagService;
        this.seriesService = seriesService;
        this.postRepository = postRepository;
        this.languages = languages;
        this.rateLimiter = rateLimiter;
        this.catalog = SampleCatalog.load();
    }

    /** What happened to one sample post: its id, and whether it may join the series made by this call. */
    private record Resolved(UUID id, boolean joinsSeries) {}

    /** What this call created and left alone. */
    private static final class Tally {
        int posts;
        int series;
        int categories;
        int tags;
        int skipped;
    }

    /**
     * @param adminId the calling admin, the author of the posts
     * @throws com.blog.common.exception.ApiException 429 {@code RATE_LIMITED} past the site content write limit
     */
    @Transactional
    public SampleContentResponse load(UUID adminId) {
        rateLimiter.check(RateLimiter.SITE_CONTENT_WRITE, adminId);
        postRepository.lockTranslationWrites();
        Tally tally = new Tally();

        Map<String, UUID> categoryIds = ensureCategories(tally);
        Map<String, UUID> tagIds = ensureTags(tally);
        Map<SamplePost, Resolved> posts = ensurePosts(adminId, categoryIds, tagIds, tally);
        linkTranslations(posts, adminId);
        ensureSeries(posts, tally);

        log.info(
                "sample content loaded posts={} series={} categories={} tags={} skipped={}",
                tally.posts,
                tally.series,
                tally.categories,
                tally.tags,
                tally.skipped);
        return new SampleContentResponse(tally.posts, tally.series, tally.categories, tally.tags, tally.skipped);
    }

    // --- Taxonomy ------------------------------------------------------------------------------------------

    private Map<String, UUID> ensureCategories(Tally tally) {
        List<CategoryResponse> existing = categoryService.list();
        Map<String, UUID> ids = new LinkedHashMap<>();
        for (SampleItem item : catalog.categories()) {
            Optional<UUID> found = findByName(item, existing, CategoryResponse::name, CategoryResponse::id);
            if (found.isPresent()) {
                ids.put(item.key(), found.get());
                tally.skipped++;
                continue;
            }
            Map<String, LocalizedText> translations = enabledOnly(item);
            CategoryResponse created = categoryService.create(
                    new CategoryRequest(baseText(item, translations).name(), null, translations));
            ids.put(item.key(), created.id());
            tally.categories++;
        }
        return ids;
    }

    private Map<String, UUID> ensureTags(Tally tally) {
        List<TagResponse> existing = tagService.list();
        Map<String, UUID> ids = new LinkedHashMap<>();
        for (SampleItem item : catalog.tags()) {
            Optional<UUID> found = findByName(item, existing, TagResponse::name, TagResponse::id);
            if (found.isPresent()) {
                ids.put(item.key(), found.get());
                tally.skipped++;
                continue;
            }
            Map<String, LocalizedText> translations = enabledOnly(item);
            TagResponse created = tagService.create(
                    new TagRequest(baseText(item, translations).name(), translations));
            ids.put(item.key(), created.id());
            tally.tags++;
        }
        return ids;
    }

    /** The id of the existing row whose name equals, ignoring case, the name of the item in any of its languages. */
    private static <T> Optional<UUID> findByName(
            SampleItem item, List<T> existing, Function<T, String> name, Function<T, UUID> id) {
        Set<String> names = new HashSet<>();
        item.translations().values().forEach(text -> names.add(fold(text.name())));
        return existing.stream()
                .filter(row -> names.contains(fold(name.apply(row))))
                .map(id)
                .findFirst();
    }

    private static String fold(String name) {
        return name == null ? "" : name.strip().toLowerCase(Locale.ROOT);
    }

    /** The translations in the enabled languages only: a locale that is switched off would be a 400. */
    private Map<String, LocalizedText> enabledOnly(SampleItem item) {
        Map<String, LocalizedText> enabled = new LinkedHashMap<>();
        item.translations().forEach((language, text) -> {
            if (languages.isEnabled(language)) {
                enabled.put(language, text);
            }
        });
        return enabled;
    }

    /** The base text of a row is the default locale's, when the samples have it, else the key language's. */
    private LocalizedText baseText(SampleItem item, Map<String, LocalizedText> enabled) {
        LocalizedText text = enabled.get(languages.defaultLocale());
        if (text == null) {
            text = item.translations().get(SampleCatalog.KEY_LANGUAGE);
        }
        return text;
    }

    // --- Posts ---------------------------------------------------------------------------------------------

    private Map<SamplePost, Resolved> ensurePosts(
            UUID adminId, Map<String, UUID> categoryIds, Map<String, UUID> tagIds, Tally tally) {
        Map<SamplePost, Resolved> resolved = new LinkedHashMap<>();
        for (SamplePost sample : catalog.posts()) {
            if (!languages.isEnabled(sample.language())) {
                continue;
            }
            Optional<Post> existing = postRepository.findBySlug(sample.slug());
            if (existing.isPresent()) {
                Post post = existing.get();
                resolved.put(sample, new Resolved(post.getId(), post.getSeries() == null));
                tally.skipped++;
                continue;
            }
            if (postRepository.existsInSlugHistory(sample.slug())) {
                // The slug belonged to a post that was renamed: creating the sample would take a suffix, and the next
                // call
                // would create it again.
                tally.skipped++;
                continue;
            }
            Set<UUID> tags = new HashSet<>();
            sample.tagKeys().forEach(key -> tags.add(tagIds.get(key)));
            UUID id = postService
                    .create(
                            adminId,
                            new PostCreateRequest(
                                    sample.title(),
                                    sample.excerpt(),
                                    sample.content(),
                                    categoryIds.get(sample.categoryKey()),
                                    tags,
                                    sample.slug(),
                                    sample.language()))
                    .id();
            postService.publish(id, true);
            resolved.put(sample, new Resolved(id, true));
            tally.posts++;
        }
        return resolved;
    }

    /**
     * Links the languages of each article through the existing translation mechanism. Posts that are already linked, or that
     * already sit in two different groups made by hand, are left as they are.
     */
    private void linkTranslations(Map<SamplePost, Resolved> posts, UUID adminId) {
        Map<String, List<UUID>> byGroup = new LinkedHashMap<>();
        posts.forEach((sample, resolved) -> byGroup.computeIfAbsent(sample.group(), group -> new ArrayList<>())
                .add(resolved.id()));
        for (List<UUID> ids : byGroup.values()) {
            UUID anchor = ids.get(0);
            for (UUID other : ids.subList(1, ids.size())) {
                UUID anchorGroup = postRepository.findTranslationGroupId(anchor);
                UUID otherGroup = postRepository.findTranslationGroupId(other);
                if (anchorGroup != null && otherGroup != null) {
                    continue;
                }
                translationService.link(anchor, other, adminId, true);
            }
        }
    }

    // --- Series --------------------------------------------------------------------------------------------

    private void ensureSeries(Map<SamplePost, Resolved> posts, Tally tally) {
        List<SeriesAdminResponse> existing = seriesService.listAll();
        for (SampleItem item : catalog.series()) {
            if (findByName(item, existing, SeriesAdminResponse::title, SeriesAdminResponse::id)
                    .isPresent()) {
                tally.skipped++;
                continue;
            }
            Map<String, LocalizedText> translations = enabledOnly(item);
            LocalizedText base = baseText(item, translations);
            SeriesAdminResponse created =
                    seriesService.create(new SeriesRequest(base.name(), null, base.description(), translations));
            List<UUID> members = posts.entrySet().stream()
                    .filter(entry -> entry.getKey().seriesKey().equals(item.key()))
                    .filter(entry -> entry.getValue().joinsSeries())
                    .map(entry -> entry.getValue().id())
                    .toList();
            if (!members.isEmpty()) {
                seriesService.setPosts(created.id(), members);
            }
            tally.series++;
        }
    }
}
