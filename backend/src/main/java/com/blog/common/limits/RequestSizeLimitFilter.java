package com.blog.common.limits;

import com.blog.common.exception.ErrorCode;
import com.blog.common.response.ErrorResponse;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;

/**
 * Refuses a request body that is larger than its path allows, with a 413, before a controller, Jackson or the security
 * chain reads it (issues 118 and 036).
 *
 * Two ceilings, from {@link RequestLimitProperties}: the small one for every {@code /api/**} path except
 * {@code /api/v1/admin/**}, which has the large one (a post is the biggest honest body). A request that declares its
 * length above the ceiling is answered without reading a byte. A request that does not (chunked) is read through a
 * counting stream that throws {@link RequestBodyTooLargeException} at the first byte past the ceiling, which the message
 * handler turns into the same 413. Multipart uploads are left to their own limits ({@code spring.servlet.multipart.*}).
 *
 * The path that decides is the container's normalised servlet path, not the raw request line, so {@code /api/v1/admin/../auth/login}
 * cannot borrow the admin ceiling. Registered ahead of the security filter chain ({@code RequestLimitConfig}), so an
 * anonymous caller is refused before its token is even looked at. Not a {@code @Component}: that would register it a second
 * time at the lowest precedence.
 */
public final class RequestSizeLimitFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(RequestSizeLimitFilter.class);

    static final String ADMIN_PREFIX = "/api/v1/admin/";
    static final String TOO_LARGE_MESSAGE = "The request body is too large";

    private final long publicLimit;
    private final long adminLimit;
    private final ObjectMapper objectMapper;

    public RequestSizeLimitFilter(long publicLimit, long adminLimit, ObjectMapper objectMapper) {
        this.publicLimit = publicLimit;
        this.adminLimit = adminLimit;
        this.objectMapper = objectMapper;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (isMultipart(request)) {
            chain.doFilter(request, response);
            return;
        }
        long limit = limitFor(request);
        long declared = request.getContentLengthLong();
        if (declared > limit) {
            reject(response);
            return;
        }
        if (declared < 0) {
            // No declared length (chunked): nothing stops the sender, so the bytes are counted as they are read.
            filterCounting(request, response, chain, limit);
            return;
        }
        chain.doFilter(request, response);
    }

    /**
     * Spring MVC's message converter turns the exception of the counting stream into a 413 (GlobalExceptionHandler), but a
     * filter further down the chain can read the body too: Spring Boot's FormContentFilter drains a PUT, PATCH or DELETE
     * form body whole. The exception then leaves the chain, and the container would log it at ERROR with a stack trace and
     * answer 500, which an anonymous caller could repeat at will. So it is caught here and answered like the declared case.
     */
    private void filterCounting(HttpServletRequest request, HttpServletResponse response, FilterChain chain, long limit)
            throws IOException, ServletException {
        try {
            chain.doFilter(new CountingRequest(request, limit), response);
        } catch (IOException | ServletException | RuntimeException e) {
            if (!RequestBodyTooLargeException.isIn(e) || response.isCommitted()) {
                throw e;
            }
            response.resetBuffer();
            reject(response);
        }
    }

    private long limitFor(HttpServletRequest request) {
        return pathOf(request).startsWith(ADMIN_PREFIX) ? adminLimit : publicLimit;
    }

    /** The container's normalised, decoded path (no path parameters, dot segments resolved); the request line only when the container gave none. */
    private static String pathOf(HttpServletRequest request) {
        String servletPath = request.getServletPath();
        if (servletPath != null && !servletPath.isEmpty()) {
            String info = request.getPathInfo();
            return info == null ? servletPath : servletPath + info;
        }
        String uri = request.getRequestURI();
        String context = request.getContextPath();
        return context != null && !context.isEmpty() && uri.startsWith(context) ? uri.substring(context.length()) : uri;
    }

    private static boolean isMultipart(HttpServletRequest request) {
        String type = request.getContentType();
        return type != null && type.toLowerCase(Locale.ROOT).startsWith("multipart/");
    }

    private void reject(HttpServletResponse response) throws IOException {
        String traceId = UUID.randomUUID().toString();
        // Anonymous traffic can send these without limit: DEBUG, like the other expected client errors (issue 089).
        log.debug("Request body over the limit traceId={}", traceId);
        response.setStatus(HttpStatus.CONTENT_TOO_LARGE.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        // The rest of the body is not wanted: tell the client not to reuse the connection.
        response.setHeader("Connection", "close");
        objectMapper.writeValue(
                response.getOutputStream(),
                new ErrorResponse(
                        new ErrorResponse.ErrorBody(ErrorCode.VALIDATION_ERROR.name(), TOO_LARGE_MESSAGE, traceId)));
    }

    /** The request with its body read through {@link LimitedInputStream}. */
    private static final class CountingRequest extends HttpServletRequestWrapper {

        private final long limit;
        private ServletInputStream stream;
        private BufferedReader reader;

        CountingRequest(HttpServletRequest request, long limit) {
            super(request);
            this.limit = limit;
        }

        @Override
        public ServletInputStream getInputStream() throws IOException {
            if (reader != null) {
                throw new IllegalStateException("getReader() has already been called for this request");
            }
            if (stream == null) {
                stream = new LimitedInputStream(super.getInputStream(), limit);
            }
            return stream;
        }

        @Override
        public BufferedReader getReader() throws IOException {
            if (stream != null) {
                throw new IllegalStateException("getInputStream() has already been called for this request");
            }
            if (reader == null) {
                String name = getCharacterEncoding();
                Charset charset = name == null ? StandardCharsets.UTF_8 : Charset.forName(name);
                reader = new BufferedReader(
                        new InputStreamReader(new LimitedInputStream(super.getInputStream(), limit), charset));
            }
            return reader;
        }
    }

    /** Passes the bytes through and throws at the first one past the limit. */
    private static final class LimitedInputStream extends ServletInputStream {

        private final ServletInputStream delegate;
        private final long limit;
        private long count;

        LimitedInputStream(ServletInputStream delegate, long limit) {
            this.delegate = delegate;
            this.limit = limit;
        }

        @Override
        public int read() throws IOException {
            int value = delegate.read();
            if (value >= 0) {
                add(1);
            }
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int read = delegate.read(buffer, offset, length);
            if (read > 0) {
                add(read);
            }
            return read;
        }

        private void add(long bytes) throws IOException {
            count += bytes;
            if (count > limit) {
                throw new RequestBodyTooLargeException(limit);
            }
        }

        @Override
        public int available() throws IOException {
            return delegate.available();
        }

        @Override
        public void close() throws IOException {
            delegate.close();
        }

        @Override
        public boolean isFinished() {
            return delegate.isFinished();
        }

        @Override
        public boolean isReady() {
            return delegate.isReady();
        }

        @Override
        public void setReadListener(ReadListener readListener) {
            delegate.setReadListener(readListener);
        }
    }
}
