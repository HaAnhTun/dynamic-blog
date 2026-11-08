package com.blog.post.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.postimport.service.PostExportService;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The "Download ZIP" of the post editor: the saved post as a post package, the format the post import reads. The same rule as
 * every route that names a post ({@link AdminPostController#CAN_MANAGE}): ADMIN for every post, AUTHOR for its own; a post that
 * does not exist is 403 for an AUTHOR and 404 for an ADMIN. The file name is the slug, ASCII only.
 */
@RestController
@RequestMapping("/api/v1/admin/posts/{id}/export")
@RequiredArgsConstructor
public class AdminPostExportController {

    static final MediaType ZIP = MediaType.parseMediaType("application/zip");

    private final PostExportService postExportService;

    @GetMapping
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public ResponseEntity<byte[]> export(@PathVariable UUID id) {
        PostExportService.Export file = postExportService.export(id, AuthenticatedUser.hasRole("ADMIN"));
        return ResponseEntity.ok()
                .header(
                        HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename(file.fileName())
                                .build()
                                .toString())
                .header("X-Content-Type-Options", "nosniff")
                .cacheControl(CacheControl.noStore())
                .contentType(ZIP)
                .body(file.bytes());
    }
}
