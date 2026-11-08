package com.blog.postimport.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.exception.ErrorCode;
import com.blog.common.response.ApiResponse;
import com.blog.common.response.ErrorResponse;
import com.blog.postimport.dto.PostApplyResponse;
import com.blog.postimport.dto.PostArticlePreviewResponse;
import com.blog.postimport.dto.PostImportStatusResponse;
import com.blog.postimport.dto.PostPreviewResponse;
import com.blog.postimport.service.PostImportService;
import com.blog.siteimport.dto.MarkdownDownload;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * The Markdown post import. Admins and authors, by the URL rule {@code /api/v1/admin/post-import/**} in SecurityConfig (one of
 * the trees an AUTHOR may enter): a reader account is 403 and an anonymous caller 401. Which posts the caller may manage is
 * decided in the service, because there is no post id in the URL for an ownership annotation. The template is the Markdown file
 * itself; the other endpoints answer in the usual envelope.
 *
 * <p>A file part is a Markdown file or a ZIP package (an article and the images it uses). An apply is one multipart request: a {@code file} part per post file (at most 20, in the order of the preview) and exactly
 * one text part, {@code manifest}, a JSON array with one item per file (its SHA-256, whether it is selected and the opaque
 * preview state). That is at most 21 parts, below the container's limit of 50.
 */
@RestController
@RequestMapping("/api/v1/admin/post-import")
@RequiredArgsConstructor
public class AdminPostImportController {

    static final MediaType MARKDOWN = new MediaType("text", "markdown", StandardCharsets.UTF_8);

    private static final Logger log = LoggerFactory.getLogger(AdminPostImportController.class);

    private final PostImportService postImportService;

    @GetMapping("/template")
    public ResponseEntity<String> template(@RequestParam(name = "language", required = false) String language) {
        MarkdownDownload file = postImportService.template(language);
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

    @PostMapping(path = "/preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<PostPreviewResponse> preview(
            @RequestParam(name = "file", required = false) List<MultipartFile> files) {
        return ApiResponse.of(postImportService.preview(
                files, AuthenticatedUser.requireUserId(), AuthenticatedUser.hasRole("ADMIN")));
    }

    /**
     * The article of ONE file (a Markdown file or a ZIP package) with the images of a package inlined, for the page that shows
     * it as it will look. Writes nothing; counts as one use of the same bucket as the preview.
     */
    @PostMapping(path = "/article-preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<PostArticlePreviewResponse> articlePreview(
            @RequestParam(name = "file", required = false) MultipartFile file) {
        return ApiResponse.of(postImportService.articlePreview(file, AuthenticatedUser.requireUserId()));
    }

    @PostMapping(path = "/apply", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<PostApplyResponse> apply(
            @RequestParam(name = "file", required = false) List<MultipartFile> files,
            @RequestParam(name = "manifest", required = false) String manifest) {
        return ApiResponse.of(postImportService.apply(
                files, manifest, AuthenticatedUser.requireUserId(), AuthenticatedUser.hasRole("ADMIN")));
    }

    /** The caller's own latest import; never anybody else's. */
    @GetMapping("/status")
    public ApiResponse<PostImportStatusResponse> status() {
        return ApiResponse.of(postImportService.status(AuthenticatedUser.requireUserId()));
    }

    /**
     * A constraint that is only checked when the transaction commits, after the service has returned. The general handler logs
     * the whole exception, whose message names the violated constraint and the value; this one logs a code and a trace id only
     * and answers that the data changed since the preview.
     */
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<ErrorResponse> dataIntegrity() {
        String traceId = UUID.randomUUID().toString();
        log.warn("post import not committed code={} traceId={}", ErrorCode.POST_IMPORT_PREVIEW_OUT_OF_DATE, traceId);
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .contentType(MediaType.APPLICATION_JSON)
                .body(new ErrorResponse(new ErrorResponse.ErrorBody(
                        ErrorCode.POST_IMPORT_PREVIEW_OUT_OF_DATE.name(),
                        "The data changed while importing; preview again",
                        traceId)));
    }
}
