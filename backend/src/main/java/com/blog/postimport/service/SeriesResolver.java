package com.blog.postimport.service;

import com.blog.common.i18n.LocalizedText;
import com.blog.common.util.SlugGenerator;
import com.blog.postimport.format.PostNormalForm;
import com.blog.postimport.service.TaxonomyResolver.Outcome;
import com.blog.postimport.service.TaxonomyResolver.Result;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Finds the series a name in a post file means, over the admin list of series. A series is a candidate when its slug equals the
 * name written as a slug (so accents, spaces and letter case do not matter: this is what keeps an import from making a
 * {@code -2} copy of a series it did not recognise) or when its title or any translated title equals the name, stripped, in
 * NFC and ignoring letter case. Titles are not folded further. The series the post is in already wins over the other
 * candidates; otherwise exactly one candidate is the series, none means the series does not exist yet, and more than one is
 * ambiguous: the import never guesses. Pure: no database, no Spring.
 */
public final class SeriesResolver {

    /** One series as the admin list shows it. */
    public record Entry(UUID id, String title, String slug, Map<String, LocalizedText> translations) {}

    private SeriesResolver() {}

    /**
     * @param name a non-blank name from the file
     * @param attachedId the series the post is in now, null for a new post or a post outside any series
     */
    public static Result resolve(String name, UUID attachedId, List<Entry> entries) {
        Set<UUID> candidates = candidates(name, entries);
        if (attachedId != null && candidates.contains(attachedId)) {
            return new Result(Outcome.FOUND, attachedId);
        }
        if (candidates.isEmpty()) {
            return new Result(Outcome.MISSING, null);
        }
        return candidates.size() == 1
                ? new Result(Outcome.FOUND, candidates.iterator().next())
                : new Result(Outcome.AMBIGUOUS, null);
    }

    /** Every series the name could mean, in list order; what the apply locks before it decides. */
    public static Set<UUID> candidates(String name, Collection<Entry> entries) {
        String wanted = TaxonomyResolver.fold(name);
        String slug = SlugGenerator.slugifyOrEmpty(name);
        Set<UUID> ids = new LinkedHashSet<>();
        for (Entry entry : entries) {
            boolean bySlug = !slug.isEmpty() && slug.equals(entry.slug());
            if (bySlug || titles(entry).stream().anyMatch(title -> sameName(title, wanted))) {
                ids.add(entry.id());
            }
        }
        return ids;
    }

    /** Whether the name is, as the download writes it, the title of the series or one of its translated titles. */
    public static boolean isTitleOf(String name, Entry entry) {
        String wanted = PostNormalForm.line(name);
        return titles(entry).stream()
                .anyMatch(title -> title != null && PostNormalForm.line(title).equals(wanted));
    }

    private static List<String> titles(Entry entry) {
        List<String> titles = new ArrayList<>();
        titles.add(entry.title());
        if (entry.translations() != null) {
            entry.translations().values().stream()
                    .filter(translation -> translation != null)
                    .forEach(translation -> titles.add(translation.name()));
        }
        return titles;
    }

    private static boolean sameName(String title, String wanted) {
        return title != null && !title.isBlank() && TaxonomyResolver.fold(title).equals(wanted);
    }
}
