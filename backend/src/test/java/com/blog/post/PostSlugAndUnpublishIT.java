package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.fixtures.vi.ContentSlugVi;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

@AutoConfigureMockMvc
class PostSlugAndUnpublishIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    private String admin() {
        return auth.bearerForAdmin();
    }

    private String createPost(String body) throws Exception {
        String created = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return objectMapper.readTree(created).path("data").path("id").asString();
    }

    @Test
    void aVietnameseTitleBecomesAnAsciiSlug() throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content(
                                "{\"title\":\"" + ContentSlugVi.TITLE_WITH_DIACRITICS + "\",\"content\":\"noi dung\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.slug").value("hoc-spring-boot-tu-dau"));
    }

    @Test
    void aSuppliedSlugIsHonouredAndNormalised() throws Exception {
        // The author types into the slug box. Whatever they type is slugified, so the
        // stored value is always a legal URL segment even when they paste a title.
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"" + ContentSlugVi.FIRST_POST_TITLE + "\",\"content\":\"x\",\"slug\":\""
                                + ContentSlugVi.SUPPLIED_SLUG + "\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.slug").value("gioi-thieu-blog"));
    }

    @Test
    void aSlugThatNormalisesToNothingFallsBackToTheTitle() throws Exception {
        // "???" survives normalisation as nothing at all. The existing SlugGenerator
        // answers "untitled" in that case, which is the right answer for a post with no
        // usable TITLE and the wrong answer here: this title is perfectly good, so an
        // author who typed punctuation into the slug box should get the title's slug
        // rather than a post living at /posts/untitled.
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Real title\",\"content\":\"x\",\"slug\":\"???\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.slug").value("real-title"));
    }

    @Test
    void aTitleThatNormalisesToNothingStillGetsAUsableSlug() throws Exception {
        // What "untitled" exists for, and it must keep working: this is Sprint 2
        // behaviour that the new fallback must not displace.
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"???\",\"content\":\"x\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.slug").value("untitled"));
    }

    @Test
    void anEditedTitleDoesNotMoveAPublishedPost() throws Exception {
        String id = createPost(
                "{\"title\":\"Title with a typo\",\"content\":\"x\",\"categoryId\":" + categoryIdJson() + "}");
        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/publish").header("Authorization", admin()))
                .andExpect(status().isOk());

        // The title is corrected and NO slug is sent. A published URL must survive that.
        mockMvc.perform(put("/api/v1/admin/posts/" + id)
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Edited title\",\"content\":\"x\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.title").value("Edited title"))
                .andExpect(jsonPath("$.data.slug").value("title-with-a-typo"));
    }

    @Test
    void resubmittingAPostsOwnSlugDoesNotSuffixIt() throws Exception {
        // The editor sends the slug field on every save, so the common case is a slug
        // that already belongs to this post. Naive uniqueness would rename it to
        // "keep-as-is-2" on the first save and "keep-as-is-2-2" on the next.
        String id = createPost("{\"title\":\"Keep as is\",\"content\":\"x\"}");

        for (int i = 0; i < 2; i++) {
            mockMvc.perform(put("/api/v1/admin/posts/" + id)
                            .header("Authorization", admin())
                            .contentType(APPLICATION_JSON)
                            .content("{\"title\":\"Keep as is\",\"content\":\"x\",\"slug\":\"keep-as-is\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.slug").value("keep-as-is"));
        }
    }

    @Test
    void aSlugTakenByAnotherPostIsSuffixed() throws Exception {
        createPost("{\"title\":\"Duplicate\",\"content\":\"x\"}");
        String second = createPost("{\"title\":\"Khac\",\"content\":\"x\"}");

        String body = mockMvc.perform(put("/api/v1/admin/posts/" + second)
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Khac\",\"content\":\"x\",\"slug\":\"duplicate\"}"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();

        String slug = objectMapper.readTree(body).path("data").path("slug").asString();
        assertThat(slug).isNotEqualTo("duplicate").startsWith("duplicate");
    }

    @Test
    void unpublishReturnsAPostToDraftAndTakesItOffThePublicApi() throws Exception {
        String id = createPost("{\"title\":\"Rut lai\",\"content\":\"x\",\"categoryId\":" + categoryIdJson() + "}");
        String published = mockMvc.perform(
                        post("/api/v1/admin/posts/" + id + "/publish").header("Authorization", admin()))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String slug = objectMapper.readTree(published).path("data").path("slug").asString();
        String publishedAt = objectMapper
                .readTree(published)
                .path("data")
                .path("publishedAt")
                .asString();

        // Visible publicly first — otherwise the disappearance below proves nothing.
        mockMvc.perform(get("/api/v1/posts/" + slug)).andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/unpublish").header("Authorization", admin()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("DRAFT"))
                // publishedAt is NOT cleared: it records when this post first went out,
                // and publish() already guarantees it never changes once set.
                .andExpect(jsonPath("$.data.publishedAt").value(publishedAt));

        mockMvc.perform(get("/api/v1/posts/" + slug)).andExpect(status().isNotFound());
    }

    @Test
    void unpublishingADraftIsRejectedRatherThanSilentlyDoingNothing() throws Exception {
        String id = createPost("{\"title\":\"Van la draft\",\"content\":\"x\"}");

        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/unpublish").header("Authorization", admin()))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_PUBLISHABLE"));
    }

    @Test
    void tagsComeBackAsObjectsWithSlugs() throws Exception {
        String tag = mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"" + ContentSlugVi.TAG_NAME + "\"}"))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        String tagId = objectMapper.readTree(tag).path("data").path("id").asString();

        // The whole point: the editor needs the id to re-submit the selection, and the
        // public tag chip needs the slug to build a working link. A bare name gives
        // neither — the name used here has the slug "duong-nguyen-hue".
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Co tag\",\"content\":\"x\",\"tagIds\":[\"" + tagId + "\"]}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.tags[0].id").value(tagId))
                .andExpect(jsonPath("$.data.tags[0].name").value(ContentSlugVi.TAG_NAME))
                .andExpect(jsonPath("$.data.tags[0].slug").value("duong-nguyen-hue"));
    }

    @Test
    void tagsComeBackSortedByName() throws Exception {
        // PostMapper sorts tags with Comparator.comparing(Tag::getName) to preserve the
        // ordering Sprint 2's public API already had. Nothing asserted it: no backend test
        // created a post with more than one tag, so changing that comparator — or dropping
        // the sort and inheriting the Set's arbitrary order — would have failed nothing and
        // quietly reshuffled every tag list on the site.
        //
        // The three names are picked so that sorting by NAME and sorting by SLUG give
        // different answers, which is what makes this a test of the comparator rather than
        // of "some ordering happened". Comparator.comparing on a String is code-unit order,
        // so uppercase sorts before lowercase:
        //
        //   by name: "Spring" < "Zod" < "angular"
        //   by slug: "angular" < "spring" < "zod"
        //
        // and they are inserted in a third order again, so insertion order is excluded too.
        String spring = tagId("Spring");
        String zod = tagId("Zod");
        String angular = tagId("angular");

        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Nhieu tag\",\"content\":\"x\",\"tagIds\":[\"" + angular + "\",\"" + zod
                                + "\",\"" + spring + "\"]}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.tags[0].name").value("Spring"))
                .andExpect(jsonPath("$.data.tags[1].name").value("Zod"))
                .andExpect(jsonPath("$.data.tags[2].name").value("angular"))
                // And the slugs, so the comment above is checked rather than asserted: if
                // these were the sort key the order would have been the reverse of this.
                .andExpect(jsonPath("$.data.tags[0].slug").value("spring"))
                .andExpect(jsonPath("$.data.tags[2].slug").value("angular"));
    }

    /** Creates a tag and returns its id. */
    private String tagId(String name) throws Exception {
        String body = mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"" + name + "\"}"))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return objectMapper.readTree(body).path("data").path("id").asString();
    }

    @Test
    void theAdminListCarriesStatus() throws Exception {
        createPost("{\"title\":\"Trong danh sach\",\"content\":\"x\"}");

        mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", admin()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].status").isNotEmpty());
    }

    /** The seeded category's id, as a JSON string literal including its quotes. */
    private String categoryIdJson() throws Exception {
        String body = mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin())
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"Chuyen muc " + java.util.UUID.randomUUID() + "\"}"))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return "\"" + objectMapper.readTree(body).path("data").path("id").asString() + "\"";
    }
}
