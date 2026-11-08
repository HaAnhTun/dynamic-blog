package com.blog.sitecontent.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.media.entity.Media;
import com.blog.media.service.MediaService;
import com.blog.media.service.PreparedUpload;
import com.blog.sitecontent.dto.SiteContentAdminResponse;
import com.blog.sitecontent.dto.SiteContentAvatarResponse;
import com.blog.sitecontent.dto.SiteContentDocument;
import com.blog.sitecontent.dto.SiteContentImportResponse;
import com.blog.sitecontent.dto.SiteContentPublicResponse;
import com.blog.sitecontent.dto.SiteContentRequest;
import com.blog.sitecontent.dto.SiteContentRevisionResponse;
import com.blog.sitecontent.dto.SiteContentSectionResponse;
import com.blog.sitecontent.dto.SiteContentSectionState;
import com.blog.sitecontent.repository.SiteContentRepository;
import com.blog.sitecontent.repository.SiteContentRepository.Revision;
import com.blog.sitecontent.repository.SiteContentRepository.Row;
import com.blog.sitecontent.schema.SiteContentKey;
import com.blog.sitecontent.schema.SiteContentSchemas;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The owner's site content per locale: the public read with its fallback chain, and administration (ADMIN only, URL
 * rule). Every write validates through {@link SiteContentSchemas}, keeps a revision of the row it replaces and prunes
 * the revisions, all in one transaction that holds a lock on the (key, locale) pair.
 *
 * Nothing logs a payload value: only keys, locales and counts.
 */
@Service
@RequiredArgsConstructor
public class SiteContentService {

    private static final Logger log = LoggerFactory.getLogger(SiteContentService.class);

    /** Largest import body, counted over the payloads (compact JSON). */
    static final int MAX_IMPORT_BYTES = 512 * 1024;

    private final SiteContentRepository repository;
    private final SiteContentSchemas schemas;
    private final Languages languages;
    private final RateLimiter rateLimiter;
    private final MediaService mediaService;
    private final ObjectMapper objectMapper;

    // --- Public --------------------------------------------------------------------------------------------

    /** For each key: the row of the locale, else the row of the default locale, else the key is absent. */
    @Transactional(readOnly = true)
    public SiteContentPublicResponse publicContent(String locale) {
        String wanted = locale == null || locale.isBlank() ? languages.defaultLocale() : languages.require(locale);
        List<String> wantedLocales =
                wanted.equals(languages.defaultLocale()) ? List.of(wanted) : List.of(wanted, languages.defaultLocale());
        Map<String, Row> rows = repository.findByLocales(wantedLocales).stream()
                .collect(Collectors.toMap(row -> row.locale() + ":" + row.key(), Function.identity()));
        Map<String, JsonNode> sections = new LinkedHashMap<>();
        for (SiteContentKey key : SiteContentKey.values()) {
            Row row =
                    rows.getOrDefault(wanted + ":" + key.key(), rows.get(languages.defaultLocale() + ":" + key.key()));
            if (row == null) {
                continue;
            }
            try {
                sections.put(key.key(), upgraded(key, row));
            } catch (ApiException e) {
                // A row this build cannot read must not take the public site down: the frontend uses its default.
                log.warn("site content row skipped key={} locale={}", key.key(), row.locale());
            }
        }
        return new SiteContentPublicResponse(wanted, languages.defaultLocale(), languages.enabled(), sections);
    }

    // --- Admin reads ---------------------------------------------------------------------------------------

    @Transactional(readOnly = true)
    public SiteContentAdminResponse adminList(String locale) {
        String wanted = languages.require(locale);
        Map<String, SiteContentSectionState> sections = new LinkedHashMap<>();
        Map<String, Row> rows = repository.findByLocales(List.of(wanted)).stream()
                .collect(Collectors.toMap(Row::key, Function.identity()));
        for (SiteContentKey key : SiteContentKey.values()) {
            Row row = rows.get(key.key());
            if (row != null) {
                sections.put(key.key(), state(key, row));
            }
        }
        return new SiteContentAdminResponse(wanted, languages.defaultLocale(), languages.enabled(), sections);
    }

    @Transactional(readOnly = true)
    public SiteContentSectionResponse adminGet(String keyName, String locale) {
        SiteContentKey key = parseKey(keyName);
        String wanted = languages.require(locale);
        return read(key, wanted);
    }

    @Transactional(readOnly = true)
    public List<SiteContentRevisionResponse> revisions(String keyName, String locale) {
        SiteContentKey key = parseKey(keyName);
        String wanted = languages.require(locale);
        return repository.listRevisions(key.key(), wanted).stream()
                .map(r -> new SiteContentRevisionResponse(r.id(), r.schemaVersion(), r.createdAt()))
                .toList();
    }

    @Transactional(readOnly = true)
    public SiteContentDocument export(String locale) {
        String wanted = languages.require(locale);
        Map<String, Row> rows = repository.findByLocales(List.of(wanted)).stream()
                .collect(Collectors.toMap(Row::key, Function.identity()));
        Map<String, SiteContentRequest> sections = new LinkedHashMap<>();
        for (SiteContentKey key : SiteContentKey.values()) {
            Row row = rows.get(key.key());
            if (row != null) {
                sections.put(key.key(), new SiteContentRequest(schemas.currentVersion(key), upgraded(key, row)));
            }
        }
        return new SiteContentDocument(
                SiteContentDocument.FORMAT, SiteContentDocument.FORMAT_VERSION, wanted, sections);
    }

    // --- Admin writes --------------------------------------------------------------------------------------

    @Transactional
    public SiteContentSectionResponse put(String keyName, String locale, SiteContentRequest request, UUID userId) {
        rateLimiter.check(RateLimiter.SITE_CONTENT_WRITE, userId);
        SiteContentKey key = parseKey(keyName);
        String wanted = languages.require(locale);
        JsonNode payload = schemas.validate(key, request.schemaVersion(), request.payload());
        repository.lock(key.key(), wanted);
        Optional<Row> existing = repository.find(key.key(), wanted);
        // Saving what is already stored changes nothing and must not push a real older version out of the kept ten.
        if (existing.isPresent() && sameContent(key, existing.get(), payload)) {
            return read(key, wanted);
        }
        write(key, wanted, schemas.currentVersion(key), payload, userId);
        log.info("site content saved key={} locale={} actor={}", key.key(), wanted, userId);
        return read(key, wanted);
    }

    @Transactional
    public SiteContentSectionResponse restore(String keyName, String locale, long revisionId, UUID userId) {
        rateLimiter.check(RateLimiter.SITE_CONTENT_WRITE, userId);
        SiteContentKey key = parseKey(keyName);
        String wanted = languages.require(locale);
        repository.lock(key.key(), wanted);
        Revision revision = repository
                .findRevision(key.key(), wanted, revisionId)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.SITE_CONTENT_REVISION_NOT_FOUND, HttpStatus.NOT_FOUND, "Revision not found"));
        // A revision is checked again against today's validators: a rule tightened since it was saved must not let it
        // back in.
        JsonNode payload = schemas.validate(key, revision.schemaVersion(), parse(revision.data()));
        write(key, wanted, schemas.currentVersion(key), payload, userId);
        log.info("site content restored key={} locale={} actor={}", key.key(), wanted, userId);
        return read(key, wanted);
    }

    /** Every section is validated first; any problem rejects the whole document and nothing is written. */
    @Transactional
    public SiteContentImportResponse importDocument(SiteContentDocument document, UUID userId) {
        rateLimiter.check(RateLimiter.SITE_CONTENT_WRITE, userId);
        List<String> problems = new ArrayList<>();
        if (!SiteContentDocument.FORMAT.equals(document.format())) {
            problems.add("/format: must be " + SiteContentDocument.FORMAT);
        }
        if (document.formatVersion() == null || document.formatVersion() != SiteContentDocument.FORMAT_VERSION) {
            problems.add("/formatVersion: must be " + SiteContentDocument.FORMAT_VERSION);
        }
        String wanted = languages.require(document.locale());
        Map<String, SiteContentRequest> given = document.sections() == null ? Map.of() : document.sections();
        if (document.sections() == null) {
            problems.add("/sections: is required");
        }
        if (tooLarge(given)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.CONTENT_TOO_LARGE, "The import document is too large");
        }
        Map<SiteContentKey, JsonNode> checked = new LinkedHashMap<>();
        for (SiteContentKey key : SiteContentKey.values()) {
            SiteContentRequest section = given.get(key.key());
            if (section == null) {
                continue;
            }
            SiteContentSchemas.Checked result =
                    schemas.check(key, section.schemaVersion(), section.payload(), "/sections/" + key.key());
            problems.addAll(result.problems());
            checked.put(key, result.payload());
        }
        for (Map.Entry<String, SiteContentRequest> entry : given.entrySet()) {
            if (SiteContentKey.find(entry.getKey()).isEmpty()) {
                problems.add("/sections: contains an unknown key");
                break;
            }
            if (entry.getValue() == null) {
                problems.add("/sections/" + entry.getKey() + ": must be an object");
            }
        }
        if (!problems.isEmpty()) {
            throw SiteContentSchemas.invalid(problems);
        }
        List<SiteContentImportResponse.Section> statuses = new ArrayList<>();
        for (Map.Entry<SiteContentKey, JsonNode> entry : checked.entrySet()) {
            SiteContentKey key = entry.getKey();
            repository.lock(key.key(), wanted);
            Optional<Row> existing = repository.find(key.key(), wanted);
            String status;
            if (existing.isEmpty()) {
                status = "created";
            } else if (sameContent(key, existing.get(), entry.getValue())) {
                status = "unchanged";
            } else {
                status = "updated";
            }
            if (!"unchanged".equals(status)) {
                repository.snapshot(key.key(), wanted, userId);
                repository.upsert(key.key(), wanted, schemas.currentVersion(key), json(entry.getValue()), userId);
                repository.pruneRevisions(key.key(), wanted);
            }
            statuses.add(new SiteContentImportResponse.Section(key.key(), status));
        }
        log.info("site content imported locale={} sections={}", wanted, statuses.size());
        return new SiteContentImportResponse(wanted, statuses);
    }

    /**
     * Stores an image for {@code profile.avatar} through the one media pipeline (type, size and dimension checks, EXIF
     * removal, quota). It creates no gallery photo and attaches no post; the URL is what the profile field accepts.
     */
    public SiteContentAvatarResponse uploadAvatar(MultipartFile file, UUID userId) {
        rateLimiter.check(RateLimiter.SITE_CONTENT_WRITE, userId);
        PreparedUpload prepared = mediaService.prepare(file);
        Media media = mediaService.persist(prepared, null, userId);
        log.info("site content avatar stored");
        return new SiteContentAvatarResponse("/media/" + media.fileName());
    }

    // --- Internals -----------------------------------------------------------------------------------------

    private void write(SiteContentKey key, String locale, int version, JsonNode payload, UUID userId) {
        repository.lock(key.key(), locale);
        repository.snapshot(key.key(), locale, userId);
        repository.upsert(key.key(), locale, version, json(payload), userId);
        repository.pruneRevisions(key.key(), locale);
    }

    private SiteContentSectionResponse read(SiteContentKey key, String locale) {
        Row row = repository
                .find(key.key(), locale)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.SITE_CONTENT_NOT_FOUND, HttpStatus.NOT_FOUND, "No content stored for this key"));
        return new SiteContentSectionResponse(
                key.key(), locale, schemas.currentVersion(key), row.updatedAt(), upgraded(key, row));
    }

    private SiteContentSectionState state(SiteContentKey key, Row row) {
        return new SiteContentSectionState(schemas.currentVersion(key), row.updatedAt(), upgraded(key, row));
    }

    private JsonNode upgraded(SiteContentKey key, Row row) {
        return schemas.upgradeStored(key, row.schemaVersion(), parse(row.data()));
    }

    private boolean sameContent(SiteContentKey key, Row existing, JsonNode payload) {
        try {
            return upgraded(key, existing).equals(payload);
        } catch (ApiException e) {
            return false;
        }
    }

    private boolean tooLarge(Map<String, SiteContentRequest> sections) {
        long total = 0;
        for (SiteContentRequest section : sections.values()) {
            if (section != null && section.payload() != null) {
                total += section.payload().toString().length();
                if (total > MAX_IMPORT_BYTES) {
                    return true;
                }
            }
        }
        return false;
    }

    private SiteContentKey parseKey(String name) {
        return SiteContentKey.find(name)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "Unknown site content key"));
    }

    private JsonNode parse(String text) {
        try {
            return objectMapper.readTree(text);
        } catch (JacksonException e) {
            throw new IllegalStateException("stored site content is not JSON");
        }
    }

    private String json(JsonNode node) {
        return objectMapper.writeValueAsString(node);
    }
}
