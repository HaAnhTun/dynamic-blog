package com.blog.auth.dto;

/**
 * A completed second step: the same token fields as {@link TokenResponse}, plus how many recovery codes are left and
 * whether this sign-in used one (so the page can nag when few remain and point to "Replace authenticator").
 */
public record MfaVerifiedResponse(
        String accessToken,
        String refreshToken,
        long expiresIn,
        long refreshExpiresIn,
        int recoveryCodesRemaining,
        boolean usedRecoveryCode) {

    /** Both tokens are left out. */
    @Override
    public String toString() {
        return "MfaVerifiedResponse[tokens=<hidden>, expiresIn=" + expiresIn + ", recoveryCodesRemaining="
                + recoveryCodesRemaining + ", usedRecoveryCode=" + usedRecoveryCode + "]";
    }

    public static MfaVerifiedResponse of(TokenResponse tokens, int recoveryCodesRemaining, boolean usedRecoveryCode) {
        return new MfaVerifiedResponse(
                tokens.accessToken(),
                tokens.refreshToken(),
                tokens.expiresIn(),
                tokens.refreshExpiresIn(),
                recoveryCodesRemaining,
                usedRecoveryCode);
    }
}
