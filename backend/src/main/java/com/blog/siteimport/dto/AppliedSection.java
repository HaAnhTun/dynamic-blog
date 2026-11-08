package com.blog.siteimport.dto;

/** The outcome of one selected section: {@code created}, {@code updated}, {@code unchanged} or {@code skipped}. */
public record AppliedSection(String id, String key, String status) {}
