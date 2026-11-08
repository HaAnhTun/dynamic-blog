package com.blog.category.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.blog.category.dto.CategoryRequest;
import com.blog.category.entity.Category;
import com.blog.category.repository.CategoryRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.i18n.LocalizedText;
import com.blog.common.i18n.TaxonomyTranslations;
import com.blog.common.quota.AuthorQuotaProperties;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.search.sync.SearchOutbox;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class CategoryServiceTest {

    @Mock
    private CategoryRepository categoryRepository;
    // Changes write the search outbox; without this mock @InjectMocks passes null. The write rules
    // are checked against a real DB and Meilisearch in SearchOutboxIT.
    @Mock
    private SearchOutbox searchOutbox;

    @Mock
    private TaxonomyTranslations taxonomyTranslations;

    @Mock
    private RateLimiter rateLimiter;

    // A small catalog so that the test needs few categories.
    @Mock
    private AuthorQuotaProperties authorQuota;

    @org.junit.jupiter.api.BeforeEach
    void smallCatalog() {
        org.mockito.Mockito.lenient().when(authorQuota.maxCategories()).thenReturn(2);
    }

    @InjectMocks
    private CategoryService categoryService;

    @Test
    void createGeneratesSlugFromName() {
        when(categoryRepository.existsByNameIgnoreCase("Backend")).thenReturn(false);
        when(categoryRepository.existsBySlug("backend")).thenReturn(false);
        when(categoryRepository.save(any(Category.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = categoryService.create(new CategoryRequest("Backend", "Backend articles"));

        assertThat(response.slug()).isEqualTo("backend");
        assertThat(response.name()).isEqualTo("Backend");
    }

    @Test
    void createRejectsCaseInsensitiveDuplicateName() {
        when(categoryRepository.existsByNameIgnoreCase("backend")).thenReturn(true);

        assertThatThrownBy(() -> categoryService.create(new CategoryRequest("backend", null)))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("already exists");
    }

    @Test
    void createTrimsNameBeforeDuplicateCheckAndSlugGeneration() {
        when(categoryRepository.existsByNameIgnoreCase("Backend")).thenReturn(false);
        when(categoryRepository.existsBySlug("backend")).thenReturn(false);
        when(categoryRepository.save(any(Category.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = categoryService.create(new CategoryRequest(" Backend ", null));

        assertThat(response.name()).isEqualTo("Backend");
        assertThat(response.slug()).isEqualTo("backend");
    }

    @Test
    void createRejectsDuplicateNameThatOnlyDiffersByWhitespace() {
        when(categoryRepository.existsByNameIgnoreCase("Backend")).thenReturn(true);

        assertThatThrownBy(() -> categoryService.create(new CategoryRequest(" Backend ", null)))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("already exists");
    }

    @Test
    void createStripsUnicodeWhitespaceThatTrimWouldMiss() {
        // strip() (unlike trim(), which only strips code points <= U+0020) removes any code point
        // Character.isWhitespace() recognises - e.g. U+2003 EM SPACE. Note this does NOT cover
        // U+00A0/U+2007/U+202F non-breaking space: the JDK explicitly excludes those from
        // isWhitespace(), so a name pasted with a literal non-breaking space (e.g. copied out of
        // rendered HTML, where &nbsp; becomes U+00A0) still slips past this check unchanged.
        when(categoryRepository.existsByNameIgnoreCase("Backend")).thenReturn(false);
        when(categoryRepository.existsBySlug("backend")).thenReturn(false);
        when(categoryRepository.save(any(Category.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = categoryService.create(new CategoryRequest(" Backend ", null));

        assertThat(response.name()).isEqualTo("Backend");
        assertThat(response.slug()).isEqualTo("backend");
    }

    @Test
    void createStoresTheNormalisedTranslationsAndTheAdminResponseCarriesThem() {
        Map<String, LocalizedText> given = Map.of("en", new LocalizedText(" English ", null));
        Map<String, LocalizedText> normalised = Map.of("en", new LocalizedText("English", null));
        when(categoryRepository.existsByNameIgnoreCase("Backend")).thenReturn(false);
        when(categoryRepository.existsBySlug("backend")).thenReturn(false);
        when(taxonomyTranslations.normalize(given, 255, Integer.MAX_VALUE)).thenReturn(normalised);
        when(categoryRepository.save(any(Category.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = categoryService.create(new CategoryRequest("Backend", null, given));

        assertThat(response.translations()).isEqualTo(normalised);
    }

    @Test
    void publicListWithoutALanguageNeverCarriesTheRawTranslations() {
        Category category = new Category();
        category.setName("Backend");
        category.setSlug("backend");
        category.setTranslations(Map.of("en", new LocalizedText("English", "English text")));
        when(categoryRepository.findAllWithPublishedPosts()).thenReturn(List.of(category));
        when(categoryRepository.findAllWithPublishedPostsIn("en")).thenReturn(List.of(category));

        assertThat(categoryService.listPublic().getFirst().translations()).isNull();
        assertThat(categoryService.listPublic().getFirst().name()).isEqualTo("Backend");
        var english = categoryService.listPublic("en").getFirst();
        assertThat(english.name()).isEqualTo("English");
        assertThat(english.description()).isEqualTo("English text");
        assertThat(english.translations()).isNull();
    }

    /** A text-direction override (U+202E) in a name: the classic way to make a label read as something else. */
    private static String withOverride(String left, String right) {
        return left + new String(Character.toChars(0x202E)) + right;
    }

    @Test
    void createRemovesTextDirectionAndInvisibleCharactersFromTheName() {
        when(categoryRepository.existsByNameIgnoreCase("topic")).thenReturn(false);
        when(categoryRepository.existsBySlug("topic")).thenReturn(false);
        when(categoryRepository.save(any(Category.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = categoryService.create(new CategoryRequest(withOverride("to", "pic"), null));

        assertThat(response.name()).isEqualTo("topic");
        assertThat(response.slug()).isEqualTo("topic");
    }

    @Test
    void createRefusesANameWithNothingVisibleLeft() {
        assertThatThrownBy(() -> categoryService.create(new CategoryRequest(withOverride("", ""), null)))
                .isInstanceOfSatisfying(
                        ApiException.class,
                        e -> assertThat(e.getStatus()).isEqualTo(org.springframework.http.HttpStatus.BAD_REQUEST));
    }

    // --- What an AUTHOR may create -------------------------------------------------------------------

    @Test
    void an_author_creation_counts_against_the_taxonomy_bucket_and_works_below_the_catalog_limit() {
        java.util.UUID author = java.util.UUID.randomUUID();
        when(categoryRepository.count()).thenReturn(1L);
        when(categoryRepository.existsByNameIgnoreCase("Fresh")).thenReturn(false);
        when(categoryRepository.existsBySlug("fresh")).thenReturn(false);
        when(categoryRepository.save(any(Category.class))).thenAnswer(invocation -> invocation.getArgument(0));

        assertThat(categoryService
                        .create(new CategoryRequest("Fresh", null), author, false)
                        .slug())
                .isEqualTo("fresh");

        org.mockito.Mockito.verify(rateLimiter).check(RateLimiter.TAXONOMY_CREATE, author);
    }

    @Test
    void an_author_cannot_add_a_category_to_a_full_catalog_but_an_admin_can() {
        java.util.UUID someone = java.util.UUID.randomUUID();
        when(categoryRepository.count()).thenReturn(2L);

        assertThatThrownBy(() -> categoryService.create(new CategoryRequest("One more", null), someone, false))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(com.blog.common.exception.ErrorCode.AUTHOR_QUOTA_EXCEEDED);
                    assertThat(e.getStatus()).isEqualTo(org.springframework.http.HttpStatus.UNPROCESSABLE_CONTENT);
                });
        org.mockito.Mockito.verify(categoryRepository, org.mockito.Mockito.never())
                .save(any(Category.class));

        when(categoryRepository.existsByNameIgnoreCase("One more")).thenReturn(false);
        when(categoryRepository.existsBySlug("one-more")).thenReturn(false);
        when(categoryRepository.save(any(Category.class))).thenAnswer(invocation -> invocation.getArgument(0));
        assertThat(categoryService
                        .create(new CategoryRequest("One more", null), someone, true)
                        .slug())
                .isEqualTo("one-more");
    }
}
