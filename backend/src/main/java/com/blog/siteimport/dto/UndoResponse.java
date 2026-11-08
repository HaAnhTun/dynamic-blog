package com.blog.siteimport.dto;

import java.util.List;

public record UndoResponse(long importId, String locale, List<UndoneSection> sections) {}
