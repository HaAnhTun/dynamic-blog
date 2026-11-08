---
title: Postmortem of a stalled queue
slug: blocks-demo-postmortem
language: en
excerpt: A made-up incident review that shows key figures, a timeline, a file tree, tabs, an accordion and two kinds of highlighted code in one article.
category: Operations
tags: postmortem, operations, reliability
---

Relay is a made-up job queue, so nothing here describes a real product or a real outage. This page is a postmortem written the way a team would write one: the figures first, then the order of events, the place of the fix, the steps to apply it and the questions people asked afterwards.

## The impact in numbers

:::metrics{title="After the fix" caption="Measured on one test cluster over one hour."}
::metric{label="p95 latency" value="38 ms" trend="down" note="was 410 ms"}
::metric{label="Throughput" value="1,200 jobs/s" trend="up" note="was 300 jobs/s"}
::metric{label="Workers" value="12" trend="flat" note="the same pool size"}
:::

## What happened

:::::timeline{title="The afternoon, in order"}
:::event{title="First alert" when="09:02"}
The depth alarm fired and the on-call engineer was paged.
:::
:::event{title="Retries pile up" when="09:40"}
Every failed job was retried at once, so the queue grew faster than the workers could drain it.
:::
::::event{title="Pool paused" when="10:15"}
The team paused the pool to stop the growth and kept the waiting jobs.

:::callout{type="warning" title="Do not purge the queue"}
A purge deletes every waiting job and cannot be undone. Pause first, then decide.
:::
::::
:::event{title="Fix released" when="11:30"}
A lower retry limit with a longer backoff went out, and the queue drained within the hour.
:::
:::::

## Where the fix lives

:::file-tree{title="Files that changed"}
- relay/
  - worker/
    - pool.py
    - retry.py
  - config/
    - limits.yaml
- deploy.yaml
:::

The retry limit sits in `deploy.yaml`. The change is small, and the diff below shows it.

```diff title="deploy.yaml"
 limits:
-  retries: 50
+  retries: 5
-  backoff: 1s
+  backoff: 8s
   timeout: 30s
```

## Apply the fix

::::::tabs{title="Pick your system"}
:::::tab{title="macOS"}
Open a terminal and run the pause command, then release the fix.

```bash
relayctl pause --queue default
relayctl release --version 2.4.1
```
:::::
:::::tab{title="Linux"}
Use the service manager to pause the pool, then release the fix.

```bash
sudo systemctl stop relay-worker
relayctl release --version 2.4.1
```
:::::
:::::tab{title="Windows"}
::::steps{title="Two steps"}
:::step{title="Pause the pool"}
Open the shell that has the Relay tools on its path and pause the default queue.
:::
:::step{title="Release the fix"}
Release version 2.4.1 and watch the depth fall.
:::
::::
:::::
::::::

The limits file below is the one the workers read. Lines 2 and 5 to 7 are the ones to check before a release.

```yaml title="limits.yaml" highlight="2,5-7"
limits:
  retries: 5
  timeout: 30s
queue:
  name: default
  depth_alarm: 5000
  drain_rate: 100
```

## Questions people asked

:::details{title="Why did the retries not help?" group="questions"}
A retry is useful when a failure is rare. Here the failure was shared by every job, so each retry only added load.
:::

:::details{title="Could this happen again?" group="questions"}
It could, which is why the alarm now fires on the growth of the queue and not only on its size.
:::
