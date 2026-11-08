package com.blog.auth.entity;

/** What a sign-in challenge is for: checking a code of an enrolled account, or enrolling an account that must. */
public enum ChallengePurpose {
    VERIFY,
    ENROLL
}
