# Knorvia-owned Rust workspace

This directory is an independent Cargo workspace, not a member of the pinned
upstream `../codex-rs` workspace. Keep upstream source and dependency versions
untouched unless the work explicitly requires an upstream change.

## Build and verification

- Run this directory's `just check`, `just build`, `just test`, `just fmt`, and
  `just clippy`, scoped with `-p` to affected Knorvia crates where appropriate.
- This workspace currently uses Cargo's built-in test runner through `just
  test`; the upstream nextest and Bazel policies remain in force in codex-rs.
- Format only this workspace for Knorvia-only changes. Do not mass-format the
  upstream checkout or rewrite unrelated dirty user files.
- Do not mark integration tests passed when binaries or fixture environments
  are missing. Report skips and ignored tests separately.
- Use temporary, isolated Knorvia Homes and local scripted providers in tests;
  never use the user's real data or paid provider credentials.

## Lifecycle invariants

- Long model calls run outside the control-plane request reader.
- The shared App Server has one transport reader, ID-correlated requests, and
  per-Thread subscriptions. A model or approval callback cannot own that reader.
- User input has one product Item. Kernel echoes are not a second user input.
- Approvals belong to a specific Turn, and approval consent is not evidence of
  tool execution. Missing owner or failed audit writes fail closed.
- Only durable state can produce a terminal notification. Cancellation receipt
  does not overwrite a Kernel-completed task with a fabricated cancellation.
- Production control planes must hold the OS Home lock before recovery or
  mutation. Test seams must not automatically recover another owner's work.
- Unsupported steer/fork/user-input delivery must return a typed capability
  error, not a successful journal-only placeholder.

The product-side migration ledger in `../docs/migration` tracks partial work;
passing a slice does not authorize declaring the entire workbench or release done.
