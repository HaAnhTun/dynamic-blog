package com.blog.category.controller;

import com.blog.category.dto.CategoryResponse;
import com.blog.category.service.CategoryService;
import com.blog.common.i18n.Languages;
import com.blog.common.response.ApiResponse;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public side of categories: only categories with at least one published post. The admin area reads every
 * category through AdminCategoryController.
 */
@RestController
@RequestMapping("/api/v1/categories")
@RequiredArgsConstructor
public class CategoryController {

    private final CategoryService categoryService;
    private final Languages languages;

    @GetMapping
    public ApiResponse<List<CategoryResponse>> list(@RequestParam(required = false) String lang) {
        return ApiResponse.of(categoryService.listPublic(languages.optional(lang)));
    }

    /** 404 {@code CATEGORY_NOT_FOUND} both when no category has that slug and when it has no published post yet. */
    @GetMapping("/{slug}")
    public ApiResponse<CategoryResponse> getBySlug(
            @PathVariable String slug, @RequestParam(required = false) String lang) {
        return ApiResponse.of(categoryService.getPublicBySlug(slug, languages.optional(lang)));
    }
}
