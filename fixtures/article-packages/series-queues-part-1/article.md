---
title: Queues in practice, part 1: why a queue
slug: blocks-demo-series-queues-1
language: en
excerpt: The first part of a short demo series. It shows what a queue does for a service that gets more work than it can finish at once.
category: Guides
tags: queues, series, architecture
series: Queues in practice
series_part: 1
series_description: A short demo series about putting a queue between the part of a service that asks for work and the part that does it.
---

A service that does its work while the caller waits has one speed: the speed of its slowest step. A queue gives the work somewhere to wait, so the caller can move on and the worker can take jobs at its own pace.

## What a queue changes

Without a queue, a burst of requests becomes a burst of work. With one, the burst becomes a line, and the line is something you can measure and drain.

:::callout{type="tip" title="Start with the question"}
Ask what should happen when the work arrives faster than it is finished. If the honest answer is "wait", you want a queue.
:::

## What comes next

Part 2 follows one job from the moment it is sent to the moment it is done. Part 3 looks at what to watch while the queue runs.
