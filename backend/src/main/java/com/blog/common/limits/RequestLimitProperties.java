package com.blog.common.limits;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.unit.DataSize;

/**
 * The largest request body the backend reads, bound from {@code app.request-limit.*} (issues 118 and 036).
 *
 * Nothing used to bound a JSON body before it was read into memory, so with the backend reachable on its own public URL a
 * few large anonymous requests were enough to end the JVM (the container exits on an {@code OutOfMemoryError}). The
 * {@link RequestSizeLimitFilter} refuses a request above these sizes with a 413 before any controller or Jackson sees it.
 * Multipart uploads are not counted here: they have their own limits ({@code spring.servlet.multipart.*},
 * {@code app.media.max-upload-size}).
 *
 * The defaults live here, not in application.yml: they are not knobs for operators (any external-configuration mechanism of
 * Spring Boot can still set them). A value outside 1 KiB to 8 MiB stops the
 * application from starting: 8 MiB is also the document ceiling of the JSON reader ({@code spring.jackson.factory.constraints}
 * in application.yml), so a larger body could never be parsed anyway.
 *
 * @param publicBody every {@code /api/**} request that is not under {@code /api/v1/admin/}: sign-in, refresh, setup, contact,
 *                   newsletter, comments, the profile calls. The largest honest body here is a comment or a contact message,
 *                   a few KiB.
 * @param adminBody  {@code /api/v1/admin/**} JSON: the largest honest body is a post (500,000 characters, at most about
 *                   3 MB once escaped) or a site-content document
 */
@ConfigurationProperties("app.request-limit")
public record RequestLimitProperties(
        @DefaultValue("64KB") DataSize publicBody,
        @DefaultValue("6MB") DataSize adminBody) {

    static final DataSize MIN = DataSize.ofKilobytes(1);
    static final DataSize MAX = DataSize.ofMegabytes(8);

    public RequestLimitProperties {
        check("app.request-limit.public-body", publicBody);
        check("app.request-limit.admin-body", adminBody);
    }

    private static void check(String name, DataSize size) {
        if (size == null || size.compareTo(MIN) < 0 || size.compareTo(MAX) > 0) {
            throw new IllegalArgumentException(name + " must be between 1KB and 8MB");
        }
    }
}
