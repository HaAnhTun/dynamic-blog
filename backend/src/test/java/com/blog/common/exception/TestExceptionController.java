package com.blog.common.exception;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

@RestController
class TestExceptionController {

    // MockMvc does not go through Tomcat's multipart parser (a fake multipart request is already "parsed"
    // beforehand), so the spring.servlet.multipart.* limit never throws in a test. This throws directly exactly the
    // exception
    // that DispatcherServlet throws when a part exceeds max-file-size; the real path through Tomcat is checked with
    // curl in QA.
    @PostMapping("/__test/throw-max-upload-size")
    public void throwMaxUploadSize() {
        throw new MaxUploadSizeExceededException(10L * 1024 * 1024);
    }

    @PostMapping("/__test/throw-api-exception")
    public void throwApiException() {
        throw new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found");
    }

    @PostMapping("/__test/validate")
    public void validate(@Valid @RequestBody TestPayload payload) {}

    @PostMapping("/__test/throw-data-integrity-violation")
    public void throwDataIntegrityViolation() {
        throw new DataIntegrityViolationException("duplicate key value violates unique constraint");
    }

    @PostMapping("/__test/throw-runtime-exception")
    public void throwRuntimeException() {
        throw new RuntimeException("boom - this detail must never reach the caller");
    }

    record TestPayload(@NotBlank String name) {}
}
