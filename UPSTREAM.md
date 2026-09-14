# Upstream provenance

This project adapts the MonsterMailbox OpenClaw and Hermes plugins from
https://github.com/theinventor/monstermailbox-cli/tree/main/cmd/embedded/plugins.

Baseline: `bb507a35bc1167f9bbad1e1f94ac08c41e7469c6` (2026-09-14).
PR #53, initially pending, merged during this work. This baseline incorporates
its final head `a548972d3ed1f943e8876981a9fbb06939ba5e14` and these earlier fixes:

- OpenClaw 2 package metadata, strict manifest, and service lifecycle.
- Absolute executable and saved-identity selection for supervised processes.
- Retry after failed dispatch instead of permanently poisoning deduplication.
- Bounded watcher lifetime and an independent reconciliation loop.
- Hermes native platform registration, explicit toolsets, and quiet delivery.
- Thin triggers: the agent's skill owns actions and replies; no automatic reply.
- Installer checks for plugin directories that shadow the intended installation.

The new adapters retain those behaviors with Ambiguous's official CLI transport:
`notifications watch` and `notifications poll`. They do not copy Ambiguous's
proprietary CLI implementation; `ambiguous` is a pinned npm dependency.

The MIT license and original copyright are retained. The upstream MMB working
checkout and its branches are not modified by this project.
