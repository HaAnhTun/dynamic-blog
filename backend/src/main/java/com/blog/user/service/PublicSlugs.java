package com.blog.user.service;

import com.blog.common.util.SlugGenerator;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import java.util.HashSet;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ResultSetExtractor;

/**
 * The public handle of an account ({@code users.public_slug}): the generation rule for new rows, the same rule migration
 * V32 used to fill the existing rows, and the shape check before every lookup by slug.
 */
public final class PublicSlugs {

    /** The column length (V32). A longer or malformed string cannot be anyone's slug: 404 or an empty page, no SQL run. */
    public static final int MAX_LENGTH = 64;
    /** The base is at most 40 characters, leaving room for a "-n" suffix under {@link #MAX_LENGTH}. */
    static final int MAX_BASE_LENGTH = 40;

    static final String FALLBACK = "nguoi-dung";

    private static final Pattern WELL_FORMED = Pattern.compile("[a-z0-9]+(?:-[a-z0-9]+)*");
    private static final Pattern TRAILING_HYPHENS = Pattern.compile("-+$");

    /** A lock shared by every slug choice for a new row, until the end of the transaction: two first logins with the same base do not collide. */
    static final String LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('public-slug'))";
    /** Every slug already in a base's family: the base itself and base-*. The base only has [a-z0-9-], no LIKE wildcard characters. */
    private static final String TAKEN_SQL = "SELECT public_slug FROM users WHERE public_slug = ? OR public_slug LIKE ?";

    private PublicSlugs() {}

    /** The base from the GitHub login, or from the display name when there is no login, as in V32: {@code coalesce(nullif(login, ''), name)}. */
    public static String baseOf(String githubLogin, String displayName) {
        return base(githubLogin == null || githubLogin.isEmpty() ? displayName : githubLogin);
    }

    /**
     * Strips diacritics (NFD, the letter d-with-stroke becomes d), lowercases, turns each run of characters outside [a-z0-9] into one '-', trims
     * '-' at both ends ({@link SlugGenerator#slugifyOrEmpty}), cuts to {@value #MAX_BASE_LENGTH} characters leaving no
     * trailing '-'; if empty, {@value #FALLBACK}.
     */
    public static String base(String source) {
        String slug = source == null ? "" : SlugGenerator.slugifyOrEmpty(source);
        if (slug.length() > MAX_BASE_LENGTH) {
            slug = TRAILING_HYPHENS.matcher(slug.substring(0, MAX_BASE_LENGTH)).replaceAll("");
        }
        return slug.isEmpty() ? FALLBACK : slug;
    }

    public static boolean isWellFormed(String slug) {
        return slug != null
                && slug.length() <= MAX_LENGTH
                && WELL_FORMED.matcher(slug).matches();
    }

    /**
     * The first free slug among {@code base}, {@code base-2}, {@code base-3}… after taking {@link #LOCK_SQL}. The caller
     * must INSERT the row carrying it in the SAME transaction: outside a transaction the lock is released at once, and
     * two overlapping calls could pick the same value (UNIQUE still blocks it, with an error).
     */
    public static String allocate(JdbcTemplate jdbcTemplate, String base) {
        jdbcTemplate.query(LOCK_SQL, (ResultSetExtractor<Void>) rs -> null);
        HashSet<String> taken = new HashSet<>(jdbcTemplate.queryForList(TAKEN_SQL, String.class, base, base + "-%"));
        return SlugGenerator.ensureUnique(base, taken::contains);
    }

    /** The slug to link to an author's profile; null when that person is suspended, because their profile is 404. */
    public static String profileSlugOf(User user) {
        return user.getStatus() == UserStatus.ACTIVE ? user.getPublicSlug() : null;
    }
}
