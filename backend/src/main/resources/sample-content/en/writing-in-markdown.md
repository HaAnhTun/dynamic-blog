title: Writing in Markdown
excerpt: The Markdown features that posts can use: headings, lists, tables, code blocks, links and quotes, each shown once.
slug: writing-in-markdown
category: Guides
tags: markdown
series: Getting started
group: markdown

## Why Markdown

Posts are written in plain text with a few marks for structure. You do not need a visual editor, and the text stays
readable even before it is rendered.

## Headings and emphasis

Use `##` for a section and `###` for a subsection. Wrap a word in `*stars*` for emphasis or `**two stars**` for strong
emphasis.

## Lists

1. Write the first draft.
2. Read it once more and cut what you do not need.
3. Publish it.

Unordered lists use a dash:

- a short item
- another short item

## A table

| Mark | Result |
|---|---|
| `# Title` | A top level heading |
| `- item` | A bullet |
| `> text` | A quotation |

## Code

Fenced code blocks keep their spacing and are highlighted by language:

```java
public class Hello {
    public static void main(String[] args) {
        System.out.println("Hello, blog");
    }
}
```

## Links and quotes

A link looks like `[text](https://example.com)`. For the full list of marks, read the
[CommonMark guide](https://commonmark.org/help/).

> Write for one reader you know. The rest of the readers will follow.
