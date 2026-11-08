package com.blog.stats.service;

import com.blog.gallery.repository.GalleryPhotoRepository;
import com.blog.post.entity.PostStatus;
import com.blog.post.repository.PostRepository;
import com.blog.post.repository.PostViewRepository;
import com.blog.series.repository.SeriesRepository;
import com.blog.stats.dto.StatsResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Public figures of the site.
 *
 * Each number counts exactly what the public pages list: published posts, the views of those same posts, series that
 * have a published part, visible gallery photos. Unpublishing a post removes it, its views and a series that only it
 * belonged to from the statistics, just as they vanish from every page; the statistics never claim the site has more than
 * a reader can find.
 *
 * Four small count queries, each going through the repository of the module that owns that figure. No cache here: the
 * Next server keeps the result for 300 seconds.
 */
@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class StatsService {

    private final PostRepository postRepository;
    private final PostViewRepository postViewRepository;
    private final SeriesRepository seriesRepository;
    private final GalleryPhotoRepository galleryPhotoRepository;

    public StatsResponse get() {
        return new StatsResponse(
                postRepository.countByStatus(PostStatus.PUBLISHED),
                postViewRepository.sumForPublishedPosts(),
                seriesRepository.countWithPublishedParts(),
                galleryPhotoRepository.countByPublishedTrue());
    }
}
