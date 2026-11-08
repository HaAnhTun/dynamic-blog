package com.blog.auth.dto;

/**
 * What the security page of the signed-in person needs to know, and nothing that identifies a secret.
 *
 * @param enrolled                    a confirmed authenticator exists
 * @param required                    the account needs a second factor at every sign-in (every ADMIN, and an AUTHOR once enrolled)
 * @param recoveryCodesRemaining      how many recovery codes can still be used; the codes themselves are shown once, at
 *                                    enrollment and regeneration, and never again
 * @param hasPassword                 the account has a password (so the change form and the current-password step-up apply)
 * @param passwordManagedByEnvironment {@code ADMIN_PASSWORD} is set and applies to this account: a password changed here would
 *                                    be undone at the next start, so the change is refused (409)
 */
public record MfaStatusResponse(
        boolean enrolled,
        boolean required,
        int recoveryCodesRemaining,
        boolean hasPassword,
        boolean passwordManagedByEnvironment) {}
