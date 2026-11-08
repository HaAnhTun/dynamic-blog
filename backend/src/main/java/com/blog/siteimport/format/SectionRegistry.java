package com.blog.siteimport.format;

import com.blog.sitecontent.schema.SiteContentKey;
import com.blog.siteimport.format.PartSpec.Document;
import com.blog.siteimport.format.PartSpec.Fields;
import com.blog.siteimport.format.PartSpec.GroupBody;
import com.blog.siteimport.format.PartSpec.Groups;
import com.blog.siteimport.format.PartSpec.Paragraph;
import com.blog.siteimport.format.PartSpec.Rows;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Every section of format version 1, in the order of the template. Adding a section (Projects, Case studies) means adding
 * a descriptor here: parsing, validation, template, export and the reference documentation follow. The limits in the
 * descriptions mirror {@code SiteContentTypes}, which stays the validator.
 */
public final class SectionRegistry {

    public static final int SCHEMA_VERSION = 1;
    public static final String CONTENT_TYPE = "site-profile";
    /** The most characters of the About page body; mirrors {@code SiteContentTypes.About}. */
    public static final int ABOUT_BODY_LIMIT = 20000;

    private static final List<SectionDescriptor> SECTIONS = List.of(
            new SectionDescriptor(
                    "site",
                    "Site",
                    SiteContentKey.SITE,
                    "The name of the site and the sentences that describe it in the page title, the footer and search results.",
                    List.of(new Fields(List.of(
                            field("name", "/name", true, Fill.OMIT, "The site name, 1 to 80 characters."),
                            field(
                                    "tagline",
                                    "/tagline",
                                    false,
                                    Fill.EMPTY,
                                    "A short phrase after the name in the home page title, up to 160 characters."),
                            field(
                                    "positioning",
                                    "/positioning",
                                    false,
                                    Fill.EMPTY,
                                    "One or two sentences about the site, up to 300 characters."))))),
            new SectionDescriptor(
                    "identity",
                    "Identity",
                    SiteContentKey.PROFILE,
                    "The person behind the site and the home page hero.",
                    List.of(new Fields(List.of(
                            field("name", "/name", true, Fill.OMIT, "The person's name, 1 to 80 characters."),
                            field(
                                    "role",
                                    "/role",
                                    false,
                                    Fill.EMPTY,
                                    "The current role or title, up to 120 characters."),
                            field("location", "/location", false, Fill.EMPTY, "City and country, up to 80 characters."),
                            field(
                                    "greeting",
                                    "/hero/greeting",
                                    true,
                                    Fill.OMIT,
                                    "The first line of the home page, 1 to 120 characters."),
                            field(
                                    "headline",
                                    "/hero/headline",
                                    true,
                                    Fill.OMIT,
                                    "One line about what the person does, 1 to 200 characters."),
                            field(
                                    "subline",
                                    "/hero/subline",
                                    false,
                                    Fill.EMPTY,
                                    "One line about what the site covers, up to 300 characters."),
                            field(
                                    "gallery_lead",
                                    "/galleryLead",
                                    false,
                                    Fill.NULL,
                                    "One sentence above the photo gallery, up to 300 characters."))))),
            new SectionDescriptor(
                    "career-goals",
                    "Career goals",
                    SiteContentKey.PROFILE,
                    "What the person is looking for, as one paragraph of up to 300 characters.",
                    List.of(new Paragraph(
                            field("seeking", "/seeking", false, Fill.NULL, "One paragraph, up to 300 characters.")))),
            new SectionDescriptor(
                    "about",
                    "About",
                    SiteContentKey.ABOUT,
                    "The About page: an optional photo, one introduction paragraph, then titled groups of paragraphs.",
                    List.of(
                            new Fields(
                                    List.of(
                                            field(
                                                    "photo",
                                                    "/photo",
                                                    false,
                                                    Fill.OMIT,
                                                    "The photo at the top of the page: a path under assets/ in a ZIP package (JPEG, PNG or WebP), or a /media/<id>.jpg or .png path of an uploaded image. Leave it out to use the profile avatar."))),
                            new Paragraph(
                                    field("intro", "/intro", true, Fill.OMIT, "One paragraph, 1 to 600 characters.")),
                            new Groups(
                                    "/sections",
                                    field("title", "/title", true, Fill.OMIT, "The heading text, 1 to 80 characters."),
                                    field(
                                            "id",
                                            "/id",
                                            true,
                                            Fill.OMIT,
                                            "Written as {#id}: 1 to 40 lowercase letters, digits or hyphens, unique in the file; derived from the title when left out."),
                                    List.of(),
                                    new GroupBody.ParagraphBody("/body"),
                                    "Up to 10 groups. Each group holds 1 to 6 paragraphs of up to 1000 characters; separate paragraphs with a blank line."))),
            new SectionDescriptor(
                    "about-page",
                    "About page",
                    SiteContentKey.ABOUT,
                    "The body of the About page, written as Markdown with the same article blocks as a post (callout, metrics, timeline, tabs and more). Everything up to the next level 1 heading is the body, code fences included; the body itself must not use a level 1 heading.",
                    List.of(new Document(
                            field(
                                    "body",
                                    "/body",
                                    false,
                                    Fill.OMIT,
                                    "Markdown, up to 20000 characters. Blank lines, fences, tables, lists and ## to ###### headings are kept as written."),
                            ABOUT_BODY_LIMIT))),
            new SectionDescriptor(
                    "skills",
                    "Skills",
                    SiteContentKey.SKILLS,
                    "Skills in titled groups. Each row is one skill.",
                    List.of(new Groups(
                            "/groups",
                            field("title", "/title", true, Fill.OMIT, "The group name, 1 to 60 characters."),
                            field(
                                    "id",
                                    "/id",
                                    true,
                                    Fill.OMIT,
                                    "Written as {#id}: 1 to 40 lowercase letters, digits or hyphens, unique in the file; derived from the title when left out."),
                            List.of(
                                    field(
                                            "level",
                                            "/defaultLevel",
                                            true,
                                            Fill.OMIT,
                                            "Written as level=...: the level of every skill in the group that has none of its own: used-in-project, worked-with or learning.")),
                            new GroupBody.RowBody(
                                    "/items",
                                    List.of(
                                            field("name", "/name", true, Fill.OMIT, "The skill, 1 to 60 characters."),
                                            field(
                                                    "level",
                                                    "/level",
                                                    false,
                                                    Fill.OMIT,
                                                    "used-in-project, worked-with or learning; the group level when left out."),
                                            field(
                                                    "note",
                                                    "/note",
                                                    false,
                                                    Fill.OMIT,
                                                    "A short remark, up to 120 characters."))),
                            "Up to 12 groups of up to 30 skills."))),
            new SectionDescriptor(
                    "now",
                    "Now",
                    SiteContentKey.NOW,
                    "What the person is doing at the moment.",
                    List.of(
                            new Fields(List.of(
                                    field(
                                            "last_updated",
                                            "/lastUpdated",
                                            true,
                                            Fill.OMIT,
                                            "The date of the last update, YYYY-MM-DD."),
                                    field(
                                            "intro",
                                            "/intro",
                                            false,
                                            Fill.EMPTY,
                                            "One sentence above the list, up to 300 characters."))),
                            new Rows(
                                    "Items",
                                    "/items",
                                    List.of(
                                            field(
                                                    "text",
                                                    "/text",
                                                    true,
                                                    Fill.OMIT,
                                                    "What is going on, 1 to 300 characters."),
                                            field(
                                                    "label",
                                                    "/evidence/label",
                                                    false,
                                                    Fill.OMIT,
                                                    "The text of a link that backs it up, up to 80 characters; needs a link."),
                                            field(
                                                    "link",
                                                    "/evidence/href",
                                                    false,
                                                    Fill.OMIT,
                                                    "An https:// address or a path on this site such as /writing; needs a label.")),
                                    "Up to 20 rows."))),
            new SectionDescriptor(
                    "timeline",
                    "Timeline",
                    SiteContentKey.TIMELINE,
                    "Education and work, newest first. Write each entry as a ## group with its details on lines below it; the older five-column rows under ## Entries are still read.",
                    List.of(
                            new Fields(List.of(field(
                                    "experience_summary",
                                    "/experienceSummary",
                                    false,
                                    Fill.EMPTY,
                                    "A sentence or two about the experience, up to 600 characters."))),
                            new Rows(
                                    "Entries",
                                    "/entries",
                                    List.of(
                                            field("kind", "/kind", true, Fill.OMIT, "education or experience."),
                                            field(
                                                    "title",
                                                    "/title",
                                                    true,
                                                    Fill.OMIT,
                                                    "The degree or role, 1 to 120 characters."),
                                            field(
                                                    "org",
                                                    "/org",
                                                    false,
                                                    Fill.NULL,
                                                    "The school or employer, up to 120 characters."),
                                            field(
                                                    "period",
                                                    "/period",
                                                    false,
                                                    Fill.NULL,
                                                    "When, free text, up to 60 characters."),
                                            field(
                                                    "summary",
                                                    "/summary",
                                                    false,
                                                    Fill.EMPTY,
                                                    "What was done or learned, up to 600 characters.")),
                                    "The older way to write entries, still read and never written by the export: up to 30 rows with only these five columns. A file gives the entries either as rows or as groups, not both.",
                                    true),
                            new Groups(
                                    "/entries",
                                    field(
                                            "title",
                                            "/title",
                                            true,
                                            Fill.OMIT,
                                            "The degree or role, the text of the heading, 1 to 120 characters."),
                                    null,
                                    List.of(field(
                                            "kind",
                                            "/kind",
                                            true,
                                            Fill.OMIT,
                                            "Written as kind=...: education or experience.")),
                                    new GroupBody.FieldBody(
                                            List.of(
                                                    field(
                                                            "org",
                                                            "/org",
                                                            false,
                                                            Fill.NULL,
                                                            "The school or employer, up to 120 characters."),
                                                    field(
                                                            "url",
                                                            "/url",
                                                            false,
                                                            Fill.OMIT,
                                                            "An https:// address for the school or employer, up to 300 characters."),
                                                    field(
                                                            "logo",
                                                            "/logo",
                                                            false,
                                                            Fill.OMIT,
                                                            "The logo: a path under assets/ in a ZIP package (JPEG, PNG or WebP), or a /media/<id>.jpg or .png path of an uploaded image."),
                                                    field(
                                                            "location",
                                                            "/location",
                                                            false,
                                                            Fill.OMIT,
                                                            "City and country, up to 80 characters."),
                                                    field(
                                                            "department",
                                                            "/department",
                                                            false,
                                                            Fill.OMIT,
                                                            "The team or department, up to 80 characters."),
                                                    field(
                                                            "period",
                                                            "/period",
                                                            false,
                                                            Fill.NULL,
                                                            "When, free text such as 09/2023 - Present, up to 60 characters."),
                                                    field(
                                                            "summary",
                                                            "/summary",
                                                            false,
                                                            Fill.EMPTY,
                                                            "What was done or learned, up to 600 characters."),
                                                    field(
                                                            "tech",
                                                            "/tech",
                                                            false,
                                                            Fill.OMIT,
                                                            FieldSpec.Shape.CELLS,
                                                            "Technologies or subjects as one line, separated by pipes (Java | Spring Boot); up to 30 items of up to 40 characters."),
                                                    field(
                                                            "highlight",
                                                            "/highlights",
                                                            false,
                                                            Fill.OMIT,
                                                            FieldSpec.Shape.LINES,
                                                            "One achievement per line; write the line again for the next one. Up to 12 lines of up to 300 characters."))),
                                    "Up to 30 entries, each a ## heading with the title and {kind=...}, then its detail lines. Leave a detail line empty to leave the detail out."))),
            new SectionDescriptor(
                    "contact",
                    "Contact",
                    SiteContentKey.CONTACT,
                    "How readers reach the person.",
                    List.of(
                            new Fields(List.of(
                                    field(
                                            "email",
                                            "/email",
                                            false,
                                            Fill.NULL,
                                            "A plain address such as name@example.com; shown publicly."),
                                    field(
                                            "github",
                                            "/github",
                                            false,
                                            Fill.NULL,
                                            "An https:// address, up to 200 characters."),
                                    field(
                                            "blurb",
                                            "/blurb",
                                            false,
                                            Fill.EMPTY,
                                            "One sentence about how to get in touch, up to 300 characters."))),
                            new Rows(
                                    "Social links",
                                    "/social",
                                    List.of(
                                            field(
                                                    "label",
                                                    "/label",
                                                    true,
                                                    Fill.OMIT,
                                                    "The link text, 1 to 40 characters."),
                                            field(
                                                    "url",
                                                    "/url",
                                                    true,
                                                    Fill.OMIT,
                                                    "An https:// or mailto: address, up to 200 characters.")),
                                    "Up to 10 rows."))),
            new SectionDescriptor(
                    "blogroll",
                    "Blogroll",
                    SiteContentKey.BLOGROLL,
                    "Sites the person recommends.",
                    List.of(new Rows(
                            null,
                            "/entries",
                            List.of(
                                    field("name", "/name", true, Fill.OMIT, "The site name, 1 to 80 characters."),
                                    field("url", "/url", true, Fill.OMIT, "An https:// address, up to 200 characters."),
                                    field(
                                            "note",
                                            "/note",
                                            false,
                                            Fill.OMIT,
                                            "Why it is recommended, up to 200 characters.")),
                            "Up to 50 rows."))));

    private SectionRegistry() {}

    public static List<SectionDescriptor> sections() {
        return SECTIONS;
    }

    /** Matches a heading ignoring case and runs of spaces. */
    public static Optional<SectionDescriptor> byHeading(String heading) {
        String wanted = normalize(heading);
        return SECTIONS.stream()
                .filter(s -> normalize(s.heading()).equals(wanted))
                .findFirst();
    }

    public static Optional<SectionDescriptor> byId(String id) {
        return SECTIONS.stream().filter(s -> s.id().equals(id)).findFirst();
    }

    public static List<SectionDescriptor> forKey(SiteContentKey key) {
        return SECTIONS.stream().filter(s -> s.key() == key).toList();
    }

    /**
     * The skeleton of a payload that does not exist yet: every list empty and every optional field at the value its
     * {@link Fill} says, for all the sections of the key. Required fields are left out, so a file that does not give them
     * fails validation instead of inventing them.
     */
    public static ObjectNode createBase(SiteContentKey key) {
        ObjectNode base = JsonMapper.builder().build().createObjectNode();
        for (SectionDescriptor section : forKey(key)) {
            for (PartSpec part : section.parts()) {
                switch (part) {
                    case PartSpec.Fields fields -> fields.fields().forEach(f -> fillBase(base, f));
                    case PartSpec.Paragraph paragraph -> fillBase(base, paragraph.field());
                    case PartSpec.Document document -> fillBase(base, document.field());
                    case PartSpec.Rows rows -> Pointers.set(base, rows.pointer(), base.arrayNode());
                    case PartSpec.Groups groups -> Pointers.set(base, groups.pointer(), base.arrayNode());
                }
            }
        }
        return base;
    }

    private static void fillBase(ObjectNode base, FieldSpec field) {
        if (field.required()) {
            return;
        }
        switch (field.fill()) {
            case NULL -> Pointers.set(base, field.pointer(), base.nullNode());
            case EMPTY -> Pointers.set(base, field.pointer(), base.stringNode(""));
            case OMIT -> {}
        }
    }

    /**
     * The format name of the value a JSON pointer of the key payload addresses (for example {@code /hero/headline} gives
     * {@code headline}, {@code /groups/1/items/3/note} gives {@code note}), or null when the pointer is not a field of this
     * section. Array indexes in the pointer are ignored.
     */
    public static String fieldNameFor(SectionDescriptor section, String pointer) {
        String generic = pointer.replaceAll("/[0-9]+(?=/|$)", "/*");
        return fieldNames(section).get(generic);
    }

    private static Map<String, String> fieldNames(SectionDescriptor section) {
        Map<String, String> names = new LinkedHashMap<>();
        for (PartSpec part : section.parts()) {
            switch (part) {
                case PartSpec.Fields fields -> fields.fields().forEach(f -> names.put(f.pointer(), f.name()));
                case PartSpec.Paragraph paragraph ->
                    names.put(paragraph.field().pointer(), paragraph.field().name());
                case PartSpec.Document document ->
                    names.put(document.field().pointer(), document.field().name());
                case PartSpec.Rows rows ->
                    rows.columns().forEach(c -> names.put(rows.pointer() + "/*" + c.pointer(), c.name()));
                case PartSpec.Groups groups -> {
                    String base = groups.pointer() + "/*";
                    names.put(base + groups.title().pointer(), groups.title().name());
                    if (groups.id() != null) {
                        names.put(base + groups.id().pointer(), groups.id().name());
                    }
                    groups.attributes().forEach(a -> names.put(base + a.pointer(), a.name()));
                    switch (groups.body()) {
                        case PartSpec.GroupBody.RowBody rows ->
                            rows.columns()
                                    .forEach(c -> names.put(base + rows.pointer() + "/*" + c.pointer(), c.name()));
                        case PartSpec.GroupBody.ParagraphBody paragraphs ->
                            names.put(base + paragraphs.pointer() + "/*", "paragraph");
                        case PartSpec.GroupBody.FieldBody body ->
                            body.fields().forEach(f -> {
                                names.put(base + f.pointer(), f.name());
                                if (f.shape() != FieldSpec.Shape.SINGLE) {
                                    names.put(base + f.pointer() + "/*", f.name());
                                }
                            });
                    }
                }
            }
        }
        return names;
    }

    private static String normalize(String text) {
        return text.strip().replaceAll("\\s+", " ").toLowerCase(java.util.Locale.ROOT);
    }

    private static FieldSpec field(String name, String pointer, boolean required, Fill fill, String description) {
        return new FieldSpec(name, pointer, required, fill, description);
    }

    private static FieldSpec field(
            String name, String pointer, boolean required, Fill fill, FieldSpec.Shape shape, String description) {
        return new FieldSpec(name, pointer, required, fill, description, shape);
    }
}
