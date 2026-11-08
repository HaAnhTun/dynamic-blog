package com.blog.common.security;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * The admin account's identity, and optionally its password, from configuration.
 *
 * {@code email} ({@code ADMIN_EMAIL}): if it differs from {@value SeedAdmin#EMAIL}, AdminSeedEmail renames the seeded
 * admin row to it at startup, before every other runner: setting the password, linking GitHub and the dev-password check
 * all find the admin under this address, and {@value SeedAdmin#EMAIL} can no longer log in.
 *
 * {@code password} has NO default on purpose. A default would have to be either the
 * development password — in which case the production path and the development path become
 * indistinguishable and {@link DevCredentialWarning} could no longer tell them apart — or
 * a random value, which would silently change the password on every restart. Absent means
 * "leave whatever the database has", which is the only safe reading.
 *
 * {@code githubId} ({@code ADMIN_GITHUB_ID}): the numeric id of the site owner's GitHub account, so AdminGithubLink can
 * link the admin account to it at startup. Blank means off. It is kept as a string and only validated in
 * {@link #linkedGithubId()}: if a bad value broke the binding of the whole record, Boot's startup message would print
 * the values of the properties being bound, and {@code password} sits right next to it.
 */
@ConfigurationProperties(prefix = "app.admin")
public record AdminAccountProperties(
        @DefaultValue(SeedAdmin.EMAIL) String email, String password, String githubId) {

    /**
     * Does not print the password, nor the address (an address is personal data and does not belong in a log). The state
     * of each is enough to read a problem; the GitHub id is public.
     */
    @Override
    public String toString() {
        return "AdminAccountProperties[email=" + (email == null || email.isBlank() ? "<unset>" : "<set>")
                + ", password=" + (password == null || password.isBlank() ? "<unset>" : "<set>")
                + ", githubId=" + githubId + "]";
    }

    /**
     * @return the GitHub id to link with the admin; null when {@code ADMIN_GITHUB_ID} is blank
     * @throws IllegalStateException when the value is not a whole number greater than 0. The message names only the
     *                               variable, like every other configuration error.
     */
    public Long linkedGithubId() {
        if (githubId == null || githubId.isBlank()) {
            return null;
        }
        try {
            long id = Long.parseLong(githubId.strip());
            if (id > 0) {
                return id;
            }
        } catch (NumberFormatException e) {
            // Falls through to the message below: one sentence for every wrong value.
        }
        throw new IllegalStateException("ADMIN_GITHUB_ID (app.admin.github-id) must be the numeric id of a GitHub "
                + "account, a whole number greater than 0; https://api.github.com/users/<login> shows it as \"id\". "
                + "Leave it empty to skip linking the admin account to GitHub.");
    }
}
