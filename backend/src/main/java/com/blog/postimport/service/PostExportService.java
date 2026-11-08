package com.blog.postimport.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.LocalizedText;
import com.blog.common.util.SlugGenerator;
import com.blog.media.entity.Media;
import com.blog.media.service.MediaService;
import com.blog.post.entity.Post;
import com.blog.post.repository.PostRepository;
import com.blog.post.repository.TranslationRow;
import com.blog.postimport.format.PostFileValues;
import com.blog.postimport.format.PostPackageWriter;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Exports a saved post as the ZIP package the post import reads ({@link PostPackageWriter}): the file the "Download ZIP" button
 * serves. Who may call it is decided by the caller's route, exactly as for reading the post to edit it; this class reads the
 * SAVED post, a draft included, and the bytes of the site images its body shows, and of its cover, through {@link MediaService}. Nothing about the
 * post or its images is logged.
 */
@Service
@RequiredArgsConstructor
public class PostExportService {

    private static final Logger log = LoggerFactory.getLogger(PostExportService.class);

    private final PostRepository postRepository;
    private final MediaService mediaService;

    /** The package and the name it is downloaded as: ASCII, from the slug, never empty. */
    public record Export(String fileName, byte[] bytes) {}

    /**
     * @param admin whether the caller is an ADMIN. Anyone else gets in the package only the images that belong to this post (its
     *     cover and the images uploaded into its body): any other {@code /media/<id>} in the text stays as written, like an image
     *     that is gone. The bytes of an image are public by their address anyway, but the original file name and the description
     *     stored with an image are admin metadata, and a package names its entries after them.
     * @throws ApiException 404 {@code POST_NOT_FOUND} when there is no such post; 413 {@code POST_EXPORT_TOO_LARGE} when the
     *     post does not fit a package within the limits of the import
     */
    @Transactional(readOnly = true)
    public Export export(UUID postId, boolean admin) {
        Post post = postRepository
                .findById(postId)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId));
        byte[] zip = PostPackageWriter.write(valuesOf(post), fileName -> imageOf(fileName, post, admin), coverOf(post));
        String slug = SlugGenerator.slugifyOrEmpty(post.getSlug());
        return new Export((slug.isEmpty() ? "post" : slug) + ".zip", zip);
    }

    private PostFileValues valuesOf(Post post) {
        String language = post.getLanguage();
        String category = post.getCategory() == null
                ? null
                : LocalizedText.name(
                        post.getCategory().getTranslations(),
                        language,
                        post.getCategory().getName());
        // A set has no order: by name, so that two exports of the same post list the tags the same way.
        List<String> tags = post.getTags().stream()
                .map(tag -> LocalizedText.name(tag.getTranslations(), language, tag.getName()))
                .sorted(String.CASE_INSENSITIVE_ORDER.thenComparing(Comparator.naturalOrder()))
                .toList();
        // Declared parts only: a member without one has no number to promise, and the import refuses a name without a
        // part.
        boolean declared = post.getSeries() != null && post.getSeriesPart() != null;
        return new PostFileValues(
                post.getTitle(),
                post.getSlug(),
                language,
                post.getExcerpt(),
                category,
                tags,
                post.isFeatured(),
                post.getStatus().name(),
                publishedSiblingSlug(post),
                declared ? post.getSeries().getTitle() : null,
                declared ? post.getSeriesPart() : null,
                declared ? post.getSeries().getDescription() : null,
                post.getContent());
    }

    /** The slug of the first published sibling by language code, the one the "Download .md" button names; never a draft. */
    private String publishedSiblingSlug(Post post) {
        if (post.getTranslationGroupId() == null) {
            return null;
        }
        return postRepository.findPublishedTranslations(Set.of(post.getTranslationGroupId())).stream()
                .filter(row -> !row.getPostId().equals(post.getId()))
                .min(Comparator.comparing(TranslationRow::getLanguage))
                .map(TranslationRow::getSlug)
                .orElse(null);
    }

    /** The cover as it is stored (the bytes the site serves), or null when the post has none or its bytes are gone. */
    private PostPackageWriter.Image coverOf(Post post) {
        Media cover = post.getCover();
        if (cover == null) {
            return null;
        }
        try {
            return new PostPackageWriter.Image(
                    mediaService.readDataForExport(cover.getId()), cover.getAltText(), cover.getOriginalFilename());
        } catch (ApiException e) {
            log.info("post export left the cover out code={}", e.getCode());
            return null;
        }
    }

    /** The image of a stored file name ({@code <uuid>.<ext>}), or null when it is gone: the reference then stays as written. */
    private PostPackageWriter.Image imageOf(String fileName, Post post, boolean admin) {
        try {
            UUID id = UUID.fromString(fileName.substring(0, fileName.indexOf('.')));
            Media media = mediaService.findForServing(id, fileName.substring(fileName.indexOf('.') + 1));
            if (!admin && !post.getId().equals(media.getPostId())) {
                log.info("post export left an image as written reason=not-an-image-of-this-post");
                return null;
            }
            return new PostPackageWriter.Image(
                    mediaService.readDataForExport(id), media.getAltText(), media.getOriginalFilename());
        } catch (ApiException e) {
            log.info("post export left an image as written code={}", e.getCode());
            return null;
        }
    }
}
