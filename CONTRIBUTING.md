# Contributing to WingDex

See the [README](README.md) for setup, project structure, and verification commands. This file is about getting a change merged.

## Pull Requests

1. Fork and branch from `main`
2. Make the change, and add or update tests
3. Run `npm run check` (lint + typecheck + unit). Run `npm run check:all` when the change touches `functions/`, `e2e/`, routing, auth, or data flow
4. Open a PR against `main`

Keep a PR to one logical change. Release Please reads PR titles, so a mixed-bag PR produces a misleading changelog entry.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) with a scope, for both commit subjects and PR titles:

```
type(scope): description
```

- **Types:** `feat`, `fix`, `docs`, `chore`, `perf`, `refactor`, `test`, `ci`, `build`, `revert`
- **Scope:** the area changed, e.g. `feat(Outings):`, `fix(Auth):`, `docs(README):`

Describe the behaviour or technical change, not the process. `fix(Auth): reject expired passkey challenges`, not `fix: address review feedback`.

## Code Style

- **TypeScript**: strict types, no `any` unless unavoidable
- **React**: functional components with hooks
- **Formatting**: single quotes, 2-space indent, match the surrounding file
- **Punctuation**: ASCII only in code comments and commit messages, no em-dashes or en-dashes

## Reporting Issues

Use [GitHub Issues](https://github.com/jlian/wingdex/issues). For bugs, include steps to reproduce and what you expected instead. Screenshots welcome.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
