package com.blog.siteimport.dto;

/** {@code lastImport} is null when nothing was ever imported. */
public record StatusResponse(LastImport lastImport) {}
