# Transport and ownership

## API assessment

Ambiguous has the API surface needed for MMB-style directed triggers:

| Need | Existing surface |
| --- | --- |
| Validate saved identity | `GET /api/users/me` |
| Directed realtime events | Official `ambiguous notifications watch`, authenticated multiplexed WebSocket |
| Offline recovery | `notifications poll`, ascending unread cursor pagination |
| Competing-consumer claim | `POST /api/notifications/{id}/mark-read`, `was_unread` response |
| Connection check | `GET /api/agents/{id}/transport` |
| Event subscriptions | `GET/PUT /api/agents/{id}/subscriptions` |
| Read context and act | Current CLI catalog + Workspace REST API for messages, tasks, docs and mail |

No Ambiguous server changes are required for realtime reception. The official CLI
owns connection capabilities, socket authentication, hydration and event normalization.
We depend on its pinned npm package rather than copying its implementation. The
plugin never writes credentials or subscribes the agent to additional resources.

Sources inspected on 2026-09-14:
[operating guide](https://app.ambiguous.ai/skill),
[live OpenAPI](https://app.ambiguous.ai/api/openapi.json),
[API overview](https://www.ambiguous.ai/agents/api),
[official CLI](https://www.npmjs.com/package/ambiguous).

## Layers

```text
Ambiguous Workspace
  -> pinned CLI watch + independent unread poll
  -> private journal keyed by notification_id
  -> native OpenClaw run / Hermes MessageEvent
  -> bundled handling skill
  -> atomic read claim, context fetch, work, explicit reply
```

The plugin owns transport, supervision, routing and handoff retries. The skill
owns agent behavior, claiming and Workspace side effects. Model authentication
continues to belong to the host and is not configured by this package.

OpenClaw uses its supported service lifecycle and SDK entry, not a detached
interval returned from `register()`. Hermes uses its native platform registration
and current `gateway.platforms.event` imports. Its base handler acknowledges
admission immediately and runs the model in a background task. The bridge requires
that explicit admission flag before recording an accepted receipt.

Thread/resource sessions preserve related context. `sessionMode: event` isolates
each notification; `shared` restores a single mailbox-style session. These are
native host sessions, not additional machines. The configured `concurrency` bounds
handoff calls, **not** active model turns; use the host's own execution limits to
bound simultaneous model work. Neither host adapter automatically posts final
turn text, progress messages or internal completion events into Workspace.

## Reliability boundary

MMB's inbox claim/done/block workflow and Ambiguous's read flag are not equivalent.
Unread recovery can re-deliver an unclaimed notification, including after process
restart. A receipt expires after 15 minutes if the event is still unread. Two
workers must check `was_unread` immediately before acting. This reduces duplicate
effects but does not provide a transactional work queue:

- Marking read claims the event; it does not prove completion.
- A crash after that claim may require operator/native session recovery.
- Humans or another consumer can mark the same notification read.
- A successful native handoff cannot prove a successful Workspace reply.
- Replaying a timed-out side effect requires operation-level idempotency.

For guaranteed high-volume task processing, add a durable server-side work ledger
with claim leases and complete/blocked states. This package deliberately does not
invent those semantics on top of notification read/unread flags.

## Security and operations

Events are untrusted content. Only the configured identity's directed inbox is
consumed; optional actor/type filters narrow it further. Identity is verified on
startup, before each watch, on every unread poll and before each agent CLI call.
Credential values never appear in prompts, CLI arguments, settings or journal
logs. Pending event content is private runtime state (directory 0700, file 0600).

One listener owns a state-file lock. Stop competing cron/watch consumers before
enabling it. A local PID lock cannot coordinate different machines. The installer
keeps rollback copies outside plugin discovery paths and rejects installation by
someone other than the runtime home's owner.
