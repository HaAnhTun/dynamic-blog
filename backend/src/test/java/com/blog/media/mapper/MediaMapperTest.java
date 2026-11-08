package com.blog.media.mapper;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.media.dto.MediaResponse;
import com.blog.media.entity.Media;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class MediaMapperTest {

    @Test
    void jpeg_and_png_images_have_file_name_by_stored_type() {
        UUID id = UUID.randomUUID();
        Media jpeg = media(id, "image/jpeg");
        jpeg.setAltText("Description");

        MediaResponse response = MediaMapper.toResponse(jpeg);

        assertThat(response.id()).isEqualTo(id);
        assertThat(response.fileName()).isEqualTo(id + ".jpg");
        assertThat(response.width()).isEqualTo(20);
        assertThat(response.height()).isEqualTo(30);
        assertThat(response.altText()).isEqualTo("Description");
        assertThat(response.dominantColor()).isEqualTo("#336699");
        assertThat(MediaMapper.toResponse(media(id, "image/png")).fileName()).isEqualTo(id + ".png");
    }

    @Test
    void no_image_gives_null() {
        // A post without a cover image: cover is null in the JSON, not an empty object.
        assertThat(MediaMapper.toResponse(null)).isNull();
    }

    @Test
    void public_response_does_not_carry_admin_only_fields() {
        // MediaResponse sits inside the public post DTO. The original file name (could be "ID card front.jpg"),
        // the uploader, the byte size and the sha256 do not belong there; the ETag already carries the sha256 in its
        // proper place.
        String[] components = Arrays.stream(MediaResponse.class.getRecordComponents())
                .map(RecordComponent::getName)
                .toArray(String[]::new);

        assertThat(components).containsExactly("id", "fileName", "width", "height", "altText", "dominantColor");
        assertThat(components).doesNotContain("originalFilename", "uploadedBy", "byteSize", "sha256");
    }

    private static Media media(UUID id, String contentType) {
        Media media = new Media();
        media.setId(id);
        media.setContentType(contentType);
        media.setWidth(20);
        media.setHeight(30);
        media.setDominantColor("#336699");
        media.setOriginalFilename("id-card-front.jpg");
        return media;
    }
}
