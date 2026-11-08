package com.blog.contact.controller;

import com.blog.common.ratelimit.ClientAddressResolver;
import com.blog.common.response.ApiResponse;
import com.blog.contact.dto.ContactMessageRequest;
import com.blog.contact.dto.ContactReceivedResponse;
import com.blog.contact.service.ContactService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The public contact form, no login required (SecurityConfig): only the Next BFF route calls it. A successful response
 * is a constant and never echoes a submitted field.
 */
@RestController
@RequestMapping("/api/v1/contact")
@RequiredArgsConstructor
public class ContactController {

    private final ContactService contactService;
    private final ClientAddressResolver clientAddresses;

    @PostMapping("/messages")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public ApiResponse<ContactReceivedResponse> send(
            @Valid @RequestBody ContactMessageRequest request, HttpServletRequest http) {
        contactService.submit(request, clientAddresses.resolve(http));
        return ApiResponse.of(ContactReceivedResponse.RECEIVED);
    }
}
