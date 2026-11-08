package com.blog.tag.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.blog.common.exception.ApiException;
import com.blog.common.i18n.LocalizedText;
import com.blog.common.i18n.TaxonomyTranslations;
import com.blog.common.quota.AuthorQuotaProperties;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.search.sync.SearchOutbox;
import com.blog.tag.dto.TagRequest;
import com.blog.tag.entity.Tag;
import com.blog.tag.repository.TagRepository;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class TagServiceTest {

    @Mock
    private TagRepository tagRepository;
    // Changes write the search outbox; without this mock @InjectMocks passes null. The write rules
    // are checked against a real DB and Meilisearch in SearchOutboxIT.
    @Mock
    private SearchOutbox searchOutbox;

    @Mock
    private TaxonomyTranslations taxonomyTranslations;

    @Mock
    private RateLimiter rateLimiter;

    // A small catalog so that the test needs few tags.
    @Mock
    private AuthorQuotaProperties authorQuota;

    @org.junit.jupiter.api.BeforeEach
    void smallCatalog() {
        org.mockito.Mockito.lenient().when(authorQuota.maxTags()).thenReturn(2);
    }

    @InjectMocks
    private TagService tagService;

    @Test
    void createGeneratesSlugFromName() {
        when(tagRepository.existsByNameIgnoreCase("Spring Boot")).thenReturn(false);
        when(tagRepository.existsBySlug("spring-boot")).thenReturn(false);
        when(tagRepository.save(any(Tag.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = tagService.create(new TagRequest("Spring Boot"));

        assertThat(response.slug()).isEqualTo("spring-boot");
    }

    @Test
    void createRejectsCaseInsensitiveDuplicateName() {
        when(tagRepository.existsByNameIgnoreCase("spring boot")).thenReturn(true);

        assertThatThrownBy(() -> tagService.create(new TagRequest("spring boot")))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("already exists");
    }

    @Test
    void createTrimsNameBeforeDuplicateCheckAndSlugGeneration() {
        when(tagRepository.existsByNameIgnoreCase("Spring Boot")).thenReturn(false);
        when(tagRepository.existsBySlug("spring-boot")).thenReturn(false);
        when(tagRepository.save(any(Tag.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = tagService.create(new TagRequest(" Spring Boot "));

        assertThat(response.name()).isEqualTo("Spring Boot");
        assertThat(response.slug()).isEqualTo("spring-boot");
    }

    @Test
    void createRejectsDuplicateNameThatOnlyDiffersByWhitespace() {
        when(tagRepository.existsByNameIgnoreCase("Spring Boot")).thenReturn(true);

        assertThatThrownBy(() -> tagService.create(new TagRequest(" Spring Boot ")))
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
        when(tagRepository.existsByNameIgnoreCase("Spring Boot")).thenReturn(false);
        when(tagRepository.existsBySlug("spring-boot")).thenReturn(false);
        when(tagRepository.save(any(Tag.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = tagService.create(new TagRequest(" Spring Boot "));

        assertThat(response.name()).isEqualTo("Spring Boot");
        assertThat(response.slug()).isEqualTo("spring-boot");
    }

    @Test
    void createKeepsOnlyTheTranslatedNamesAndTheAdminResponseCarriesThem() {
        Map<String, LocalizedText> given = Map.of("en", new LocalizedText("English", "ignored"));
        when(tagRepository.existsByNameIgnoreCase("Spring Boot")).thenReturn(false);
        when(tagRepository.existsBySlug("spring-boot")).thenReturn(false);
        when(taxonomyTranslations.normalize(given, 100, Integer.MAX_VALUE)).thenReturn(given);
        when(tagRepository.save(any(Tag.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = tagService.create(new TagRequest("Spring Boot", given));

        assertThat(response.translations()).containsOnlyKeys("en");
        assertThat(response.translations().get("en")).isEqualTo(new LocalizedText("English", null));
    }

    @Test
    void publicListLocalizesTheNameOnlyWhenALanguageIsGivenAndNeverCarriesTheRawTranslations() {
        Tag tag = new Tag();
        tag.setName("Spring Boot");
        tag.setSlug("spring-boot");
        tag.setTranslations(Map.of("en", new LocalizedText("English", null)));
        when(tagRepository.findAllWithPublishedPosts()).thenReturn(List.of(tag));
        when(tagRepository.findAllWithPublishedPostsIn("en")).thenReturn(List.of(tag));

        assertThat(tagService.listPublic().getFirst().name()).isEqualTo("Spring Boot");
        assertThat(tagService.listPublic().getFirst().translations()).isNull();
        assertThat(tagService.listPublic("en").getFirst().name()).isEqualTo("English");
        assertThat(tagService.listPublic("en").getFirst().translations()).isNull();
    }

    /** A text-direction override (U+202E) in a name: the classic way to make a label read as something else. */
    private static String withOverride(String left, String right) {
        return left + new String(Character.toChars(0x202E)) + right;
    }

    @Test
    void createRemovesTextDirectionAndInvisibleCharactersFromTheName() {
        when(tagRepository.existsByNameIgnoreCase("tag")).thenReturn(false);
        when(tagRepository.existsBySlug("tag")).thenReturn(false);
        when(tagRepository.save(any(Tag.class))).thenAnswer(invocation -> invocation.getArgument(0));

        var response = tagService.create(new TagRequest(withOverride("ta", "g")));

        assertThat(response.name()).isEqualTo("tag");
        assertThat(response.slug()).isEqualTo("tag");
    }

    @Test
    void createRefusesANameWithNothingVisibleLeft() {
        assertThatThrownBy(() -> tagService.create(new TagRequest(withOverride("", ""))))
                .isInstanceOfSatisfying(
                        ApiException.class,
                        e -> assertThat(e.getStatus()).isEqualTo(org.springframework.http.HttpStatus.BAD_REQUEST));
    }

    @Test
    void renameRemovesTextDirectionCharactersBeforeTheDuplicateCheck() {
        java.util.UUID id = java.util.UUID.randomUUID();
        Tag tag = new Tag();
        tag.setName("old");
        tag.setSlug("old");
        when(tagRepository.findByIdForUpdate(id)).thenReturn(java.util.Optional.of(tag));
        when(tagRepository.existsByNameIgnoreCaseAndIdNot("tag", id)).thenReturn(false);

        var response = tagService.update(id, new TagRequest(withOverride("ta", "g")));

        assertThat(response.name()).isEqualTo("tag");
    }

    // --- What an AUTHOR may create -------------------------------------------------------------------

    @Test
    void an_author_creation_counts_against_the_taxonomy_bucket_and_works_below_the_catalog_limit() {
        java.util.UUID author = java.util.UUID.randomUUID();
        when(tagRepository.count()).thenReturn(1L);
        when(tagRepository.existsByNameIgnoreCase("Fresh")).thenReturn(false);
        when(tagRepository.existsBySlug("fresh")).thenReturn(false);
        when(tagRepository.save(any(Tag.class))).thenAnswer(invocation -> invocation.getArgument(0));

        assertThat(tagService.create(new TagRequest("Fresh"), author, false).slug())
                .isEqualTo("fresh");

        org.mockito.Mockito.verify(rateLimiter).check(RateLimiter.TAXONOMY_CREATE, author);
    }

    @Test
    void an_author_cannot_add_a_tag_to_a_full_catalog_but_an_admin_can() {
        java.util.UUID someone = java.util.UUID.randomUUID();
        when(tagRepository.count()).thenReturn(2L);

        assertThatThrownBy(() -> tagService.create(new TagRequest("One more"), someone, false))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(com.blog.common.exception.ErrorCode.AUTHOR_QUOTA_EXCEEDED);
                    assertThat(e.getStatus()).isEqualTo(org.springframework.http.HttpStatus.UNPROCESSABLE_CONTENT);
                });
        org.mockito.Mockito.verify(tagRepository, org.mockito.Mockito.never()).save(any(Tag.class));

        when(tagRepository.existsByNameIgnoreCase("One more")).thenReturn(false);
        when(tagRepository.existsBySlug("one-more")).thenReturn(false);
        when(tagRepository.save(any(Tag.class))).thenAnswer(invocation -> invocation.getArgument(0));
        assertThat(tagService.create(new TagRequest("One more"), someone, true).slug())
                .isEqualTo("one-more");
        org.mockito.Mockito.verify(rateLimiter, org.mockito.Mockito.times(1))
                .check(RateLimiter.TAXONOMY_CREATE, someone);
    }
}
