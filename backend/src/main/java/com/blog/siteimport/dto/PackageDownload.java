package com.blog.siteimport.dto;

/** The ZIP package of a site profile export and the name it is downloaded as. */
public record PackageDownload(String filename, byte[] content) {}
