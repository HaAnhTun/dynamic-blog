package com.blog.sitecontent.schema;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * The typed payload of every site content key (version 1), mirrored by {@code frontend/lib/site-content-types.ts}.
 *
 * Required-nullable fields (seeking, avatar, org, period, email, github, galleryLead) are written as an explicit null.
 * Only the OPTIONAL components carry {@code @JsonInclude(NON_NULL)}: they are left out when absent.
 */
public final class SiteContentTypes {

    static final String SLUG = "[a-z0-9-]{1,40}";
    static final String LEVEL = "used-in-project|worked-with|learning";
    static final String AVATAR = "/media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png)";

    private SiteContentTypes() {}

    public record Site(
            @PlainText(min = 1, max = 80) String name,
            @PlainText(max = 160) String tagline,
            @PlainText(max = 300) String positioning) {}

    public record Hero(
            @PlainText(min = 1, max = 120) String greeting,
            @PlainText(min = 1, max = 200) String headline,
            @PlainText(max = 300) String subline) {}

    public record Profile(
            @PlainText(min = 1, max = 80) String name,
            @PlainText(max = 80) String location,
            @PlainText(max = 120) String role,
            @PlainText(min = 1, max = 300, nullable = true) String seeking,

            @Pattern(regexp = AVATAR, message = "must be an uploaded image path (/media/<id>.jpg or .png)")
            String avatar,

            @PlainText(min = 1, max = 300, nullable = true) String galleryLead,
            @NotNull @Valid Hero hero) {}

    public record AboutSection(
            @NotNull @Pattern(regexp = SLUG, message = "must be 1 to 40 lowercase letters, digits or hyphens")
            String id,

            @PlainText(min = 1, max = 80) String title,
            @NotNull @Size(min = 1, max = 6) List<@PlainText(min = 1, max = 1000) String> body)
            implements Identified {

        @Override
        public String identity() {
            return id;
        }
    }

    public record About(
            @PlainText(min = 1, max = 600) String intro,
            @NotNull @Size(max = 10) @UniqueIds List<@NotNull @Valid AboutSection> sections,

            @JsonInclude(JsonInclude.Include.NON_NULL) @MarkdownBody(max = 20000)
            String body,

            @JsonInclude(JsonInclude.Include.NON_NULL)
            @Pattern(regexp = AVATAR, message = "must be an uploaded image path (/media/<id>.jpg or .png)")
            String photo) {}

    public record Skill(
            @PlainText(min = 1, max = 60) String name,

            @JsonInclude(JsonInclude.Include.NON_NULL)
            @Pattern(regexp = LEVEL, message = "must be used-in-project, worked-with or learning")
            String level,

            @JsonInclude(JsonInclude.Include.NON_NULL) @PlainText(max = 120, nullable = true)
            String note) {}

    public record SkillGroup(
            @NotNull @Pattern(regexp = SLUG, message = "must be 1 to 40 lowercase letters, digits or hyphens")
            String id,

            @PlainText(min = 1, max = 60) String title,

            @NotNull @Pattern(regexp = LEVEL, message = "must be used-in-project, worked-with or learning")
            String defaultLevel,

            @NotNull @Size(max = 30) List<@NotNull @Valid Skill> items)
            implements Identified {

        @Override
        public String identity() {
            return id;
        }
    }

    public record Skills(@NotNull @Size(max = 12) @UniqueIds List<@NotNull @Valid SkillGroup> groups) {}

    public record Evidence(
            @SafeUrl(mode = SafeUrl.Mode.HTTPS_OR_PATH, max = 300)
            String href,

            @PlainText(min = 1, max = 80) String label) {}

    public record NowItem(
            @PlainText(min = 1, max = 300) String text,

            @JsonInclude(JsonInclude.Include.NON_NULL) @Valid
            Evidence evidence) {}

    public record Now(
            @IsoDate String lastUpdated,
            @PlainText(max = 300) String intro,
            @NotNull @Size(max = 20) List<@NotNull @Valid NowItem> items) {}

    /**
     * One job or school. The details after {@code summary} (link, location, department, highlights, technologies, logo) are
     * optional and left out when absent, so an entry stored before they existed stays valid; an empty list is left out too.
     * The logo is an uploaded image path like the avatar: only a ZIP package of the site profile import can create one.
     */
    public record TimelineEntry(
            @NotNull @Pattern(regexp = "education|experience", message = "must be education or experience")
            String kind,

            @PlainText(min = 1, max = 120) String title,
            @PlainText(min = 1, max = 120, nullable = true) String org,
            @PlainText(min = 1, max = 60, nullable = true) String period,
            @PlainText(max = 600) String summary,

            @JsonInclude(JsonInclude.Include.NON_NULL) @SafeUrl(max = 300, nullable = true)
            String url,

            @JsonInclude(JsonInclude.Include.NON_NULL) @PlainText(min = 1, max = 80, nullable = true)
            String location,

            @JsonInclude(JsonInclude.Include.NON_NULL) @PlainText(min = 1, max = 80, nullable = true)
            String department,

            @JsonInclude(JsonInclude.Include.NON_EMPTY) @Size(max = 12)
            List<@PlainText(min = 1, max = 300) String> highlights,

            @JsonInclude(JsonInclude.Include.NON_EMPTY) @Size(max = 30)
            List<@PlainText(min = 1, max = 40) String> tech,

            @JsonInclude(JsonInclude.Include.NON_NULL)
            @Pattern(regexp = AVATAR, message = "must be an uploaded image path (/media/<id>.jpg or .png)")
            String logo) {}

    public record Timeline(
            @PlainText(max = 600) String experienceSummary,
            @NotNull @Size(max = 30) List<@NotNull @Valid TimelineEntry> entries) {}

    public record SocialLink(
            @PlainText(min = 1, max = 40) String label,

            @SafeUrl(mode = SafeUrl.Mode.HTTPS_OR_MAILTO, max = 200)
            String url) {}

    public record Contact(
            @PlainEmail(nullable = true) String email,
            @SafeUrl(max = 200, nullable = true) String github,
            @PlainText(max = 300) String blurb,
            @NotNull @Size(max = 10) List<@NotNull @Valid SocialLink> social) {}

    public record BlogrollEntry(
            @PlainText(min = 1, max = 80) String name,
            @SafeUrl(max = 200) String url,

            @JsonInclude(JsonInclude.Include.NON_NULL) @PlainText(max = 200, nullable = true)
            String note) {}

    public record Blogroll(@NotNull @Size(max = 50) List<@NotNull @Valid BlogrollEntry> entries) {}

    public record Measurement(
            @PlainText(min = 1, max = 120) String label,
            @PlainText(min = 1, max = 120) String value,
            @PlainText(min = 1, max = 300) String source) {}

    public record ReadMore(
            @NotNull
            @Pattern(regexp = "[a-z0-9-]{1,120}", message = "must be 1 to 120 lowercase letters, digits or hyphens")
            String slug) {}

    public record CaseStudy(
            @NotNull
            @Pattern(regexp = "[a-z0-9-]{1,80}", message = "must be 1 to 80 lowercase letters, digits or hyphens")
            String slug,

            @PlainText(min = 1, max = 160) String title,
            @PlainText(min = 1, max = 400) String summary,
            @NotNull @Size(min = 1, max = 10) List<@PlainText(min = 1, max = 2000) String> problem,
            @NotNull @Size(min = 1, max = 10) List<@PlainText(min = 1, max = 2000) String> constraints,
            @NotNull @Size(min = 1, max = 10) List<@PlainText(min = 1, max = 2000) String> solution,
            @NotNull @Size(max = 20) List<@NotNull @Valid Measurement> results,
            @NotNull @Size(min = 1, max = 10) List<@PlainText(min = 1, max = 2000) String> ifRedone,
            @NotNull @Size(max = 10) List<@NotNull @Valid ReadMore> readMore,
            @IsoDate String lastVerified)
            implements Identified {

        @Override
        public String identity() {
            return slug;
        }
    }

    public record CaseStudies(
            @NotNull @Size(max = 20) @UniqueIds List<@NotNull @Valid CaseStudy> items) {}
}
