---
inclusion: manual
---

---
description: Commit and push a project repo's local work to its feature branch. No review, no PR.
argument-hint: [project-name]
allowed-tools: Bash(git:*)
---

Resolve the target repo under `projects/`, refuse to commit on `main`, surface the range ahead of
`origin/main`, and push after confirmation. Never `git add -A`, never `--amend`.
