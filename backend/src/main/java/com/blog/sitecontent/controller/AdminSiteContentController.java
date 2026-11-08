package com.blog.sitecontent.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.sitecontent.dto.SiteContentAdminResponse;
import com.blog.sitecontent.dto.SiteContentAvatarResponse;
import com.blog.sitecontent.dto.SiteContentDocument;
import com.blog.sitecontent.dto.SiteContentImportResponse;
import com.blog.sitecontent.dto.SiteContentRequest;
import com.blog.sitecontent.dto.SiteContentRevisionResponse;
import com.blog.sitecontent.dto.SiteContentSectionResponse;
import com.blog.sitecontent.service.SiteContentService;
import jakarta.validation.Valid;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * Site content administration. ADMIN only, enforced by the URL rule {@code /api/v1/admin/site-content/**} in
 * SecurityConfig and not by {@code @PreAuthorize}: the content belongs to the site, like series and the gallery. The
 * literal paths (export, import, avatar) are registered next to {@code /{key}} and win over it.
 */
@RestController
@RequestMapping("/api/v1/admin/site-content")
@RequiredArgsConstructor
public class AdminSiteContentController {

    private final SiteContentService siteContentService;

    @GetMapping
    public ApiResponse<SiteContentAdminResponse> list(@RequestParam(name = "locale", required = false) String locale) {
        return ApiResponse.of(siteContentService.adminList(locale));
    }

    /** The export file: the document itself, not wrapped in the usual envelope, so it can be imported as it is. */
    @GetMapping("/export")
    public ResponseEntity<SiteContentDocument> export(@RequestParam(name = "locale", required = false) String locale) {
        SiteContentDocument document = siteContentService.export(locale);
        return ResponseEntity.ok()
                .header(
                        HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename("site-content-" + document.locale() + ".json")
                                .build()
                                .toString())
                .contentType(MediaType.APPLICATION_JSON)
                .body(document);
    }

    @PostMapping("/import")
    public ApiResponse<SiteContentImportResponse> importDocument(@RequestBody SiteContentDocument document) {
        return ApiResponse.of(siteContentService.importDocument(document, AuthenticatedUser.requireUserId()));
    }

    /** One image per request, through the media pipeline; creates no gallery photo and attaches no post. */
    @PostMapping(path = "/avatar", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<SiteContentAvatarResponse> uploadAvatar(
            @RequestParam(name = "file", required = false) MultipartFile file) {
        return ApiResponse.of(siteContentService.uploadAvatar(file, AuthenticatedUser.requireUserId()));
    }

    @GetMapping("/{key}")
    public ApiResponse<SiteContentSectionResponse> get(
            @PathVariable String key, @RequestParam(name = "locale", required = false) String locale) {
        return ApiResponse.of(siteContentService.adminGet(key, locale));
    }

    @PutMapping("/{key}")
    public ApiResponse<SiteContentSectionResponse> put(
            @PathVariable String key,
            @RequestParam(name = "locale", required = false) String locale,
            @Valid @RequestBody SiteContentRequest request) {
        return ApiResponse.of(siteContentService.put(key, locale, request, AuthenticatedUser.requireUserId()));
    }

    @GetMapping("/{key}/revisions")
    public ApiResponse<List<SiteContentRevisionResponse>> revisions(
            @PathVariable String key, @RequestParam(name = "locale", required = false) String locale) {
        return ApiResponse.of(siteContentService.revisions(key, locale));
    }

    @PostMapping("/{key}/revisions/{id}/restore")
    public ApiResponse<SiteContentSectionResponse> restore(
            @PathVariable String key,
            @PathVariable long id,
            @RequestParam(name = "locale", required = false) String locale) {
        return ApiResponse.of(siteContentService.restore(key, locale, id, AuthenticatedUser.requireUserId()));
    }
}
