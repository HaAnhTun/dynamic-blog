package com.blog.postimport.service;

import com.blog.common.i18n.LocalizedText;
import com.blog.postimport.format.PostNormalForm;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.UnaryOperator;

/**
 * Finds the category or tag a name in a post file means, over the admin lists. A name is stripped, put in NFC and compared
 * ignoring case. It is tried in this order, and the first step that finds anything decides: the translation in the language of
 * the post, then the base name, then the translations in the other languages. A step that finds more than one category (or
 * tag) is ambiguous: the import never guesses between candidates. Pure: no database, no Spring.
 */
public final class TaxonomyResolver {

    /** One category or tag as the admin list shows it. */
    public record Entry(UUID id, String name, Map<String, LocalizedText> translations) {}

    public enum Outcome {
        /** Exactly one candidate. */
        FOUND,
        /** No candidate: the name does not exist yet. */
        MISSING,
        /** More than one candidate at the step that found something. */
        AMBIGUOUS
    }

    /** {@code id} is set only for {@link Outcome#FOUND}. */
    public record Result(Outcome outcome, UUID id) {
        private static final Result MISSING = new Result(Outcome.MISSING, null);
        private static final Result AMBIGUOUS = new Result(Outcome.AMBIGUOUS, null);
    }

    private TaxonomyResolver() {}

    /** The form names are compared in: stripped, NFC, lower case. */
    public static String fold(String name) {
        return Normalizer.normalize(PostNormalForm.strip(name), Normalizer.Form.NFC)
                .toLowerCase(Locale.ROOT);
    }

    /**
     * @param name a non-blank name from the file
     * @param language the language of the post (the existing post's, or the one a new post will have)
     */
    public static Result resolve(String name, String language, List<Entry> entries) {
        String wanted = fold(name);
        Result inLanguage = decide(candidates(entries, wanted, entry -> translated(entry, language)));
        if (inLanguage != Result.MISSING) {
            return inLanguage;
        }
        Result base = decide(candidates(entries, wanted, entry -> Collections.singletonList(entry.name())));
        if (base != Result.MISSING) {
            return base;
        }
        return decide(candidates(entries, wanted, entry -> others(entry, language)));
    }

    /**
     * {@link #resolve}, for a post that already has categories or tags: a name equal to the form the download writes for one
     * of the {@code attached} entries (any of its names put through {@code downloadForm}) is that entry, never a new one and
     * never a guess between candidates. Without exactly one such entry it is {@link #resolve}.
     *
     * @param attachedIds the ids of the entries the post has now
     * @param downloadForm how the writer writes a name of that kind ({@link PostNormalForm#line} or {@link PostNormalForm#tag})
     */
    public static Result resolveAttached(
            String name,
            String language,
            List<Entry> entries,
            Collection<UUID> attachedIds,
            UnaryOperator<String> downloadForm) {
        String wanted = fold(name);
        Set<UUID> written = new LinkedHashSet<>();
        for (Entry entry : entries) {
            if (attachedIds.contains(entry.id())
                    && allNames(entry).stream().anyMatch(known -> matches(downloadForm.apply(known), wanted))) {
                written.add(entry.id());
            }
        }
        return written.size() == 1
                ? new Result(Outcome.FOUND, written.iterator().next())
                : resolve(name, language, entries);
    }

    private static List<String> allNames(Entry entry) {
        List<String> names = new ArrayList<>();
        names.add(entry.name());
        if (entry.translations() != null) {
            entry.translations().values().stream()
                    .filter(translation -> translation != null)
                    .forEach(translation -> names.add(translation.name()));
        }
        return names;
    }

    private static Result decide(Set<UUID> ids) {
        if (ids.isEmpty()) {
            return Result.MISSING;
        }
        return ids.size() == 1 ? new Result(Outcome.FOUND, ids.iterator().next()) : Result.AMBIGUOUS;
    }

    private static Set<UUID> candidates(List<Entry> entries, String wanted, Function<Entry, List<String>> names) {
        Set<UUID> ids = new LinkedHashSet<>();
        for (Entry entry : entries) {
            if (names.apply(entry).stream().anyMatch(name -> matches(name, wanted))) {
                ids.add(entry.id());
            }
        }
        return ids;
    }

    private static boolean matches(String name, String wanted) {
        return name != null && !name.isBlank() && fold(name).equals(wanted);
    }

    private static List<String> translated(Entry entry, String language) {
        LocalizedText text =
                entry.translations() == null ? null : entry.translations().get(language);
        return Collections.singletonList(text == null ? null : text.name());
    }

    private static List<String> others(Entry entry, String language) {
        if (entry.translations() == null) {
            return List.of();
        }
        return entry.translations().entrySet().stream()
                .filter(translation -> !translation.getKey().equals(language) && translation.getValue() != null)
                .map(translation -> translation.getValue().name())
                .toList();
    }
}
