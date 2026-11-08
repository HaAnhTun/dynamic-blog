package com.blog.common.util;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.fixtures.vi.IdentityViText;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

class SlugGeneratorTest {

    @Test
    void slugifyLowercasesAndHyphenatesSpaces() {
        assertThat(SlugGenerator.slugify("Spring Boot Basics")).isEqualTo("spring-boot-basics");
    }

    @Test
    void slugifyStripsVietnameseDiacritics() {
        assertThat(SlugGenerator.slugify(IdentityViText.SLUG_TITLE_GUIDE)).isEqualTo("huong-dan-spring-boot-co-ban");
    }

    @Test
    void slugifyRemovesSpecialCharactersAndCollapsesHyphens() {
        assertThat(SlugGenerator.slugify(IdentityViText.SLUG_TITLE_SYMBOLS))
                .isEqualTo("redis-spring-boot-mot-goc-nhin");
    }

    @Test
    void ensureUniqueReturnsBaseSlugWhenNoCollision() {
        assertThat(SlugGenerator.ensureUnique("spring-boot-basics", slug -> false))
                .isEqualTo("spring-boot-basics");
    }

    @Test
    void ensureUniqueAppendsIncrementingSuffixOnCollision() {
        assertThat(SlugGenerator.ensureUnique(
                        "spring-boot-basics",
                        slug -> slug.equals("spring-boot-basics") || slug.equals("spring-boot-basics-2")))
                .isEqualTo("spring-boot-basics-3");
    }

    @Test
    void slugifyFallsBackToUntitledWhenNothingAlphanumericRemains() {
        assertThat(SlugGenerator.slugify("!!! ???")).isEqualTo("untitled");
    }

    @Test
    void slugifyConvertsVietnameseDWithStroke() {
        assertThat(SlugGenerator.slugify(IdentityViText.SLUG_STREET_UPPER)).isEqualTo("duong-nguyen-hue");
    }

    @Test
    void slugifyConvertsLowercaseVietnameseDWithStroke() {
        assertThat(SlugGenerator.slugify(IdentityViText.SLUG_STREET_LOWER)).isEqualTo("duong-pho");
    }

    @Test
    void slugifyOrEmptyReportsNothingSurvivingWhileSlugifySubstitutes() {
        assertThat(SlugGenerator.slugifyOrEmpty("???")).isEmpty();
        assertThat(SlugGenerator.slugify("???")).isEqualTo("untitled");
        // And they agree on everything else, which is what makes the split safe.
        assertThat(SlugGenerator.slugifyOrEmpty(IdentityViText.SLUG_LEARN_SPRING))
                .isEqualTo("hoc-spring");
        assertThat(SlugGenerator.slugify(IdentityViText.SLUG_LEARN_SPRING)).isEqualTo("hoc-spring");
    }

    @Test
    void ensureUniqueProbesAtMostAFewDozenTimesAndThenUsesARandomSuffix() {
        AtomicInteger calls = new AtomicInteger();
        // Every base-N is taken, as after someone has squatted base-2 to base-1000.
        String slug = SlugGenerator.ensureUnique("squatted", candidate -> {
            calls.incrementAndGet();
            return candidate.equals("squatted") || candidate.matches("squatted-[0-9]+");
        });

        assertThat(slug).matches("squatted-[0-9a-f]{8}");
        assertThat(calls.get()).isLessThanOrEqualTo(SlugGenerator.MAX_SEQUENTIAL_PROBES + 3);
    }

    @Test
    void ensureUniqueStillCountsUpWhileTheNumbersAreFree() {
        assertThat(SlugGenerator.ensureUnique(
                        "a-post", candidate -> candidate.equals("a-post") || candidate.equals("a-post-2")))
                .isEqualTo("a-post-3");
        // The last numbered candidate is the 51st probe: a-post-51.
        assertThat(SlugGenerator.ensureUnique(
                        "a-post", candidate -> candidate.matches("a-post(-([2-9]|[1-4][0-9]|50))?")))
                .isEqualTo("a-post-51");
    }

    @Test
    void ensureUniqueGivesUpWithAConflictWhenNothingIsFree() {
        AtomicInteger calls = new AtomicInteger();

        assertThatThrownBy(() -> SlugGenerator.ensureUnique("taken", candidate -> {
                    calls.incrementAndGet();
                    return true;
                }))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.RESOURCE_CONFLICT);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                });
        assertThat(calls.get()).isLessThanOrEqualTo(SlugGenerator.MAX_SEQUENTIAL_PROBES + 5);
    }
}
