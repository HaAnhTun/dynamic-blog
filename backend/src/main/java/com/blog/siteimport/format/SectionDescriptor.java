package com.blog.siteimport.format;

import com.blog.sitecontent.schema.SiteContentKey;
import java.util.List;

/**
 * The one definition of a section of the profile file: its id and {@code # Heading}, the site content key it writes to,
 * and its parts. The parser, the validation messages, the template, the export and the generated reference all read it.
 * Several sections may write to the same key (Identity and Career goals both write the profile); their pointers never
 * overlap.
 */
public record SectionDescriptor(
        String id, String heading, SiteContentKey key, String description, List<PartSpec> parts) {}
