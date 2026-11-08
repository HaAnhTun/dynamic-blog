package com.blog.media.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.fixtures.vi.ContentFilenameVi;
import com.blog.media.config.MediaProperties;
import com.blog.media.entity.Media;
import com.blog.media.entity.MediaContent;
import com.blog.media.repository.MediaContentRepository;
import com.blog.media.repository.MediaRepository;
import com.blog.support.AuthorQuotaTestProperties;
import com.blog.support.RateLimitTestProperties;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.util.unit.DataSize;
import org.springframework.web.multipart.MultipartFile;

/**
 * The part of MediaService that needs no DB: checking the file before reading it, the semaphore, the quota, normalizing strings sent by the
 * uploader. The quota and the wait time are set directly in MediaProperties here instead of through
 * {@code @TestPropertySource} in an IT: every different property set would add one more Spring context.
 */
@ExtendWith(MockitoExtension.class)
class MediaServiceTest {

    /** A small quota so that "nearly full" means a few bytes, not a gigabyte. */
    private static final long QUOTA = 10_000;

    private static final int MAX_UPLOAD = 1024;
    private static final Duration WAIT = Duration.ofMillis(50);

    @Mock
    private ImageProcessor imageProcessor;

    @Mock
    private MediaRepository mediaRepository;

    @Mock
    private MediaContentRepository mediaContentRepository;

    private MediaService service;

    @BeforeEach
    void setUp() {
        MediaProperties properties = new MediaProperties(
                DataSize.ofBytes(MAX_UPLOAD),
                DataSize.ofMegabytes(4),
                50_000_000L,
                2400,
                0.85f,
                DataSize.ofBytes(QUOTA),
                1,
                WAIT);
        service = new MediaService(
                imageProcessor,
                properties,
                mediaRepository,
                mediaContentRepository,
                new RateLimiter(RateLimitTestProperties.defaults()),
                AuthorQuotaTestProperties.defaults());
    }

    // --- prepare: check the file before doing any work ------------------------------------------------

    @Test
    void empty_or_missing_file_is_rejected_400_before_reaching_the_pipeline() {
        assertRejected(() -> service.prepare(file("anh.jpg", new byte[0])), ErrorCode.VALIDATION_ERROR, 400);
        assertRejected(() -> service.prepare(null), ErrorCode.VALIDATION_ERROR, 400);
        verifyNoInteractions(imageProcessor);

        // Control: one byte is enough to reach the pipeline, so the 400 above is because the file is empty.
        when(imageProcessor.process(any())).thenReturn(processed(10));
        assertThat(service.prepare(file("anh.jpg", new byte[1])).image()).isNotNull();
    }

    @Test
    void file_over_max_upload_size_is_rejected_413_without_reading_content() throws Exception {
        // The size declared in the part is enough to reject: do not pull 11 MB into the heap only to throw it away.
        MultipartFile huge = mock(MultipartFile.class);
        when(huge.isEmpty()).thenReturn(false);
        when(huge.getSize()).thenReturn(MAX_UPLOAD + 1L);

        assertRejected(() -> service.prepare(huge), ErrorCode.MEDIA_TOO_LARGE, 413);

        verify(huge, never()).getBytes();
        verify(huge, never()).getInputStream();
        verifyNoInteractions(imageProcessor);

        // Control at the exact boundary: equal to max-upload-size is still accepted.
        when(imageProcessor.process(any())).thenReturn(processed(10));
        assertThat(service.prepare(file("anh.jpg", new byte[MAX_UPLOAD])).image())
                .isNotNull();
    }

    @Test
    void prepare_passes_the_uploaded_bytes_to_the_pipeline_and_keeps_the_sanitized_file_name() {
        byte[] uploaded = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, 1, 2, 3};
        ProcessedImage image = processed(10);
        when(imageProcessor.process(uploaded)).thenReturn(image);

        PreparedUpload prepared = service.prepare(file("../../x\u0007.jpg", uploaded));

        assertThat(prepared.image()).isSameAs(image);
        assertThat(prepared.originalFilename()).isEqualTo("x.jpg");
    }

    @Test
    void an_image_in_memory_gets_the_same_checks_the_pipeline_and_the_sanitized_name() {
        assertRejected(() -> service.prepare(new byte[0], "a.png"), ErrorCode.VALIDATION_ERROR, 400);
        assertRejected(() -> service.prepare((byte[]) null, "a.png"), ErrorCode.VALIDATION_ERROR, 400);
        assertRejected(() -> service.prepare(new byte[MAX_UPLOAD + 1], "a.png"), ErrorCode.MEDIA_TOO_LARGE, 413);
        verifyNoInteractions(imageProcessor);

        byte[] data = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, 1, 2, 3};
        ProcessedImage image = processed(10);
        when(imageProcessor.process(data)).thenReturn(image);

        PreparedUpload prepared = service.prepare(data, "assets/../x\u0007.jpg");

        assertThat(prepared.image()).isSameAs(image);
        assertThat(prepared.originalFilename()).isEqualTo("x.jpg");
    }

    private static String cp(int codePoint) {
        return new String(Character.toChars(codePoint));
    }

    static Stream<Arguments> fileNames() {
        String longName = "a".repeat(300) + ".jpg";
        // 254 letters then an emoji (2 UTF-16 units, 1 character): cut at 255 CHARACTERS like Postgres's VARCHAR(255),
        // and never split a surrogate pair in half.
        String emojiAtTheEdge = "b".repeat(254) + "\uD83D\uDCF7" + "tail.png";
        return Stream.of(
                Arguments.of("../../x\u0007.jpg", "x.jpg"),
                Arguments.of(ContentFilenameVi.WINDOWS_PATH, "IMG_0001.JPG"),
                Arguments.of(ContentFilenameVi.UNIX_PATH, ContentFilenameVi.UNIX_NAME),
                Arguments.of(ContentFilenameVi.PADDED, ContentFilenameVi.PADDED_TRIMMED),
                Arguments.of(ContentFilenameVi.WITH_CONTROL_CHARS, ContentFilenameVi.WITHOUT_CONTROL_CHARS),
                Arguments.of("\u0000\u001f", null),
                Arguments.of("invoice" + cp(0x202E) + "gpj.exe.png", "invoicegpj.exe.png"),
                Arguments.of("a" + cp(0x200B) + "b" + cp(0x200D) + "c.png", "ab" + cp(0x200D) + "c.png"),
                Arguments.of("folder-name/", null),
                Arguments.of("", null),
                Arguments.of(null, null),
                Arguments.of(longName, "a".repeat(255)),
                Arguments.of(emojiAtTheEdge, "b".repeat(254) + "\uD83D\uDCF7"));
    }

    @ParameterizedTest(name = "[{index}] {1}")
    @MethodSource("fileNames")
    void original_file_name_keeps_only_basename_drops_control_characters_and_max_255_characters(
            String raw, String expected) {
        String cleaned = MediaService.cleanOriginalFilename(raw);

        assertThat(cleaned).isEqualTo(expected);
        if (cleaned != null) {
            assertThat(cleaned.codePointCount(0, cleaned.length())).isLessThanOrEqualTo(255);
            assertThat(cleaned.chars().noneMatch(Character::isISOControl)).isTrue();
        }
    }

    // --- prepare: semaphore ----------------------------------------------------------------------

    @Test
    void only_one_image_is_processed_at_a_time_second_image_waiting_past_the_deadline_is_503() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ProcessedImage image = processed(10);
        when(imageProcessor.process(any())).thenAnswer(invocation -> {
            entered.countDown();
            // Hold the permit until the test allows: this is "a large image is being processed".
            if (!release.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("test does not release the first image");
            }
            return image;
        });
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<PreparedUpload> first = pool.submit(() -> service.prepare(file("mot.jpg", new byte[10])));
            assertThat(entered.await(5, TimeUnit.SECONDS))
                    .as("first image has entered the pipeline")
                    .isTrue();

            long start = System.nanoTime();
            assertRejected(() -> service.prepare(file("hai.jpg", new byte[10])), ErrorCode.MEDIA_BUSY, 503);
            // It WAITED for processing-wait and only then gave up, not an immediate rejection (the Windows clock is
            // coarse, ~15 ms).
            assertThat(Duration.ofNanos(System.nanoTime() - start)).isGreaterThanOrEqualTo(WAIT.minusMillis(10));

            release.countDown();
            assertThat(first.get(5, TimeUnit.SECONDS).image()).isSameAs(image);
            // The permit has been returned: the next image goes through.
            assertThat(service.prepare(file("ba.jpg", new byte[10])).image()).isSameAs(image);
            // The second image never reaches the pipeline.
            verify(imageProcessor, times(2)).process(any());
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void permit_is_returned_even_when_the_pipeline_throws() {
        when(imageProcessor.process(any()))
                .thenThrow(new ApiException(ErrorCode.MEDIA_UNREADABLE, HttpStatus.UNPROCESSABLE_CONTENT, "broken"))
                .thenReturn(processed(10));

        assertRejected(() -> service.prepare(file("hong.jpg", new byte[10])), ErrorCode.MEDIA_UNREADABLE, 422);
        // A permit leaked after one broken image would make every later upload 503 until restart.
        assertThat(service.prepare(file("tot.jpg", new byte[10])).image()).isNotNull();
    }

    // --- persist ---------------------------------------------------------------------------------

    @Test
    void persist_writes_metadata_and_bytes_to_two_tables_with_the_same_id() {
        ProcessedImage image = processed(64);
        UUID id = UUID.randomUUID();
        UUID uploader = UUID.randomUUID();
        when(mediaRepository.sumByteSize()).thenReturn(0L);
        when(mediaRepository.save(any(Media.class))).thenAnswer(invocation -> {
            Media media = invocation.getArgument(0);
            media.setId(id);
            return media;
        });

        Media saved = service.persist(new PreparedUpload(image, "x.jpg"), "  Image description  ", uploader);

        assertThat(saved.getId()).isEqualTo(id);
        assertThat(saved.getContentType()).isEqualTo("image/jpeg");
        assertThat(saved.getWidth()).isEqualTo(20);
        assertThat(saved.getHeight()).isEqualTo(30);
        assertThat(saved.getByteSize()).isEqualTo(64);
        assertThat(saved.getSha256()).isEqualTo(image.sha256());
        assertThat(saved.getDominantColor()).isEqualTo("#336699");
        assertThat(saved.getAltText()).isEqualTo("Image description");
        assertThat(saved.getOriginalFilename()).isEqualTo("x.jpg");
        assertThat(saved.getUploadedBy()).isEqualTo(uploader);
        ArgumentCaptor<MediaContent> content = ArgumentCaptor.forClass(MediaContent.class);
        verify(mediaContentRepository).save(content.capture());
        assertThat(content.getValue().getId()).isEqualTo(id);
        assertThat(content.getValue().getData()).isSameAs(image.bytes());
        // The stored bytes are NEW bytes: Spring Data must not merge (a redundant SELECT on a table of 4 MB per image).
        assertThat(content.getValue().isNew()).isTrue();
    }

    @Test
    void over_quota_is_422_and_writes_nothing() {
        when(mediaRepository.sumByteSize()).thenReturn(QUOTA - 9);

        assertRejected(
                () -> service.persist(new PreparedUpload(processed(10), "x.jpg"), null, null),
                ErrorCode.MEDIA_QUOTA_EXCEEDED,
                422);

        verify(mediaRepository, never()).save(any());
        verifyNoInteractions(mediaContentRepository);
    }

    @Test
    void exactly_fitting_quota_is_still_stored() {
        // Boundary: "over" means greater than the quota, not equal.
        when(mediaRepository.sumByteSize()).thenReturn(QUOTA - 10);
        when(mediaRepository.save(any(Media.class))).thenAnswer(invocation -> invocation.getArgument(0));

        Media saved = service.persist(new PreparedUpload(processed(10), null), null, null);

        assertThat(saved.getByteSize()).isEqualTo(10);
        verify(mediaContentRepository).save(any(MediaContent.class));
    }

    @Test
    void replacing_an_image_counts_quota_as_if_the_old_image_were_gone_only_the_increase() {
        UUID old = UUID.randomUUID();
        Media replaced = media(old, "image/jpeg");
        replaced.setByteSize(20);
        when(mediaRepository.findById(old)).thenReturn(Optional.of(replaced));
        when(mediaRepository.sumByteSize()).thenReturn(QUOTA - 5);
        when(mediaRepository.save(any(Media.class))).thenAnswer(invocation -> invocation.getArgument(0));

        // Control: the same 10-byte image without replacing any image exceeds the quota (QUOTA - 5 + 10).
        assertRejected(
                () -> service.persist(new PreparedUpload(processed(10), null), null, null),
                ErrorCode.MEDIA_QUOTA_EXCEEDED,
                422);
        // Replacing a 20-byte image with a 10-byte image: after the replacement the site uses less space than before,
        // so it must be accepted.
        assertThat(service.persist(new PreparedUpload(processed(10), null), null, null, old)
                        .getByteSize())
                .isEqualTo(10);
        // Boundary: the increase exactly fits the remaining room (QUOTA - 5 - 20 + 25 = QUOTA) and is still accepted...
        assertThat(service.persist(new PreparedUpload(processed(25), null), null, null, old)
                        .getByteSize())
                .isEqualTo(25);
        // ...one byte more is 422: replacing an image is not a way around the quota.
        assertRejected(
                () -> service.persist(new PreparedUpload(processed(26), null), null, null, old),
                ErrorCode.MEDIA_QUOTA_EXCEEDED,
                422);
        verify(mediaContentRepository, times(2)).save(any(MediaContent.class));
    }

    @Test
    void replaced_image_that_no_longer_exists_counts_quota_like_a_new_image() {
        UUID gone = UUID.randomUUID();
        when(mediaRepository.findById(gone)).thenReturn(Optional.empty());
        when(mediaRepository.sumByteSize()).thenReturn(QUOTA - 9);

        // There is no image left to subtract: the stored total is the real total, so 10 bytes still exceed it like a
        // normal upload.
        assertRejected(
                () -> service.persist(new PreparedUpload(processed(10), null), null, null, gone),
                ErrorCode.MEDIA_QUOTA_EXCEEDED,
                422);
        verify(mediaRepository, never()).save(any());
        verifyNoInteractions(mediaContentRepository);
    }

    // --- Image description -----------------------------------------------------------------------

    @Test
    void image_description_is_trimmed_blank_becomes_null_and_max_300_characters() {
        UUID id = UUID.randomUUID();
        Media media = media(id, "image/jpeg");
        media.setAltText("Old description");
        when(mediaRepository.findById(id)).thenReturn(Optional.of(media));

        assertRejected(() -> service.updateAltText(id, "a".repeat(301)), ErrorCode.VALIDATION_ERROR, 400);
        assertThat(media.getAltText())
                .as("a rejected edit does not touch the old value")
                .isEqualTo("Old description");

        assertThat(service.updateAltText(id, "  Photo taken in Dalat  ").getAltText())
                .isEqualTo("Photo taken in Dalat");
        assertThat(service.updateAltText(id, "a".repeat(300)).getAltText()).hasSize(300);
        // Counted in characters like Postgres's VARCHAR(300), not in UTF-16 units: 300 emoji fit the column.
        String emoji = "\uD83D\uDCF7".repeat(300);
        assertThat(service.updateAltText(id, emoji).getAltText()).isEqualTo(emoji);
        assertThat(service.updateAltText(id, "   ").getAltText()).isNull();
        assertThat(service.updateAltText(id, null).getAltText()).isNull();
    }

    @Test
    void persist_applies_the_same_image_description_rules() {
        when(mediaRepository.sumByteSize()).thenReturn(0L);

        assertRejected(
                () -> service.persist(new PreparedUpload(processed(10), null), "a".repeat(301), null),
                ErrorCode.VALIDATION_ERROR,
                400);
        verify(mediaRepository, never()).save(any());

        when(mediaRepository.save(any(Media.class))).thenAnswer(invocation -> invocation.getArgument(0));
        assertThat(service.persist(new PreparedUpload(processed(10), null), " \t ", null)
                        .getAltText())
                .isNull();
    }

    @Test
    void editing_description_of_nonexistent_media_is_404() {
        UUID id = UUID.randomUUID();
        when(mediaRepository.findById(id)).thenReturn(Optional.empty());

        assertRejected(() -> service.updateAltText(id, "description"), ErrorCode.MEDIA_NOT_FOUND, 404);
    }

    // --- Serving ---------------------------------------------------------------------------------

    @Test
    void extension_must_match_the_stored_type() {
        UUID jpegId = UUID.randomUUID();
        UUID pngId = UUID.randomUUID();
        UUID unknownId = UUID.randomUUID();
        Media jpeg = media(jpegId, "image/jpeg");
        Media png = media(pngId, "image/png");
        when(mediaRepository.findById(jpegId)).thenReturn(Optional.of(jpeg));
        when(mediaRepository.findById(pngId)).thenReturn(Optional.of(png));
        when(mediaRepository.findById(unknownId)).thenReturn(Optional.empty());

        assertThat(service.findForServing(jpegId, "jpg")).isSameAs(jpeg);
        assertThat(service.findForServing(pngId, "png")).isSameAs(png);
        // One URL per image, so exactly one cache key: a suffix that does not match the type is 404, not an image with
        // the wrong Content-Type.
        assertRejected(() -> service.findForServing(jpegId, "png"), ErrorCode.MEDIA_NOT_FOUND, 404);
        assertRejected(() -> service.findForServing(pngId, "jpg"), ErrorCode.MEDIA_NOT_FOUND, 404);
        assertRejected(() -> service.findForServing(unknownId, "jpg"), ErrorCode.MEDIA_NOT_FOUND, 404);
    }

    @Test
    void missing_bytes_is_404() {
        UUID present = UUID.randomUUID();
        UUID gone = UUID.randomUUID();
        byte[] data = {1, 2, 3};
        when(mediaContentRepository.findDataByMediaId(present)).thenReturn(Optional.of(data));
        when(mediaContentRepository.findDataByMediaId(gone)).thenReturn(Optional.empty());

        assertThat(service.readData(present)).isSameAs(data);
        assertRejected(() -> service.readData(gone), ErrorCode.MEDIA_NOT_FOUND, 404);
    }

    // --- readData: bounded reads ------------------------------------------------------------------

    @Test
    void only_a_few_images_are_read_at_a_time_the_next_one_waiting_past_the_deadline_is_503() throws Exception {
        int limit = MediaService.MAX_CONCURRENT_READS;
        CountDownLatch entered = new CountDownLatch(limit);
        CountDownLatch release = new CountDownLatch(1);
        byte[] data = {1, 2, 3};
        when(mediaContentRepository.findDataByMediaId(any())).thenAnswer(invocation -> {
            entered.countDown();
            // Hold the permit until the test allows: this is "a crowd is reading large pictures".
            if (!release.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("test does not release the reads");
            }
            return Optional.of(data);
        });
        ExecutorService pool = Executors.newFixedThreadPool(limit);
        try {
            for (int i = 0; i < limit; i++) {
                pool.submit(() -> service.readData(UUID.randomUUID()));
            }
            assertThat(entered.await(5, TimeUnit.SECONDS))
                    .as("all permitted reads are running")
                    .isTrue();

            long start = System.nanoTime();
            assertRejected(() -> service.readData(UUID.randomUUID()), ErrorCode.MEDIA_BUSY, 503);
            // It WAITED for its turn and only then gave up, not an immediate rejection (the Windows clock is coarse,
            // ~15 ms).
            assertThat(Duration.ofNanos(System.nanoTime() - start))
                    .isGreaterThanOrEqualTo(MediaService.READ_WAIT.minusMillis(20));
            // The rejected read never touched the database: only the permitted ones are inside it.
            verify(mediaContentRepository, times(limit)).findDataByMediaId(any());

            release.countDown();
            pool.shutdown();
            assertThat(pool.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
            // Every permit has been returned: the next read goes through.
            assertThat(service.readData(UUID.randomUUID())).isSameAs(data);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void an_export_reads_the_image_while_every_public_read_permit_is_held_and_never_takes_one() throws Exception {
        int limit = MediaService.MAX_CONCURRENT_READS;
        UUID exported = UUID.randomUUID();
        UUID missing = UUID.randomUUID();
        CountDownLatch entered = new CountDownLatch(limit);
        CountDownLatch release = new CountDownLatch(1);
        byte[] data = {1, 2, 3};
        byte[] exportedData = {4, 5, 6};
        when(mediaContentRepository.findDataByMediaId(any())).thenAnswer(invocation -> {
            UUID id = invocation.getArgument(0);
            if (exported.equals(id)) {
                return Optional.of(exportedData);
            }
            if (missing.equals(id)) {
                return Optional.empty();
            }
            entered.countDown();
            // Hold the permit until the test allows: this is "an anonymous crowd is reading large pictures".
            if (!release.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("test does not release the reads");
            }
            return Optional.of(data);
        });
        ExecutorService pool = Executors.newFixedThreadPool(limit);
        try {
            for (int i = 0; i < limit; i++) {
                pool.submit(() -> service.readData(UUID.randomUUID()));
            }
            assertThat(entered.await(5, TimeUnit.SECONDS))
                    .as("all permitted reads are running")
                    .isTrue();
            // Control: the public read is refused now, so the export below passes because it does not use the permits.
            assertRejected(() -> service.readData(exported), ErrorCode.MEDIA_BUSY, 503);

            long start = System.nanoTime();
            // An export is neither refused nor made to wait for the crowd: a 503 there would be read as "the image is
            // gone".
            assertThat(service.readDataForExport(exported)).isSameAs(exportedData);
            assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(MediaService.READ_WAIT);
            // A missing image is still a 404, which is what the exports treat as "left out".
            assertRejected(() -> service.readDataForExport(missing), ErrorCode.MEDIA_NOT_FOUND, 404);
        } finally {
            release.countDown();
            pool.shutdown();
            pool.awaitTermination(5, TimeUnit.SECONDS);
            pool.shutdownNow();
        }
        // The export took no permit and returned none it did not hold: the next public read goes through.
        assertThat(service.readData(exported)).isSameAs(exportedData);
    }

    @Test
    void a_read_that_finds_nothing_returns_its_permit() {
        when(mediaContentRepository.findDataByMediaId(any())).thenReturn(Optional.empty());

        // More misses than permits: a permit leaked by the 404 would make a later read 503 until restart.
        for (int i = 0; i < MediaService.MAX_CONCURRENT_READS * 3; i++) {
            assertRejected(() -> service.readData(UUID.randomUUID()), ErrorCode.MEDIA_NOT_FOUND, 404);
        }
    }

    // --- Helpers ---------------------------------------------------------------------------------

    // --- What an AUTHOR may upload -------------------------------------------------------------------

    private static final UUID AUTHOR = UUID.randomUUID();
    private static final UUID ADMIN = UUID.randomUUID();

    /** A service with the given author limits and limiter, with the roles of AUTHOR and ADMIN known. */
    private MediaService authorsService(Map<String, String> limits, RateLimiter limiter) {
        MediaProperties properties = new MediaProperties(
                DataSize.ofBytes(MAX_UPLOAD),
                DataSize.ofMegabytes(4),
                50_000_000L,
                2400,
                0.85f,
                DataSize.ofBytes(QUOTA),
                1,
                WAIT);
        // Both roles are known to every test, which may use only one of them.
        lenient().when(mediaRepository.findRoleOfUser(AUTHOR)).thenReturn(Optional.of("AUTHOR"));
        lenient().when(mediaRepository.findRoleOfUser(ADMIN)).thenReturn(Optional.of("ADMIN"));
        return new MediaService(
                imageProcessor,
                properties,
                mediaRepository,
                mediaContentRepository,
                limiter,
                AuthorQuotaTestProperties.with(limits));
    }

    @Test
    void an_author_upload_counts_against_the_upload_bucket_and_an_admin_upload_does_not() {
        RateLimiter limiter = mock(RateLimiter.class);
        MediaService media = authorsService(Map.of(), limiter);
        when(imageProcessor.process(any())).thenReturn(processed(10));

        media.prepare(file("a.jpg", new byte[10]), AUTHOR);
        media.prepare(file("b.jpg", new byte[10]), ADMIN);

        verify(limiter).check(RateLimiter.MEDIA_UPLOAD, AUTHOR);
        verify(limiter, never()).check(RateLimiter.MEDIA_UPLOAD, ADMIN);
    }

    @Test
    void an_author_over_the_upload_bucket_gets_429_before_any_work_is_done() {
        RateLimiter limiter = mock(RateLimiter.class);
        MediaService media = authorsService(Map.of(), limiter);
        doThrow(new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "slow down"))
                .when(limiter)
                .check(RateLimiter.MEDIA_UPLOAD, AUTHOR);

        assertRejected(() -> media.prepare(file("a.jpg", new byte[10]), AUTHOR), ErrorCode.RATE_LIMITED, 429);

        verifyNoInteractions(imageProcessor);
    }

    @Test
    void only_one_author_image_waits_for_the_pipeline_so_the_next_author_gets_503() throws Exception {
        MediaService media = authorsService(Map.of(), mock(RateLimiter.class));
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        when(imageProcessor.process(any())).thenAnswer(invocation -> {
            entered.countDown();
            if (!release.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("test does not release the first image");
            }
            return processed(10);
        });
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<PreparedUpload> first = pool.submit(() -> media.prepare(file("one.jpg", new byte[10]), AUTHOR));
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();

            // A second author image waits at the author gate (not at the permit) and gives up after the wait.
            assertRejected(() -> media.prepare(file("two.jpg", new byte[10]), AUTHOR), ErrorCode.MEDIA_BUSY, 503);

            release.countDown();
            first.get(5, TimeUnit.SECONDS);
            // The gate and the permit are back: the next author image goes through.
            assertThat(media.prepare(file("three.jpg", new byte[10]), AUTHOR).image())
                    .isNotNull();
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void an_author_over_their_own_share_gets_422_while_the_site_total_is_under_and_an_admin_is_not_counted() {
        MediaService media = authorsService(Map.of("media-per-author", "100B"), mock(RateLimiter.class));
        when(mediaRepository.sumByteSize()).thenReturn(0L);
        when(mediaRepository.sumByteSizeUploadedBy(AUTHOR)).thenReturn(95L);
        when(mediaRepository.save(any(Media.class))).thenAnswer(invocation -> invocation.getArgument(0));

        assertRejected(
                () -> media.persist(new PreparedUpload(processed(10), null), null, AUTHOR),
                ErrorCode.MEDIA_QUOTA_EXCEEDED,
                422);
        // Boundary: the share is a ceiling, 95 + 5 = 100 still fits.
        assertThat(media.persist(new PreparedUpload(processed(5), null), null, AUTHOR)
                        .getByteSize())
                .isEqualTo(5);
        // The bytes of an ADMIN are in no author share.
        assertThat(media.persist(new PreparedUpload(processed(10), null), null, ADMIN)
                        .getByteSize())
                .isEqualTo(10);
        verify(mediaRepository, never()).sumByteSizeUploadedBy(ADMIN);
    }

    @Test
    void all_authors_together_cannot_pass_their_share_of_the_site_quota() {
        // QUOTA is 10_000 bytes and the share is 50 percent: 5_000.
        MediaService media = authorsService(Map.of(), mock(RateLimiter.class));
        when(mediaRepository.sumByteSize()).thenReturn(4_995L);
        when(mediaRepository.sumByteSizeUploadedBy(AUTHOR)).thenReturn(0L);
        when(mediaRepository.sumByteSizeUploadedByNonAdmins()).thenReturn(4_995L);
        when(mediaRepository.save(any(Media.class))).thenAnswer(invocation -> invocation.getArgument(0));

        assertRejected(
                () -> media.persist(new PreparedUpload(processed(10), null), null, AUTHOR),
                ErrorCode.MEDIA_QUOTA_EXCEEDED,
                422);
        assertThat(media.persist(new PreparedUpload(processed(5), null), null, AUTHOR)
                        .getByteSize())
                .isEqualTo(5);
        // The ADMIN may still use the room the authors cannot: the site total is the only limit for an ADMIN.
        assertThat(media.persist(new PreparedUpload(processed(10), null), null, ADMIN)
                        .getByteSize())
                .isEqualTo(10);
    }

    @Test
    void replacing_the_authors_own_image_frees_its_bytes_in_their_share() {
        MediaService media = authorsService(Map.of("media-per-author", "100B"), mock(RateLimiter.class));
        UUID old = UUID.randomUUID();
        Media replaced = media(old, "image/jpeg");
        replaced.setByteSize(40);
        replaced.setUploadedBy(AUTHOR);
        when(mediaRepository.findById(old)).thenReturn(Optional.of(replaced));
        when(mediaRepository.sumByteSize()).thenReturn(0L);
        when(mediaRepository.sumByteSizeUploadedBy(AUTHOR)).thenReturn(90L);
        when(mediaRepository.save(any(Media.class))).thenAnswer(invocation -> invocation.getArgument(0));

        // 90 + 30 = 120 passes the share; with the 40 bytes that go away it is 80.
        assertThat(media.persist(new PreparedUpload(processed(30), null), null, AUTHOR, old)
                        .getByteSize())
                .isEqualTo(30);
        assertRejected(
                () -> media.persist(new PreparedUpload(processed(30), null), null, AUTHOR),
                ErrorCode.MEDIA_QUOTA_EXCEEDED,
                422);
    }

    @Test
    void a_post_body_holds_a_bounded_number_of_images_for_an_author_but_not_for_an_admin() {
        MediaService media = authorsService(Map.of("max-body-images-per-post", "2"), mock(RateLimiter.class));
        UUID post = UUID.randomUUID();
        when(mediaRepository.countByPostId(post)).thenReturn(1L, 2L);

        media.requireRoomForBodyImage(post, AUTHOR);
        assertThatThrownBy(() -> media.requireRoomForBodyImage(post, AUTHOR))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.AUTHOR_QUOTA_EXCEEDED);
                    assertThat(e.getStatus().value()).isEqualTo(422);
                });
        media.requireRoomForBodyImage(post, ADMIN);
        verify(mediaRepository, times(2)).countByPostId(post);
    }

    private static MockMultipartFile file(String originalFilename, byte[] content) {
        return new MockMultipartFile("file", originalFilename, "image/jpeg", content);
    }

    /** A fake pipeline result of {@code size} bytes. The sha256 value need not be right: the service only copies it. */
    private static ProcessedImage processed(int size) {
        return new ProcessedImage(new byte[size], "image/jpeg", 20, 30, "ab".repeat(32), "#336699", null);
    }

    private static Media media(UUID id, String contentType) {
        Media media = new Media();
        media.setId(id);
        media.setContentType(contentType);
        return media;
    }

    private static void assertRejected(ThrowingCallable call, ErrorCode code, int status) {
        assertThatThrownBy(call).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(code);
            assertThat(e.getStatus().value()).isEqualTo(status);
        });
    }
}
