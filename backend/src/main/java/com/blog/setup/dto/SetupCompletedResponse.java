package com.blog.setup.dto;

/** The answer of a successful setup. No token: the owner signs in afterwards. */
public record SetupCompletedResponse(boolean setupCompleted) {}
