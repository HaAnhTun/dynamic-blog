---
title: Eventual consistency, explained without a database
slug: blocks-demo-concept
language: en
excerpt: A long-form explainer that uses a shared shopping list, two diagrams, a pull quote and a few callouts to show what eventual consistency means and when it is a good trade.
category: Concepts
tags: concepts, consistency, distributed-systems
---

Eventual consistency has a reputation for being hard to explain. It is less hard than it sounds, because you have already lived with it. This article explains the idea with a shared shopping list and no code at all.

## A list on two phones

Imagine a shopping list that you and a friend both keep on your phones. You add milk while you are in a lift with no signal. Your friend adds bread at the same moment, in the shop. Neither phone knows about the other change yet.

Nothing is broken here. Each phone accepted a change, saved it and showed it back to its owner. The phones will exchange what they know as soon as they can, and after that both lists hold both items. That is the whole idea: the copies may disagree for a while, and they agree once they have talked.

:::diagram{type="mermaid" title="Two phones, one list" caption="Each phone accepts a change on its own and shares it later." alt="Two phones each add an item, then exchange their changes and end with the same list."}
sequenceDiagram
  participant You
  participant Friend
  You->>You: add milk
  Friend->>Friend: add bread
  You->>Friend: share changes
  Friend->>You: share changes
  Note over You,Friend: Both lists now hold milk and bread
:::

### What you gain

The list always works. You never wait for your friend's phone to answer before you can write something down. A system that behaves like this keeps working when the network is slow or cut, which is exactly when you need it.

### What you give up

For a short time the two views can differ. If you ask both phones what is on the list during that time, you may get two answers. Whether that matters depends entirely on what the list is for.

:::callout{type="note" title="Eventually does not mean never"}
The word describes a guarantee: if nobody changes the list for long enough, every copy ends up the same. How long is long enough is a property of the system, and it is usually a fraction of a second.
:::

## When two changes collide

The easy case is two different items. The hard case is two changes to the same thing: you cross out milk while your friend changes it to oat milk. The phones must decide what the list says.

There are three common answers. The last writer wins and the other change is dropped. Both changes are kept and a person decides. Or the rules of the data make the changes combine on their own, as when two people each add an item to a set.

:::pullquote{attribution="A saying among engineers"}
Decide what to do about conflicts before you have any.
:::

:::diagram{type="mermaid" title="Three ways to settle a conflict" caption="Pick the one whose cost you can accept." alt="A decision from conflicting changes to three outcomes: the last writer wins, a person decides, or the data merges by itself."}
flowchart LR
  X[Two changes to one item] --> L[Last writer wins]
  X --> P[A person decides]
  X --> M[The data merges itself]
  L --> R1[Simple, may lose a change]
  P --> R2[Nothing lost, needs attention]
  M --> R3[Nothing lost, needs careful design]
:::

## Is it right for you?

Ask what a stale answer costs. A shopping list, a like counter or a list of recently viewed pages can be a little behind without harm. A bank balance or the last seat on a flight cannot, and those need the copies to agree before they answer.

:::callout{type="info" title="Most systems use both"}
A shop can let the catalogue be eventually consistent while it keeps the stock of a single popular item strictly consistent. The skill is in drawing the line, not in choosing one side for everything.
:::

:::takeaways{title="The idea in four lines"}
- Copies may disagree for a short while and agree once they have shared their changes.
- You trade a little freshness for availability.
- Conflicts need a rule that you chose on purpose.
- Use strict agreement only where a stale answer is expensive.
:::
