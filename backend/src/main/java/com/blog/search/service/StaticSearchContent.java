package com.blog.search.service;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.List;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * Search content only the frontend knows: static pages, case studies and the site owner's name, read once at startup
 * from {@value #RESOURCE}. The file is generated from the TS source ({@code frontend/lib/search-static-content.ts},
 * {@code npm run search:export}) and the frontend drift test fails when it diverges from the source; do not edit by hand.
 */
@Component
public class StaticSearchContent {

    private static final String RESOURCE = "search/static-content.json";

    private final Content content;

    public StaticSearchContent(ObjectMapper objectMapper) {
        try (InputStream in = new ClassPathResource(RESOURCE).getInputStream()) {
            this.content = parse(objectMapper, in);
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read " + RESOURCE, e);
        }
    }

    /** Reads the file and checks its shape; throws on failure, so the backend never starts with incomplete search content. */
    private static Content parse(ObjectMapper objectMapper, InputStream in) {
        Content parsed = objectMapper.readValue(in, Content.class);
        if (parsed.version() != 1
                || parsed.owner() == null
                || parsed.owner().name() == null
                || parsed.pages() == null
                || parsed.caseStudies() == null) {
            throw new IllegalStateException(RESOURCE + " is not version 1 static search content");
        }
        return parsed;
    }

    public Owner owner() {
        return content.owner();
    }

    public List<Page> pages() {
        return content.pages();
    }

    public List<CaseStudy> caseStudies() {
        return content.caseStudies();
    }

    record Content(int version, Owner owner, List<Page> pages, List<CaseStudy> caseStudies) {}

    /** The site owner: the display name on the site and the profile path ({@code /about}). */
    public record Owner(String name, String href) {}

    public record Page(String slug, String href, String title, String description) {}

    /** {@code body} is only for Meilisearch to search; Postgres matches the title and summary, like the earlier quick-search panel. */
    public record CaseStudy(String slug, String href, String title, String summary, String body) {}
}
