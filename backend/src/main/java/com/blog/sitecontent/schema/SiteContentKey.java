package com.blog.sitecontent.schema;

import java.util.Arrays;
import java.util.Optional;

/** The nine keys of the site content, in the order the API lists them. The database CHECK holds the same set. */
public enum SiteContentKey {
    SITE("site", SiteContentTypes.Site.class),
    PROFILE("profile", SiteContentTypes.Profile.class),
    ABOUT("about", SiteContentTypes.About.class),
    SKILLS("skills", SiteContentTypes.Skills.class),
    NOW("now", SiteContentTypes.Now.class),
    TIMELINE("timeline", SiteContentTypes.Timeline.class),
    CONTACT("contact", SiteContentTypes.Contact.class),
    BLOGROLL("blogroll", SiteContentTypes.Blogroll.class),
    CASE_STUDIES("case_studies", SiteContentTypes.CaseStudies.class);

    /** The schema version every key has today; the registry of upgraders says how older ones become this one. */
    public static final int CURRENT_VERSION = 1;

    private final String key;
    private final Class<?> payloadType;

    SiteContentKey(String key, Class<?> payloadType) {
        this.key = key;
        this.payloadType = payloadType;
    }

    public String key() {
        return key;
    }

    public Class<?> payloadType() {
        return payloadType;
    }

    public static Optional<SiteContentKey> find(String key) {
        return Arrays.stream(values()).filter(k -> k.key.equals(key)).findFirst();
    }
}
