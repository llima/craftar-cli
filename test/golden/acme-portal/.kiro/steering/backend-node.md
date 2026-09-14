---
inclusion: fileMatch
fileMatchPattern: "projects/acme-api/**"
---

<!-- GENERATED from .claude/rules/backend-node.md by craftar -- do not edit. -->

# Backend (Node) — Rules and Conventions

These rules apply to `projects/acme-api`, a Node + TypeScript HTTP service.

- **Validate every request body** with a schema before it reaches a handler.
- **Handlers stay thin** — they parse, delegate to a service, and map the result to HTTP.
- **No secrets in logs.** A credential in a log line is a blocker.
