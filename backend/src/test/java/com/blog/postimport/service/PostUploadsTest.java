package com.blog.postimport.service;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.postimport.format.PostFile;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.service.PostUploads.Upload;
import com.blog.support.ZipPackages;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.multipart.MultipartFile;

/** Reading the file parts of an upload: the limits, the names and the refusals that name a file by position. */
class PostUploadsTest {

    private static MockMultipartFile file(String name, String text) {
        return new MockMultipartFile("file", name, "text/markdown", text.getBytes(UTF_8));
    }

    private static void assertRefused(Runnable call, ErrorCode code, HttpStatus status) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(code);
            assertThat(e.getStatus()).isEqualTo(status);
        });
    }

    @Test
    void files_are_read_in_order_with_their_position_plain_name_size_and_hash() {
        String first = "---\ntitle: One\n---\nBody\n";
        String second = "---\ntitle: Two\n---\nBody\n";

        List<Upload> uploads = PostUploads.read(List.of(file("one.md", first), file("C:\\notes\\two.MD", second)));

        assertThat(uploads).extracting(Upload::position).containsExactly(1, 2);
        assertThat(uploads).extracting(Upload::fileName).containsExactly("one.md", "two.MD");
        assertThat(uploads.get(0).bytes()).isEqualTo(first.getBytes(UTF_8).length);
        assertThat(uploads.get(0).sha256()).isEqualTo(PostFile.sha256Hex(first.getBytes(UTF_8)));
        assertThat(uploads.get(1).text()).isEqualTo(second);
    }

    @Test
    void a_zip_is_recognized_by_its_name_and_by_its_magic_bytes_next_to_markdown_files() {
        byte[] zip = com.blog.support.ZipPackages.zip()
                .add("article.md", "---\ntitle: One\n---\nBody\n")
                .build();
        MockMultipartFile byName = new MockMultipartFile("file", "Package.ZIP", "application/zip", zip);
        MockMultipartFile byMagic = new MockMultipartFile("file", "package.bin", "application/octet-stream", zip);

        List<Upload> uploads =
                PostUploads.read(List.of(file("one.md", "---\ntitle: One\n---\nBody\n"), byName, byMagic));

        assertThat(uploads).extracting(upload -> upload.pack() != null).containsExactly(false, true, true);
        assertThat(uploads.get(1).pack().readable()).isTrue();
        assertThat(uploads.get(1).text()).isEqualTo("---\ntitle: One\n---\nBody\n");
        assertThat(uploads.get(1).bytes()).isEqualTo(zip.length);
        assertThat(uploads.get(1).sha256()).isEqualTo(PostFile.sha256Hex(zip));
        assertThat(uploads.get(2).fileName()).isEqualTo("package.bin");
    }

    @Test
    void the_packages_of_one_request_share_one_unpack_budget_even_when_they_are_refused() {
        // Each package unpacks more than half of the budget, with a ratio far under the bomb check, and is then refused
        // because the archive inside is found only after the entry before it was read.
        Random random = new Random(5);
        ZipPackages.Builder builder = ZipPackages.zip().add("article.md", "---\ntitle: One\n---\nBody\n");
        for (int i = 0; i < 3; i++) {
            byte[] data = new byte[3_000_000];
            for (int j = 0; j < data.length; j++) {
                data[j] = (byte) (random.nextInt(8) == 0 ? 'b' : 'a');
            }
            builder.add("assets/" + i + ".png", data);
        }
        byte[] zip = builder.add(
                        "assets/last.png", ZipPackages.zip().add("x.txt", "x").build())
                .build();
        List<MultipartFile> files = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            files.add(new MockMultipartFile("file", "p" + i + ".zip", "application/zip", zip));
        }

        List<Upload> uploads = PostUploads.read(files);

        assertThat(uploads.get(0).pack().problems().get(0)).contains("is an archive");
        assertThat(uploads.get(0).pack().unpackedBytes()).isGreaterThan(8L * 1024 * 1024);
        assertThat(uploads.get(1).pack().problems().get(0)).contains("when unpacked");
        assertThat(uploads.get(2).pack().problems().get(0)).contains("when unpacked");
    }

    @Test
    void a_package_that_cannot_be_read_is_an_upload_with_its_reason_not_a_refusal_of_the_request() {
        List<Upload> uploads = PostUploads.read(List.of(
                new MockMultipartFile("file", "bad.zip", "application/zip", "not a zip".getBytes(UTF_8)),
                new MockMultipartFile("file", "empty.zip", "application/zip", new byte[0])));

        assertThat(uploads.get(0).pack().readable()).isFalse();
        assertThat(uploads.get(0).pack().problems()).containsExactly("the file is not a ZIP archive");
        assertThat(uploads.get(0).text()).isEmpty();
        assertThat(uploads.get(1).pack().problems()).containsExactly("the package is empty");
        assertThat(PostUploads.parse(uploads.get(0)).unreadable()).isTrue();
        assertThat(PostUploads.parse(uploads.get(0)).problems()).hasSize(1);
    }

    @Test
    void a_package_has_its_own_size_cap_and_a_markdown_name_does_not_get_it() {
        MultipartFile bigZip = mock(MultipartFile.class);
        when(bigZip.getSize()).thenReturn((long) PostFileLimits.MAX_PACKAGE_BYTES);
        when(bigZip.getOriginalFilename()).thenReturn("big.zip");
        try {
            when(bigZip.getBytes()).thenReturn(new byte[0]);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        MultipartFile overZip = mock(MultipartFile.class);
        when(overZip.getSize()).thenReturn(PostFileLimits.MAX_PACKAGE_BYTES + 1L);
        when(overZip.getOriginalFilename()).thenReturn("over.zip");
        MultipartFile bigMarkdown = mock(MultipartFile.class);
        when(bigMarkdown.getSize()).thenReturn(PostFile.MAX_BYTES + 1L);
        when(bigMarkdown.getOriginalFilename()).thenReturn("big.md");

        assertRefused(
                () -> PostUploads.read(List.of(overZip)), ErrorCode.VALIDATION_ERROR, HttpStatus.CONTENT_TOO_LARGE);
        assertRefused(
                () -> PostUploads.read(List.of(bigMarkdown)), ErrorCode.VALIDATION_ERROR, HttpStatus.CONTENT_TOO_LARGE);
        assertThat(PostFileLimits.MAX_PACKAGE_BYTES).isGreaterThan(PostFile.MAX_BYTES);
        // The size alone does not refuse a package of exactly the cap: it is read (the mock holds no bytes, so it is an
        // empty package).
        assertThat(PostUploads.read(List.of(bigZip)).get(0).pack().problems()).containsExactly("the package is empty");
    }

    @Test
    void a_long_file_name_is_cut_before_it_is_echoed() {
        String name = "a".repeat(PostUploads.MAX_NAME_CHARS + 50) + ".md";

        Upload upload = PostUploads.read(List.of(file(name, "---\ntitle: One\n---\nBody\n")))
                .get(0);

        assertThat(upload.fileName()).hasSize(PostUploads.MAX_NAME_CHARS);
    }

    @Test
    void no_file_or_too_many_files_is_the_invalid_file_error() {
        assertRefused(() -> PostUploads.read(null), ErrorCode.POST_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST);
        assertRefused(() -> PostUploads.read(List.of()), ErrorCode.POST_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST);
        List<MultipartFile> many = new ArrayList<>();
        for (int i = 0; i <= PostFileLimits.MAX_FILES; i++) {
            many.add(file("f" + i + ".md", "x"));
        }
        assertRefused(() -> PostUploads.read(many), ErrorCode.POST_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST);
    }

    @Test
    void sizes_are_checked_before_any_file_is_read() throws IOException {
        MultipartFile big = mock(MultipartFile.class);
        when(big.getSize()).thenReturn((long) PostFile.MAX_BYTES + 1);
        MultipartFile other = mock(MultipartFile.class);
        when(other.getSize()).thenReturn(10L);

        assertRefused(
                () -> PostUploads.read(List.of(other, big)), ErrorCode.VALIDATION_ERROR, HttpStatus.CONTENT_TOO_LARGE);
        assertThatThrownBy(() -> PostUploads.read(List.of(other, big))).hasMessageStartingWith("File 2 ");
        verify(big, org.mockito.Mockito.never()).getBytes();
        verify(other, org.mockito.Mockito.never()).getBytes();
    }

    @Test
    void the_total_of_the_sizes_is_capped_even_when_every_file_is_under_its_own_cap() {
        List<MultipartFile> files = new ArrayList<>();
        int each = PostFile.MAX_BYTES - 1;
        int count = PostFileLimits.MAX_TOTAL_BYTES / each + 1;
        for (int i = 0; i < count; i++) {
            MultipartFile part = mock(MultipartFile.class);
            when(part.getSize()).thenReturn((long) each);
            files.add(part);
        }
        assertThat(count).isLessThanOrEqualTo(PostFileLimits.MAX_FILES);

        assertRefused(() -> PostUploads.read(files), ErrorCode.VALIDATION_ERROR, HttpStatus.CONTENT_TOO_LARGE);
    }

    @Test
    void a_refused_file_is_named_by_its_position_and_never_by_its_content_or_name() {
        List<MultipartFile> files = List.of(
                file("ok.md", "---\ntitle: One\n---\nBody\n"),
                file("secret-name.txt", "secret text"),
                file("empty.md", ""));
        assertThatThrownBy(() -> PostUploads.read(files)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.POST_IMPORT_INVALID_FILE);
            assertThat(e.getMessage()).startsWith("File 2:").doesNotContain("secret");
        });

        assertThatThrownBy(() -> PostUploads.read(List.of(file("empty.md", ""))))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getMessage()).startsWith("File 1:"));
        assertThatThrownBy(() -> PostUploads.read(List.of(file("a.md", "ok"), file("c.md", "bad \u0001 secret"))))
                .isInstanceOfSatisfying(
                        ApiException.class,
                        e -> assertThat(e.getMessage())
                                .startsWith("File 2:")
                                .contains("line 1")
                                .doesNotContain("secret"));
    }
}
