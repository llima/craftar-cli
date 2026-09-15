# Workflow

Every non-trivial change in the acme workspace follows this loop:

1. **Brainstorm first.** Surface unknowns before they become commits.
2. **Plan in `docs/plans/<YYYY-MM-DD>-<slug>.md`.** Plans are temporary and deleted after execution.
3. **Commit per step** on a `feat/<slug>` branch — never on `main`.
4. **Verify on screen** before calling a front slice done: screenshot, console, and the assertion in words.
5. **Open the PR only when asked.** Review runs once, over the full ahead-of-default range.
