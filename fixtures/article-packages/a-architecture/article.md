---
title: How Relay keeps a job queue honest under load
slug: blocks-demo-architecture
language: en
excerpt: A tour of the request path of Relay, a fictional job queue, with its diagram, its retry code, the trade-offs behind the queue and one operational warning.
category: Engineering
tags: architecture, queues, reliability
---

Relay is a made-up job queue, used here to show how a long technical article can be composed from blocks. It accepts work over HTTP, stores it durably and hands it to workers. This article walks through the request path and explains why each stage exists.

## The request path

A job travels through five stages before it runs. The figure shows them in order, and the diagram below it shows the same path as a sequence, so you can see where time is spent.

::figure{src="assets/architecture-overview.png" alt="Boxes from left to right: client, edge, API and queue. Below the queue, workers lead to the store and the store to a cache." caption="The request path, from the client to the read model." variant="wide"}

The edge terminates TLS and applies per-client limits. The API validates the payload and writes one record to the durable queue before it answers. Only then does a worker see the job.

:::diagram{type="mermaid" title="One job, end to end" caption="The client gets its answer before any worker starts." alt="A sequence of five messages between client, API, queue, worker and store."}
sequenceDiagram
  participant C as Client
  participant A as API
  participant Q as Queue
  participant W as Worker
  participant S as Store
  C->>A: POST /jobs
  A->>Q: append(job)
  A-->>C: 202 Accepted
  Q->>W: deliver(job)
  W->>S: write(result)
  W-->>Q: ack
:::

### Why the answer comes early

The API answers with `202 Accepted` as soon as the job is in the log. That keeps the latency of a submission independent of how long the job takes, and it makes the queue the single place where a job can be lost, which is the place we protect the most.

## Retrying without duplicates

Delivery is at least once, so a worker may see the same job twice. The fix is to make the handler idempotent: the job carries a key, and the handler records the key together with the result in one transaction.

::::code-tabs{title="An idempotent handler"}
```ts title="handler.ts"
export async function handle(job: Job, db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const seen = await tx.exists('results', { key: job.key })
    if (seen) return
    const output = await run(job)
    await tx.insert('results', { key: job.key, output })
  })
}
```

```python title="handler.py"
def handle(job, db):
    with db.transaction() as tx:
        if tx.exists("results", key=job.key):
            return
        output = run(job)
        tx.insert("results", key=job.key, output=output)
```

```sql title="schema.sql"
CREATE TABLE results (
  key text PRIMARY KEY,
  output jsonb NOT NULL
);
```
::::

The primary key is what makes this safe: if two workers race, one insert fails and its transaction rolls back, so the result is stored once.

## Choosing the queue

We compared three ways to hold the jobs. The numbers are illustrative; the shape of the trade-off is what matters.

:::comparison{title="Queue storage options" caption="Higher is better for throughput and durability, lower is better for operations."}
| Option | Throughput | Durability | Operations |
|---|---|---|---|
| Table in the main database | Medium | Strong | Lowest |
| Dedicated log service | High | Strong | Medium |
| In-memory broker | Highest | Weak without replicas | High |
:::

Relay uses the dedicated log. The table is simpler but competes with the queries of the application, and the in-memory broker needs replicas before it is safe enough.

:::callout{type="warning" title="Do not purge the queue to fix a backlog" variant="prominent"}
Purging the log deletes accepted jobs that clients were told are safe. Scale the workers or pause the producers instead, and replay from the last acknowledged position if you must recover.
:::

## Running it

### Capacity

Size the workers for the p95 job duration, not the average. A queue that keeps up on average still builds a backlog when a slow batch arrives.

:::details{title="How the backlog alarm is computed" variant="appendix"}
The alarm compares the age of the oldest unacknowledged job with a threshold of five times the p95 duration. Age is a better signal than depth, because a deep queue of fast jobs is healthy and a shallow queue of stuck jobs is not.
:::

:::takeaways{title="What to remember"}
- Answer the client once the job is durable, not when it has run.
- Assume every job is delivered more than once and make the handler idempotent.
- Pick the queue by the failure you can afford, not by the benchmark.
- Alarm on the age of the oldest job.
:::
