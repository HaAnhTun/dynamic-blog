package com.blog.tag.controller;

import com.blog.common.i18n.Languages;
import com.blog.common.response.ApiResponse;
import com.blog.tag.dto.TagResponse;
import com.blog.tag.service.TagService;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public side of tags: only tags attached to at least one published post. The admin area reads every tag through
 * AdminTagController.
 */
@RestController
@RequestMapping("/api/v1/tags")
@RequiredArgsConstructor
public class TagController {

    private final TagService tagService;
    private final Languages languages;

    @GetMapping
    public ApiResponse<List<TagResponse>> list(@RequestParam(required = false) String lang) {
        return ApiResponse.of(tagService.listPublic(languages.optional(lang)));
    }

    /** 404 {@code TAG_NOT_FOUND} both when no tag has that slug and when it is attached to no published post yet. */
    @GetMapping("/{slug}")
    public ApiResponse<TagResponse> getBySlug(@PathVariable String slug, @RequestParam(required = false) String lang) {
        return ApiResponse.of(tagService.getPublicBySlug(slug, languages.optional(lang)));
    }
}
