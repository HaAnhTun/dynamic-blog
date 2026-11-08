package com.blog.setup.dto;

/** @param setupRequired true only while the instance has not been claimed yet */
public record SetupStatusResponse(boolean setupRequired) {}
