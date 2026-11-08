package com.blog.auth.service;

import com.blog.auth.dto.MfaChallengeResponse;
import com.blog.auth.dto.TokenResponse;

/**
 * What the first-factor gate ({@link AuthService#completeFirstFactor}) decided: a session, or a challenge for the second
 * step. Both the password login and the GitHub callback answer with it, so there is no path to a session that skips the gate.
 */
public sealed interface FirstFactorResult {

    /** No second factor applies (a reader, an author without two-step verification): the session is open. */
    record Session(TokenResponse tokens) implements FirstFactorResult {}

    /** A second factor applies: no token yet, only the challenge to complete (HTTP 202). */
    record Challenge(MfaChallengeResponse challenge) implements FirstFactorResult {}
}
