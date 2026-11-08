package com.blog.postimport.controller;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.response.ErrorResponse;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/** The answer of the controller's own handler for a violation that only shows at commit. */
class AdminPostImportControllerTest {

    @Test
    void a_violation_found_at_commit_is_a_stable_conflict_with_a_trace_id_and_no_detail() {
        ResponseEntity<ErrorResponse> response = new AdminPostImportController(null).dataIntegrity();

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getHeaders().getContentType()).isEqualTo(MediaType.APPLICATION_JSON);
        ErrorResponse.ErrorBody body = response.getBody().error();
        assertThat(body.code()).isEqualTo("POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(body.message()).doesNotContain("constraint", "Key (", "duplicate");
        assertThat(UUID.fromString(body.traceId())).isNotNull();
    }
}
