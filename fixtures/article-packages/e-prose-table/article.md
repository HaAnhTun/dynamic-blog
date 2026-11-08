---
title: Notes on choosing a release rhythm
slug: blocks-demo-prose-table
language: en
excerpt: A plain article of headings, prose and one table, to show that a post does not need any block to be a valid and well formed article.
category: Notes
tags: notes, releases, planning
---

Not every article needs structure beyond its words. This one uses only headings, paragraphs, a list and a table, which is what most posts look like, and it must render and import exactly as well as the richer examples.

## Why a rhythm at all

A team that ships whenever something is ready ships in bursts. A team that ships on a rhythm learns how long things take. The rhythm does not have to be fast, only regular, because regularity is what makes estimates honest.

## Three common rhythms

The table lists three rhythms and what each one is good for. None of them is right for everyone.

| Rhythm | Strength | Weakness |
|---|---|---|
| Continuous | Small changes, quick feedback | Needs strong automated checks |
| Every two weeks | Predictable for customers | A late change waits for the next cycle |
| Every quarter | Room for large pieces of work | Long gaps hide problems |

## Choosing between them

Start from the cost of a mistake that reaches customers. When it is low and you can undo it quickly, ship continuously. When each release needs coordination with other teams, a fixed cycle spares everyone the surprise.

### Questions to ask

- How long does it take to undo a release?
- Who has to be told, and how far ahead?
- How often do changes depend on each other?

## A closing thought

Pick a rhythm, keep it for a few cycles and then look at what the numbers say. Changing it after one bad release teaches you about that release, not about the rhythm.
