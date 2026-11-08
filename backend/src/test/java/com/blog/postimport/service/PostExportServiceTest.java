package com.blog.postimport.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.media.entity.Media;
import com.blog.media.service.MediaService;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostStatus;
import com.blog.post.repository.PostRepository;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

/**
 * An export is the owner's copy of a post: the image reads it makes must not share the bound of the public serving path
 * ({@link MediaService#readData}), which answers 503 {@code MEDIA_BUSY} when a crowd is reading large pictures. The export treats any
 * failure of a read as "this image is gone" and leaves the reference as written, so a busy moment would give the owner a package
 * without its pictures and no error. The name of the package comes from the stored slug alone.
 */
@ExtendWith(MockitoExtension.class)
class PostExportServiceTest {

    /** The first bytes of a PNG: all the package writer looks at to name the file. */
    private static final byte[] PNG = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4};

    @Mock
    private PostRepository postRepository;

    @Mock
    private MediaService mediaService;

    @InjectMocks
    private PostExportService service;

    @Test
    void the_cover_and_the_body_image_come_from_the_export_read_never_the_bound_public_one() throws IOException {
        UUID bodyImage = UUID.randomUUID();
        UUID coverImage = UUID.randomUUID();
        Media body = media(bodyImage, "body.png");
        Media cover = media(coverImage, "cover.png");
        Post post = new Post();
        post.setTitle("A post");
        post.setSlug("a-post");
        post.setLanguage("en");
        post.setStatus(PostStatus.DRAFT);
        post.setContent("Text\n\n![A figure](/media/" + bodyImage + ".png)\n");
        ReflectionTestUtils.setField(post, "cover", cover);
        UUID postId = UUID.randomUUID();
        when(postRepository.findById(postId)).thenReturn(Optional.of(post));
        when(mediaService.findForServing(bodyImage, "png")).thenReturn(body);
        when(mediaService.readDataForExport(bodyImage)).thenReturn(PNG);
        when(mediaService.readDataForExport(coverImage)).thenReturn(PNG);

        PostExportService.Export export = service.export(postId, true);

        assertThat(entryNames(export.bytes()))
                .as("the package holds the article, the body image and the cover")
                .hasSize(3)
                .contains("article.md")
                .filteredOn(name -> name.startsWith("assets/") && name.endsWith(".png"))
                .hasSize(2);
        verify(mediaService, never()).readData(any());
    }

    private Post postWithSlug(String slug) {
        Post post = new Post();
        post.setId(UUID.randomUUID());
        post.setTitle("A title");
        post.setSlug(slug);
        post.setContent("A short body.");
        post.setLanguage("en");
        post.setStatus(PostStatus.DRAFT);
        when(postRepository.findById(post.getId())).thenReturn(Optional.of(post));
        return post;
    }

    /**
     * Since V50 the database refuses a slug that is not lower case words joined by single hyphens, so a stored slug cannot
     * hold an accent, a quote or a space any more (PostConstraintsIT). The name is still made from whatever the slug holds, so
     * that a row older than the constraint, or a future change of it, cannot put a quote or a non-ASCII letter into the
     * Content-Disposition header: the end to end version of this test needed to write such a slug into the table.
     */
    @Test
    void the_file_name_is_ascii_whatever_the_stored_slug_holds() {
        Post post = postWithSlug("Ca" + (char) 0x00e9 + "_Name " + '"' + "x" + '"' + " 1a2b3c4d");

        assertThat(service.export(post.getId(), true).fileName()).isEqualTo("cae-name-x-1a2b3c4d.zip");
    }

    @Test
    void a_slug_with_nothing_usable_in_it_gives_a_plain_name() {
        Post post = postWithSlug("___");

        assertThat(service.export(post.getId(), false).fileName()).isEqualTo("post.zip");
    }

    private static Media media(UUID id, String originalFilename) {
        Media media = new Media();
        media.setId(id);
        media.setOriginalFilename(originalFilename);
        media.setContentType("image/png");
        return media;
    }

    private static List<String> entryNames(byte[] zip) throws IOException {
        List<String> names = new ArrayList<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip))) {
            for (ZipEntry entry = in.getNextEntry(); entry != null; entry = in.getNextEntry()) {
                names.add(entry.getName());
            }
        }
        return names;
    }
}
