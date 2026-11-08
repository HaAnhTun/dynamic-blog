package com.blog.series;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.TaxonomyTranslations;
import com.blog.post.repository.PostCardRepository;
import com.blog.post.repository.PostRepository;
import com.blog.post.repository.SeriesMemberRow;
import com.blog.post.service.PostService;
import com.blog.search.index.DocType;
import com.blog.search.sync.SearchOutbox;
import com.blog.series.entity.Series;
import com.blog.series.repository.SeriesRepository;
import com.blog.series.service.SeriesService;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * The statements {@link SeriesService#placeByPart} makes, in order, without a database: the locks first, the search
 * documents before any write (the outbox is off in the integration tests, so this is where it is checked), and the fewest
 * writes that put the post at its place. The result in the database is checked by {@code SeriesIT}.
 */
@ExtendWith(MockitoExtension.class)
class SeriesServiceTest {

    @Mock
    private SeriesRepository seriesRepository;

    @Mock
    private PostRepository postRepository;

    @Mock
    private PostCardRepository postCardRepository;

    @Mock
    private PostService postService;

    @Mock
    private SearchOutbox searchOutbox;

    @Mock
    private TaxonomyTranslations taxonomyTranslations;

    private SeriesService service;
    private final UUID seriesId = UUID.randomUUID();
    private final UUID postId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        service = new SeriesService(
                seriesRepository, postRepository, postCardRepository, postService, searchOutbox, taxonomyTranslations);
        lenient().when(seriesRepository.findByIdForUpdate(seriesId)).thenReturn(Optional.of(new Series()));
    }

    /** A member row; the id is random. */
    private record Member(UUID id, String language, Integer position, Integer part) implements SeriesMemberRow {
        @Override
        public UUID getId() {
            return id;
        }

        @Override
        public String getLanguage() {
            return language;
        }

        @Override
        public Integer getPosition() {
            return position;
        }

        @Override
        public Integer getPart() {
            return part;
        }
    }

    private static Member member(String language, int position, Integer part) {
        return new Member(UUID.randomUUID(), language, position, part);
    }

    private void givenMembers(String postLanguage, Member... members) {
        when(postRepository.findLanguageById(postId)).thenReturn(Optional.of(postLanguage));
        when(postRepository.findSeriesMembers(seriesId)).thenReturn(List.of(members));
    }

    @Test
    void the_locks_come_first_and_the_search_documents_are_queued_before_the_first_write() {
        givenMembers("en");

        service.placeByPart(seriesId, postId, 3);

        InOrder order = inOrder(postRepository, seriesRepository, searchOutbox);
        order.verify(postRepository).lockTranslationWrites();
        order.verify(seriesRepository).findByIdForUpdate(seriesId);
        order.verify(searchOutbox).enqueue(DocType.SERIES, seriesId);
        order.verify(searchOutbox).publishedPostsInSeries(seriesId);
        order.verify(searchOutbox).publishedPostsAndTheirSeries(List.of(postId));
        order.verify(postRepository).assignToSeriesAtPart(postId, seriesId, 1, 3);
    }

    @Test
    void a_part_after_every_declared_part_is_appended_with_one_write_and_no_renumbering() {
        Member one = member("en", 1, 1);
        Member legacy = member("en", 4, null);
        givenMembers("en", one, legacy);

        service.placeByPart(seriesId, postId, 9);

        verify(postRepository).assignToSeriesAtPart(postId, seriesId, 5, 9);
        verify(postRepository, never()).shiftSeriesPositions(any(), anyInt());
        verify(postRepository, never()).setSeriesPosition(any(), anyInt());
    }

    @Test
    void a_part_before_a_greater_one_shifts_the_positions_out_of_the_way_and_writes_the_new_order() {
        Member one = member("en", 1, 1);
        Member five = member("en", 2, 5);
        Member ten = member("en", 7, 10);
        givenMembers("en", one, five, ten);

        service.placeByPart(seriesId, postId, 7);

        InOrder order = inOrder(postRepository);
        // The shift is past the highest old position (7) and past the new count (4).
        order.verify(postRepository).shiftSeriesPositions(seriesId, 7);
        order.verify(postRepository).setSeriesPosition(one.id(), 1);
        order.verify(postRepository).setSeriesPosition(five.id(), 2);
        order.verify(postRepository).setSeriesPosition(ten.id(), 4);
        order.verify(postRepository).assignToSeriesAtPart(postId, seriesId, 3, 7);
    }

    @Test
    void only_a_greater_part_of_the_same_language_decides_the_place() {
        Member vietnameseNine = member("vi", 1, 9);
        Member englishOne = member("en", 2, 1);
        givenMembers("en", vietnameseNine, englishOne);

        service.placeByPart(seriesId, postId, 5);

        // The Vietnamese part 9 is not an English part: the English post goes after the English part 1.
        verify(postRepository).assignToSeriesAtPart(postId, seriesId, 3, 5);
        verify(postRepository, never()).shiftSeriesPositions(any(), anyInt());
    }

    @Test
    void a_post_that_is_already_a_member_is_taken_out_of_the_order_before_it_is_placed_again() {
        Member first = member("en", 1, 1);
        Member self = new Member(postId, "en", 2, 2);
        Member third = member("en", 3, 3);
        givenMembers("en", first, self, third);

        service.placeByPart(seriesId, postId, 4);

        // Without itself the members are 1 and 3: part 4 goes to the end, one write, no shift.
        verify(postRepository).assignToSeriesAtPart(postId, seriesId, 4, 4);
        verify(postRepository, never()).shiftSeriesPositions(any(), anyInt());
    }

    @Test
    void a_member_without_a_declared_part_among_members_without_one_keeps_its_place_and_only_its_part_is_written() {
        Member first = member("en", 1, null);
        Member self = new Member(postId, "en", 2, null);
        Member third = member("en", 3, null);
        givenMembers("en", first, self, third);

        service.placeByPart(seriesId, postId, 1);

        verify(postRepository).assignToSeriesAtPart(postId, seriesId, 2, 1);
        verify(postRepository, never()).shiftSeriesPositions(any(), anyInt());
        verify(postRepository, never()).setSeriesPosition(any(), anyInt());
    }

    @Test
    void a_member_whose_part_fits_between_the_declared_parts_around_it_keeps_its_place() {
        Member one = member("en", 1, 1);
        Member self = new Member(postId, "en", 5, null);
        Member vietnameseZero = member("vi", 6, 1);
        Member three = member("en", 7, 3);
        givenMembers("en", one, self, vietnameseZero, three);

        service.placeByPart(seriesId, postId, 2);

        // The Vietnamese part 1 after it is not an English part and does not count.
        verify(postRepository).assignToSeriesAtPart(postId, seriesId, 5, 2);
        verify(postRepository, never()).shiftSeriesPositions(any(), anyInt());
        verify(postRepository, never()).setSeriesPosition(any(), anyInt());
    }

    @Test
    void a_member_that_a_greater_declared_part_before_it_puts_out_of_order_moves_to_its_place() {
        Member five = member("en", 1, 5);
        Member self = new Member(postId, "en", 2, null);
        Member nine = member("en", 3, 9);
        givenMembers("en", five, self, nine);

        service.placeByPart(seriesId, postId, 2);

        InOrder order = inOrder(postRepository);
        order.verify(postRepository).shiftSeriesPositions(seriesId, 3);
        order.verify(postRepository).setSeriesPosition(five.id(), 2);
        order.verify(postRepository).setSeriesPosition(nine.id(), 3);
        order.verify(postRepository).assignToSeriesAtPart(postId, seriesId, 1, 2);
    }

    @Test
    void a_member_that_a_smaller_declared_part_after_it_puts_out_of_order_moves_to_the_end() {
        Member self = new Member(postId, "en", 1, null);
        Member two = member("en", 2, 2);
        givenMembers("en", self, two);

        service.placeByPart(seriesId, postId, 5);

        verify(postRepository).assignToSeriesAtPart(postId, seriesId, 3, 5);
        verify(postRepository, never()).shiftSeriesPositions(any(), anyInt());
    }

    @Test
    void a_member_keeping_its_place_still_queues_the_search_documents_before_the_write() {
        Member self = new Member(postId, "en", 4, null);
        givenMembers("en", self);

        service.placeByPart(seriesId, postId, 1);

        InOrder order = inOrder(postRepository, searchOutbox);
        order.verify(searchOutbox).enqueue(DocType.SERIES, seriesId);
        order.verify(searchOutbox).publishedPostsInSeries(seriesId);
        order.verify(searchOutbox).publishedPostsAndTheirSeries(List.of(postId));
        order.verify(postRepository).assignToSeriesAtPart(postId, seriesId, 4, 1);
    }

    @Test
    void a_series_that_does_not_exist_is_404_and_nothing_is_written() {
        UUID missing = UUID.randomUUID();
        when(seriesRepository.findByIdForUpdate(missing)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.placeByPart(missing, postId, 1))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.SERIES_NOT_FOUND));

        verify(postRepository, never()).assignToSeriesAtPart(any(), any(), anyInt(), any());
    }

    @Test
    void a_post_that_does_not_exist_is_a_400_and_nothing_is_queued_or_written() {
        when(postRepository.findLanguageById(postId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.placeByPart(seriesId, postId, 1))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.POST_NOT_FOUND));

        verify(searchOutbox, never()).enqueue(eq(DocType.SERIES), any(UUID.class));
        verify(postRepository, never()).assignToSeriesAtPart(any(), any(), anyInt(), any());
    }

    // --- fillDescriptionIfEmpty -----------------------------------------------------------------------------

    @Test
    void an_empty_description_is_filled_under_the_locks_with_the_search_documents_queued() {
        Series series = new Series();
        when(seriesRepository.findByIdForUpdate(seriesId)).thenReturn(Optional.of(series));

        boolean written = service.fillDescriptionIfEmpty(seriesId, "  A description from a file.  ");

        assertThat(written).isTrue();
        assertThat(series.getDescription()).isEqualTo("A description from a file.");
        InOrder order = inOrder(postRepository, seriesRepository, searchOutbox);
        order.verify(postRepository).lockTranslationWrites();
        order.verify(seriesRepository).findByIdForUpdate(seriesId);
        order.verify(searchOutbox).enqueue(DocType.SERIES, seriesId);
        order.verify(searchOutbox).publishedPostsInSeries(seriesId);
        order.verify(seriesRepository).saveAndFlush(series);
    }

    @Test
    void a_blank_description_in_the_stored_series_counts_as_empty() {
        Series series = new Series();
        series.setDescription("   ");
        when(seriesRepository.findByIdForUpdate(seriesId)).thenReturn(Optional.of(series));

        assertThat(service.fillDescriptionIfEmpty(seriesId, "A description from a file."))
                .isTrue();

        assertThat(series.getDescription()).isEqualTo("A description from a file.");
    }

    @Test
    void a_description_that_is_there_is_never_overwritten_and_nothing_is_queued() {
        Series series = new Series();
        series.setDescription("The description of the administrator.");
        when(seriesRepository.findByIdForUpdate(seriesId)).thenReturn(Optional.of(series));

        assertThat(service.fillDescriptionIfEmpty(seriesId, "A description from a file."))
                .isFalse();

        assertThat(series.getDescription()).isEqualTo("The description of the administrator.");
        verify(searchOutbox, never()).enqueue(eq(DocType.SERIES), any(UUID.class));
        verify(seriesRepository, never()).saveAndFlush(any());
    }

    @Test
    void an_empty_value_writes_nothing() {
        assertThat(service.fillDescriptionIfEmpty(seriesId, "  ")).isFalse();
        assertThat(service.fillDescriptionIfEmpty(seriesId, null)).isFalse();

        verify(searchOutbox, never()).enqueue(eq(DocType.SERIES), any(UUID.class));
        verify(seriesRepository, never()).saveAndFlush(any());
    }

    @Test
    void filling_the_description_of_a_series_that_does_not_exist_is_404() {
        UUID missing = UUID.randomUUID();
        when(seriesRepository.findByIdForUpdate(missing)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.fillDescriptionIfEmpty(missing, "A description."))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.SERIES_NOT_FOUND));
    }
}
