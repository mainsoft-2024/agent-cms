---
title: Security
summary: API keys, scopes, expiry and the audit log.
category: Reference
order: 3
---
## API keys

Keys look like `sgk_…` and are stored as sha256 only; the secret is shown once when you create it. Each key has scopes and optionally a list of collections:

- `read`: read documents and search
- `write`: create and edit (not publish)
- `publish`: publish, unpublish, archive, delete
- `admin`: everything, including keys

A key can have an expiry date; expired keys answer `key_expired`. A key cannot create a key wider than itself (`key_too_wide`).

## Audit log

Key changes, publishing, deletes and refused requests go to `cms_audit`: who, through which channel (REST, MCP, tools, CLI), what and the result. The **Audit log** screen filters it.

## Agent text

`read_for_answer` wraps sections in `<cms-document>` tags that tell the model the text is reference, not instructions. See [Answering questions](/docs/answering).
