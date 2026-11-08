package com.blog.siteimport.dto;

/** One content key put back by an undo: {@code restored} (previous version) or {@code removed} (the import created it). */
public record UndoneSection(String key, String status) {}
