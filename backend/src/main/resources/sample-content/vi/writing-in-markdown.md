title: Viết bài bằng Markdown
excerpt: Những tính năng Markdown mà bài viết có thể dùng: tiêu đề, danh sách, bảng, khối mã, liên kết và trích dẫn, mỗi thứ một ví dụ.
slug: viet-bang-markdown
category: Hướng dẫn
tags: markdown
series: Bắt đầu
group: markdown

## Vì sao dùng Markdown

Bài viết được soạn bằng văn bản thuần với vài ký hiệu để tạo cấu trúc. Bạn không cần trình soạn thảo trực quan, và văn bản
vẫn dễ đọc ngay cả trước khi được hiển thị.

## Tiêu đề và nhấn mạnh

Dùng `##` cho một phần và `###` cho phần con. Bao một từ trong `*dấu sao*` để nhấn mạnh hoặc `**hai dấu sao**` để nhấn mạnh
mạnh hơn.

## Danh sách

1. Viết bản nháp đầu tiên.
2. Đọc lại một lần nữa và cắt những gì không cần.
3. Đăng bài.

Danh sách không đánh số dùng dấu gạch ngang:

- một mục ngắn
- một mục ngắn khác

## Một bảng

| Ký hiệu | Kết quả |
|---|---|
| `# Tiêu đề` | Tiêu đề cấp cao nhất |
| `- mục` | Một dấu đầu dòng |
| `> văn bản` | Một đoạn trích dẫn |

## Mã nguồn

Khối mã giữ nguyên khoảng trắng và được tô màu theo ngôn ngữ:

```java
public class Hello {
    public static void main(String[] args) {
        System.out.println("Hello, blog");
    }
}
```

## Liên kết và trích dẫn

Một liên kết có dạng `[văn bản](https://example.com)`. Để xem đầy đủ các ký hiệu, đọc
[hướng dẫn CommonMark](https://commonmark.org/help/).

> Hãy viết cho một người đọc mà bạn biết. Những người đọc còn lại sẽ theo sau.
