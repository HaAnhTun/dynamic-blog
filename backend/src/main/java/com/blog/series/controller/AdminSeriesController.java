package com.blog.series.controller;

import com.blog.common.response.ApiResponse;
import com.blog.series.dto.SeriesAdminResponse;
import com.blog.series.dto.SeriesPostsRequest;
import com.blog.series.dto.SeriesRequest;
import com.blog.series.service.SeriesService;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Series administration. ADMIN only, enforced by the URL rule {@code /api/v1/admin/series/**} in SecurityConfig and not
 * by {@code @PreAuthorize}: a series gathers posts of every author, so nothing here depends on what the caller owns,
 * like {@code /api/v1/admin/users/**}.
 */
@RestController
@RequestMapping("/api/v1/admin/series")
@RequiredArgsConstructor
public class AdminSeriesController {

    private final SeriesService seriesService;

    @GetMapping
    public ApiResponse<List<SeriesAdminResponse>> list() {
        return ApiResponse.of(seriesService.listAll());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<SeriesAdminResponse> create(@Valid @RequestBody SeriesRequest request) {
        return ApiResponse.of(seriesService.create(request));
    }

    @GetMapping("/{id}")
    public ApiResponse<SeriesAdminResponse> getById(@PathVariable UUID id) {
        return ApiResponse.of(seriesService.getById(id));
    }

    @PutMapping("/{id}")
    public ApiResponse<SeriesAdminResponse> update(@PathVariable UUID id, @Valid @RequestBody SeriesRequest request) {
        return ApiResponse.of(seriesService.update(id, request));
    }

    /** The only route that writes membership: replaces the whole list of posts, positions 1..n in the order sent. */
    @PutMapping("/{id}/posts")
    public ApiResponse<SeriesAdminResponse> setPosts(
            @PathVariable UUID id, @Valid @RequestBody SeriesPostsRequest request) {
        return ApiResponse.of(seriesService.setPosts(id, request.postIds()));
    }

    /** Detaches the posts from the series, then deletes the series; the posts stay intact. */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        seriesService.delete(id);
    }
}
