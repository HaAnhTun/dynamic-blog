package com.blog.common.response;

import java.util.List;

public record PagedResponse<T>(List<T> data, PageMeta pagination) {}
