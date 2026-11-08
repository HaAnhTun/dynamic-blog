---
title: Queues in practice, part 3: watching the line
slug: blocks-demo-series-queues-3
language: en
excerpt: The last part of a short demo series. It lists the few numbers worth watching while a queue runs and what each of them tells you.
category: Guides
tags: queues, series, monitoring
series: Queues in practice
series_part: 3
series_description: A short demo series about putting a queue between the part of a service that asks for work and the part that does it.
---

A queue that nobody watches fails quietly. The line grows, jobs get old, and the first sign is a user asking where their result is. Three numbers are enough to see trouble early.

## The three numbers

:::callout{type="note" title="What to watch"}
How many jobs are waiting, how long the oldest one has waited, and how many jobs failed in the last hour.
:::

:::details{title="What if the line only grows at night?"}
That is usually a batch of work that arrives on a schedule. Check that the workers keep up by morning, and add workers only if they do not.
:::

:::callout{type="warning" title="Do not hide the failures"}
A failure count that is reset every day hides a job that fails every day. Keep the history.
:::

## Wrapping up

A queue is a small piece of design with a large effect: it turns a burst into a line, and a line can be watched. That is the whole series.
