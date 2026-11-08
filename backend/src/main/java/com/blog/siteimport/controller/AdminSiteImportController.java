package com.blog.siteimport.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.response.ApiResponse;
import com.blog.siteimport.dto.ApplyResponse;
import com.blog.siteimport.dto.MarkdownDownload;
import com.blog.siteimport.dto.PackageDownload;
import com.blog.siteimport.dto.PreviewResponse;
import com.blog.siteimport.dto.StatusResponse;
import com.blog.siteimport.dto.UndoResponse;
import com.blog.siteimport.service.SiteImportService;
import java.nio.charset.StandardCharsets;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * The Markdown profile import. ADMIN only, enforced by the URL rule {@code /api/v1/admin/site-import/**} in
 * SecurityConfig. The two downloads are the Markdown file itself; everything else answers in the usual envelope.
 */
@RestController
@RequestMapping("/api/v1/admin/site-import")
@RequiredArgsConstructor
public class AdminSiteImportController {

    static final MediaType MARKDOWN = new MediaType("text", "markdown", StandardCharsets.UTF_8);
    static final MediaType ZIP = MediaType.parseMediaType("application/zip");

    private final SiteImportService siteImportService;

    @GetMapping("/template")
    public ResponseEntity<String> template(@RequestParam(name = "locale", required = false) String locale) {
        return download(siteImportService.template(locale));
    }

    /** The stored content of one language: the Markdown file (the default) or, with format=zip, a ZIP package. */
    @GetMapping("/export")
    public ResponseEntity<?> export(
            @RequestParam(name = "locale", required = false) String locale,
            @RequestParam(name = "format", required = false) String format) {
        if (format == null || format.isBlank() || "md".equals(format)) {
            return download(siteImportService.export(locale));
        }
        if ("zip".equals(format)) {
            return download(siteImportService.exportPackage(locale));
        }
        throw new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "format must be md or zip");
    }

    @PostMapping(path = "/preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<PreviewResponse> preview(@RequestParam(name = "file", required = false) MultipartFile file) {
        return ApiResponse.of(siteImportService.preview(file, AuthenticatedUser.requireUserId()));
    }

    @PostMapping(path = "/apply", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<ApplyResponse> apply(
            @RequestParam(name = "file", required = false) MultipartFile file,
            @RequestParam(name = "sha256", required = false) String sha256,
            @RequestParam(name = "mode", required = false) String mode,
            @RequestParam(name = "sections", required = false) List<String> sections) {
        return ApiResponse.of(siteImportService.apply(file, sha256, mode, sections, AuthenticatedUser.requireUserId()));
    }

    /** Undoes the import the caller names (form or query {@code importId}); a newer import makes it a 409. */
    @PostMapping("/undo")
    public ApiResponse<UndoResponse> undo(@RequestParam(name = "importId", required = false) Long importId) {
        return ApiResponse.of(siteImportService.undo(importId, AuthenticatedUser.requireUserId()));
    }

    @GetMapping("/status")
    public ApiResponse<StatusResponse> status() {
        return ApiResponse.of(siteImportService.status());
    }

    private static ResponseEntity<byte[]> download(PackageDownload file) {
        return ResponseEntity.ok()
                .header(
                        HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename(file.filename())
                                .build()
                                .toString())
                .header("X-Content-Type-Options", "nosniff")
                .cacheControl(CacheControl.noStore())
                .contentType(ZIP)
                .body(file.content());
    }

    private static ResponseEntity<String> download(MarkdownDownload file) {
        return ResponseEntity.ok()
                .header(
                        HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename(file.filename())
                                .build()
                                .toString())
                .contentType(MARKDOWN)
                .body(file.content());
    }
}
