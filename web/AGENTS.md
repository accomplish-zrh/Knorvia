<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Confirmed application layout — 2026-09-12

The user explicitly reconfirmed this layout after an unwanted reversal. Preserve
it in both interface styles and in the packaged application:

- The Sessions / BOTS underline switch is the **first row at the top of the left
  sidebar**, above the Knorvia brand and New conversation. It is not a separate
  navigation item or a floating control below the brand.
- Use one **资料库 / Library** primary entry and page name. The former output
  collection belongs inside it; My files and From tasks are internal categories.
  Legacy artifact URLs must retain their query parameters and resolve to Library.
- Memory is immediately above Settings in one bottom group, with no intervening
  entry or extra gap.
- Keep Minimal as the existing default. Luminous is an independently saved,
  optional interface style, separate from palette, wallpaper and native glass.
  Changing style must not remount the composer or lose an active task or draft.

Verify `tests/workbench-style.audit.ts` against an isolated native gateway and
inspect the built desktop UI when changing this layout. A source-only change is
not evidence that an older installed or portable application has updated.
