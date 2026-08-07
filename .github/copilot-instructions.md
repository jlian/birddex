# Coding Guidelines

Guidelines to reduce common LLM coding mistakes. Bias toward caution over speed; for trivial tasks, use judgment.

See the [README](../README.md) for project setup and structure, and [CONTRIBUTING.md](../CONTRIBUTING.md) for commit conventions and code style.

## Think Before Coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.

## Simplicity First
- No features, abstractions, or "flexibility" beyond what was asked.
- If you write 200 lines and it could be 50, rewrite it.

## Surgical Changes
- Don't "improve" adjacent code, comments, or formatting. Match existing style.
- Don't refactor things that aren't broken.
- Remove imports/variables/functions that YOUR changes made unused, but don't remove pre-existing dead code.
- Every changed line should trace directly to the user's request.

## Goal-Driven Execution
- Transform tasks into verifiable goals with concrete success criteria.
- For multi-step tasks, state a brief plan with verification checks.

## Commits
- Don't commit too optimistically. Always verify correctness first.
- Don't push without asking.
- Follow the commit convention in [CONTRIBUTING.md](../CONTRIBUTING.md#commits).

## Public Writing Voice
- When writing GitHub comments, issues, PR descriptions, or other public text under the user's identity, sound conversational, concise, and technically specific.
- Start from the concrete use case, ask the key question plainly, and offer suggestions as possibilities rather than demands. Leave room for maintainers to choose scope or a different approach.
- Prefer natural wording such as "Would it make sense to..." and "Not sure if this fits here or as a follow-up" when that reflects the intent.
- Avoid canned review language, inflated praise, excessive headings, exhaustive lists, and overly polished corporate phrasing.

## Text Encoding
- Use commas, colons, semicolons, or hyphens (`-`) instead of em-dashes or en-dashes.
- Stick to ASCII punctuation in commit messages, PR descriptions, issue comments, and code comments.
