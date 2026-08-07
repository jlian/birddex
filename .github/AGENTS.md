# Agent Instructions

Operational context for AI coding agents. Read the [README](../README.md) first for project setup, structure, and verification commands, and [CONTRIBUTING.md](../CONTRIBUTING.md) for commit and PR conventions.

## Use the Internet

Prefer up-to-date sources over training data. Search for error messages, check official docs, and look for recent GitHub discussions.

## Quick Reference

- **Stack:** React 19, Vite, Tailwind v4, Cloudflare Workers, D1, better-auth
- **Node:** >= 24
- **Quick check:** `npm run check` (lint + typecheck + tests)
- **Full check:** `npm run check:all` (adds e2e + build)
- **Dev server:** `npm run dev` (Vite on `:5000`, Wrangler on `:8787`)
- **Stop:** `npm stop`

## Commit History

- Write Conventional Commit subjects that describe the behavior or technical change. Never use process-oriented subjects such as "address review feedback", "fix review comments", or "review follow-up".
- Keep each commit focused on one logical change so the history produces useful semantic versions and changelog entries.
- Preserve a linear history. When safe, fold review fixups into their originating logical commit before the final push; use `--force-with-lease` for an already-published branch rewrite.
- Prefer rebase merge when the commits are clean and independently meaningful. Prefer squash merge when a PR is one logical change but its commit series is not useful history.

## iOS UI Verification

For any iOS implementation, review, or validation task, check the latest official Apple documentation and the interfaces in the installed Xcode SDK before deciding on APIs, availability, lifecycle behavior, entitlements, privacy keys, background execution, or App Store requirements. Treat repository patterns and model knowledge as secondary when they conflict with current Apple guidance. Record any simulator or device limitation that prevents verification.

For changes under `ios/WingDex/Views/` or shared iOS UI code, inspect the corresponding web implementation under `src/components/`, `src/styles/`, and `src/index.css` before editing. Preserve feature, state, copy, content order, and palette parity with the web source of truth while using native SwiftUI and Apple HIG conventions rather than pixel-for-pixel cloning.

Before styling a new iOS control, find an existing control with the same function and reuse its component, modifier, symbol, label structure, font, spacing, and interaction pattern. Prefer styling in this order:

1. An existing WingDex component or established nearby pattern.
2. Standard SwiftUI controls, styles, semantic fonts and colors, button roles, materials, and system spacing.
3. New custom styling only when the product design requires behavior or appearance the first two options cannot provide.

Do not hand-style native controls by default. Avoid fixed font sizes, explicit foreground colors, custom padding, custom shapes, or separate icon/text styling when a standard control, `Label`, semantic role, tint, or existing modifier already provides the intended result. When custom styling is necessary, keep it minimal, Dynamic Type-safe, and consistent across every control with the same function.

Before finishing, build the active iOS scheme with Xcode MCP, render every affected `#Preview`, and validate the installed app with iOS Simulator MCP. Exercise the changed flow with `--auto-sign-in --auto-demo-data` when authenticated data is needed, and check light and dark appearance, navigation, scrolling, sheets, Dynamic Type, and visible overlap. Report any simulator or local-server validation that could not be performed.


## Observability (Structured Logging)

Full schema and reference in **[docs/OBSERVABILITY.md](../docs/OBSERVABILITY.md)**.

Critical rules:

1. Use the request-scoped logger from `context.data.log` - never `console.log`/`console.error`.
2. Log every error path at `warn` (4xx) or `error` (5xx) with `resultType: 'Failed'`, `resultSignature`, and a `resultDescription` naming the resource, cause, and mitigation.
3. `level` hierarchy: Trace, Debug, Info, Warning, Error, Critical. Controlled by `LOG_LEVEL` env var.
4. `operationName` is camelCase: `resourceType/subType/verb` (e.g., `data/observations/write`).
5. `category` is one of `Audit`, `Application`, or `Request`.
6. Propagate `traceparent` on outbound calls.
