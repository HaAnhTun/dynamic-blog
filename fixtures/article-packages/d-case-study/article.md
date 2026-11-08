---
title: Case study, from fourteen dashboards to three
slug: blocks-demo-case-study
language: en
excerpt: A fictional operations team replaces a wall of fourteen panels with three, and compares the options it weighed, the before and after states and what the change did and did not fix.
category: Case studies
tags: case-study, dashboards, operations
---

A small operations team ran one dashboard with fourteen panels. During incidents nobody could say which panel mattered. This case study describes how the team cut it to three, what it compared on the way and what it learned. The team and its numbers are fictional.

## Context and constraints

The service had around two hundred customers and an on-call rotation of five people. The dashboard had grown by addition: every incident left a new panel behind and nothing was ever removed.

Three constraints shaped the work. The change had to ship within a sprint. The on-call engineers could not lose any alert they relied on. And the data sources could not change, so every panel had to come from metrics that already existed.

## The options

The team considered four ways forward and scored them against the constraints.

:::comparison{title="Options compared" caption="Scores run from 1 (poor) to 5 (strong) and come from a short team vote."}
| Option | Fits one sprint | Keeps every alert | Easier to read | Total |
|---|---|---|---|---|
| Leave it as it is | 5 | 5 | 1 | 11 |
| Reorder the panels | 5 | 5 | 2 | 12 |
| Three panels plus alert links | 4 | 4 | 5 | 13 |
| Rebuild on a new tool | 1 | 3 | 5 | 9 |
:::

Reordering helped a little and cost almost nothing, but it kept every panel. The rebuild scored well on reading and badly on time. Three panels with links to the details won.

## Before and after

The panels on the left answered fourteen questions at once. The new ones answer the three questions that an engineer asks first: are errors rising, is it slow, and is work piling up.

::::compare{variant="before-after"}
:::pane{title="Before: fourteen panels"}
::figure{src="assets/before.png" alt="A dashboard made of fourteen small panels, each with six coloured bars." caption="Every question at the same volume."}
:::

:::pane{title="After: three panels"}
::figure{src="assets/after.png" alt="A dashboard made of three larger panels titled errors, latency and queue depth." caption="The three first questions."}
:::
::::

## Findings

The time to the first useful action in the next four incidents dropped from about twelve minutes to about five. Two of the four incidents were caused by the same fault, so the sample is small and the result is encouraging rather than proven.

:::pullquote{attribution="An on-call engineer in the survey"}
I stopped scanning and started reading.
:::

The detail panels were not deleted. They moved one click away, behind links from the three main panels, and the alerts that fed them were left alone.

## Limits of the study

Four incidents is not many, and the engineers knew the old dashboard well, so part of the gain may be novelty. The team did not measure how often people clicked through to the detail panels, which is the number that would show whether the three panels were enough.

:::details{title="How the numbers were collected" variant="appendix"}
Time to first action was read from the incident notes, as the gap between the page and the first command or change that the responder recorded. Notes were written by the responders themselves, so the figures are approximate.
:::

:::takeaways{title="What the team would repeat"}
- Start from the questions a responder asks, not from the metrics that exist.
- Move detail out of the way instead of deleting it.
- Say how small the sample is.
:::
