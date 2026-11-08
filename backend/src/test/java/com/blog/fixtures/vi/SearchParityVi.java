package com.blog.fixtures.vi;

/** Vietnamese corpus and queries of the Meilisearch versus Postgres parity test. */
public final class SearchParityVi {

    /** title of the "Machine learning basics" post */
    public static final String HOC_MAY_TITLE = "Học máy cơ bản";

    /** body about machine learning and training data */
    public static final String HOC_MAY_BODY = "Bài này nói về học máy và dữ liệu huấn luyện.";

    /** title "Data pipeline" with d-stroke */
    public static final String DUONG_ONG_TITLE = "Đường ống dữ liệu";

    /** body about building a pipeline with Kafka and Debezium */
    public static final String DUONG_ONG_BODY = "Xây đường ống với Kafka và Debezium.";

    /** title "Spring Boot in practice" */
    public static final String SPRING_BOOT_TITLE = "Spring Boot thực chiến";

    /** body about building a REST API with Spring Boot 3 */
    public static final String SPRING_BOOT_BODY = "Dựng REST API với Spring Boot 3.";

    /** title "Written as one word" */
    public static final String SPRINGBOOT_TITLE = "Viết liền một từ";

    /** body saying many people type SpringBoot as one word */
    public static final String SPRINGBOOT_BODY = "Nhiều người gõ SpringBoot thành một từ.";

    /** title "Full-text search" */
    public static final String POSTGRESQL_TITLE = "Tìm kiếm toàn văn";

    /** body about full-text search with PostgreSQL and tsvector */
    public static final String POSTGRESQL_BODY = "Full-text với PostgreSQL và tsvector.";

    /** title "Naming variables" */
    public static final String SNAKE_CASE_TITLE = "Đặt tên biến";

    /** body about snake_case in Python with an inline code identifier */
    public static final String SNAKE_CASE_BODY = "Python dùng snake_case, ví dụ `max_retry_count`.";

    /** title "Reading JSON safely" */
    public static final String JSON_LOADS_TITLE = "Đọc JSON an toàn";

    /** Markdown body with a code block and a sentence about catching json.loads errors */
    public static final String JSON_LOADS_BODY =
            "```python\ndata = json.loads(raw)\n```\n\nLuôn bắt lỗi khi gọi json.loads ở biên.";

    /** body about C++ templates and RAII */
    public static final String CPP_BODY = "C++ có template và RAII.";

    /** body about C# and LINQ */
    public static final String CSHARP_BODY = "C# và .NET có LINQ.";

    /** title "The plain C language" */
    public static final String C_PURE_TITLE = "Ngôn ngữ C thuần";

    /** body about writing a driver in C with pointers */
    public static final String C_PURE_BODY = "Viết driver bằng C và con trỏ.";

    /** body saying Next.js 15 uses React Server Components */
    public static final String NEXTJS_BODY = "Next.js 15 dùng React Server Components.";

    /** title "Events and functions" */
    public static final String FUNCTIONS_TITLE = "Sự kiện và hàm";

    /** body about Azure Functions cold start when reading Kafka */
    public static final String FUNCTIONS_BODY = "Cold start của Azure Functions khi đọc Kafka.";

    /** title "End-to-end testing" */
    public static final String PLAYWRIGHT_TITLE = "Kiểm thử đầu cuối";

    /** body saying Playwright runs E2E on Chromium */
    public static final String PLAYWRIGHT_BODY = "Playwright chạy E2E trên Chromium.";

    /** query "machine learning" with diacritics */
    public static final String QUERY_HOC_MAY = "học máy";

    /** query "Pipeline" with diacritics and capital d-stroke */
    public static final String QUERY_DUONG_ONG = "Đường ống";

    /** query "pipe" with d-stroke */
    public static final String QUERY_DUONG = "đường";

    private SearchParityVi() {}
}
