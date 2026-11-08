package com.blog.common.security;

import java.util.UUID;

/**
 * The admin account seeded by migrations: V2 creates the row with a fixed id and the email {@value #EMAIL}, V8 sets the
 * hash of {@value #DEV_PASSWORD}. Both values are printed in the README of a public repository, so they are dev
 * credentials, never those of a real site:
 * <ul>
 *   <li>AdminSeedEmail renames this row's email to {@code ADMIN_EMAIL} when it differs from the default;</li>
 *   <li>DevCredentialWarning refuses to start a public site while the admin still accepts the dev password, and only
 *       warns on a dev machine;</li>
 *   <li>AuthService always rejects the dev password when the site is public.</li>
 * </ul>
 */
public final class SeedAdmin {

    /** The fixed id of the seed row (V2): the admin's posts, comments and notifications hang off it, so renaming the email does not change the id. */
    public static final UUID ID = UUID.fromString("00000000-0000-0000-0000-000000000001");

    /** The email of the seed row, and the default of {@code app.admin.email} ({@code ADMIN_EMAIL}). */
    public static final String EMAIL = "admin@blog.local";

    /** The dev password that V8 pre-hashed. It is not the default of {@code ADMIN_PASSWORD}: that variable deliberately has no default. */
    public static final String DEV_PASSWORD = "admin12345";

    private SeedAdmin() {}
}
