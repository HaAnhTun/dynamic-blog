package com.blog.siteimport.dto;

/** A profile file to download: the attachment name and the Markdown text. */
public record MarkdownDownload(String filename, String content) {}
