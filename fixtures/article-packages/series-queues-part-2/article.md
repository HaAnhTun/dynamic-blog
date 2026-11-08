---
title: Queues in practice, part 2: following one job
slug: blocks-demo-series-queues-2
language: en
excerpt: The second part of a short demo series. It follows a single job through a queue and names the places where it can go wrong.
category: Guides
tags: queues, series, jobs
series: Queues in practice
series_part: 2
series_description: A short demo series about putting a queue between the part of a service that asks for work and the part that does it.
---

A job in a queue has a short life: it is sent, it waits, a worker takes it, and it finishes or fails. Knowing each of these moments makes the rest of the series easier to follow.

## The life of a job

:::callout{type="info" title="Four moments"}
Sent, waiting, running, done. A failed job goes back to waiting, with a note of how many times it has tried.
:::

## When a job fails

Most failures are temporary, so the queue tries again after a pause. A job that keeps failing is not retried for ever: after a set number of tries it moves aside, where a person can look at it.

:::details{title="Why not retry at once?"}
A service that is struggling gets more work from its own retries. A pause between tries gives it room to recover.
:::
