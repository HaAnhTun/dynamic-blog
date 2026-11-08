package com.blog.auth.dto;

import java.util.List;

/**
 * The answer to a sign-in that needs a second step ({@code 202 Accepted} from {@code POST /api/v1/auth/login} and from the
 * GitHub callback): no token, only the single-use challenge to hand back with the code. A client that does not know about
 * two-step verification finds no {@code accessToken} and fails closed.
 *
 * @param challenge              256 random bits, shown once; only its SHA-256 is stored
 * @param purpose                {@code VERIFY} (type a code of the enrolled authenticator) or {@code ENROLL} (set one up first)
 * @param methods                what the second step accepts: {@code TOTP}, and {@code RECOVERY_CODE} where recovery codes exist
 * @param expiresIn              seconds until the challenge is dead
 * @param enrollmentCodeRequired true only for purpose {@code ENROLL} when {@code enroll/begin} will ask for the operator's
 *                               enrollment code (the enrollment window is closed); false otherwise
 */
public record MfaChallengeResponse(
        String challenge, String purpose, List<String> methods, long expiresIn, boolean enrollmentCodeRequired) {

    /** The challenge is a credential for the second step: it is left out. */
    @Override
    public String toString() {
        return "MfaChallengeResponse[challenge=<hidden>, purpose=" + purpose + ", methods=" + methods + ", expiresIn="
                + expiresIn + ", enrollmentCodeRequired=" + enrollmentCodeRequired + "]";
    }
}
