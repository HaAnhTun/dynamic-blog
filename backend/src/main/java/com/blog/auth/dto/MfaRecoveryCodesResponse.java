package com.blog.auth.dto;

import java.util.List;

/**
 * Ten new recovery codes, shown once: every older code is void. {@link #toString()} is redacted.
 *
 * @param recoveryCodes the codes in their shown form, {@code ABCD-EFGH-...}; each works once
 */
public record MfaRecoveryCodesResponse(List<String> recoveryCodes) {

    @Override
    public String toString() {
        return "MfaRecoveryCodesResponse[redacted]";
    }
}
