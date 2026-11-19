---
title: Answering questions
summary: Find sections, cite them, and keep document text from acting as instructions.
category: Agents
order: 4
---
`lookupForAgent` from `@mainsoft/agent-cms/agent` is the helper behind the `read_for_answer` tool. Use it when your assistant answers a user from the CMS.

```ts
import { lookupForAgent, verifyCitations } from "@mainsoft/agent-cms/agent";

const found = await lookupForAgent(cms, actor, ["docs"], question, { budget: 3000, countTokens });
```

## What you get

- matching sections, each with a citation id (`cms://docs/install#create-the-tables`) and its URL
- `[[link:key|label]]` links resolved
- whether a person or an agent wrote each section
- `context`: the sections wrapped in `<cms-document>` tags that tell the model the text is reference, not instructions

With `budget` and your tokenizer (`countTokens`) it packs sections to fit.

## Check the answer

`verifyCitations(citations, lookup)` checks that an answer's citation ids exist and its quotes appear in them.
