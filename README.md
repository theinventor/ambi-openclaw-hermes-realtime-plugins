# Ambiguous Realtime Plugins for OpenClaw and Hermes

Native, supervised Workspace event delivery using the official Ambiguous CLI.
Consumes directed notifications for mentions, DMs, task assignments, document
shares, thread replies and email without spending a model turn polling an empty
inbox. Ambiguous must create the notification first; this plugin does not own
upstream mail routing. See the [live verification caveats](docs/verification.md).

Adapted from the [MonsterMailbox plugins](https://github.com/theinventor/monstermailbox-cli/tree/main/cmd/embedded/plugins),
including the merged OpenClaw 2 PR #53. See [UPSTREAM.md](UPSTREAM.md).

## Install

Requirements: Node 22+, npm, a supported OpenClaw or Hermes installation, and an
existing Ambiguous CLI credential in a dotfile. No new account or model key is
needed. Credentials stay in their original file; only its path is configured.

```sh
git clone https://github.com/theinventor/ambi-openclaw-hermes-realtime-plugins.git
cd ambi-openclaw-hermes-realtime-plugins
npm ci --ignore-scripts

# Choose one runtime. Run as the user who owns that runtime.
node bin/ambi-plugins.mjs install hermes --config /absolute/path/.ambi/config.json
node bin/ambi-plugins.mjs install openclaw --config /absolute/path/.ambi/config.json
```

Use `--home /absolute/runtime/home` for a custom profile or container. The installer
copies an independent package, installs its pinned dependencies, backs up existing
configuration, and enables only this plugin and its toolset. It does not restart
the gateway, change model settings, modify the saved credential, or disable other
plugins. Restart that runtime through its normal service/container supervisor.
If OpenClaw is not globally installed, pass `--openclaw-package /path/to/openclaw`.
Inside a container, use `docker exec --user UID:GID` with the runtime home owner's
IDs. Installing as root into another user's home is rejected. OpenClaw 2026.9.4
itself requires Node >=24.16.0 <25 or >=26.1.0; Node 22+ is sufficient for Hermes's
bridge. See the tested host versions in [verification.md](docs/verification.md).

The default replays all unread notifications. For a scoped trial, add
`--not-before 2026-09-14T21:00:00Z` with the actual trial start time; older events
remain unread and untouched. Remove `notBefore` from settings to include them.
Check existing Ambiguous polling jobs/listeners before enabling the plugin; keep
one consumer per identity. The installer never removes unrelated jobs for you.

```sh
node bin/ambi-plugins.mjs doctor --settings /path/to/plugin/settings.local.json
```

Doctor checks identity, unread access and the server's live-connection status.
The status field is deliberately named `serverReportedLiveConnected`: the live
API has reported false during a working socket session, so also inspect the
plugin's transport logs and verify an actual response.
Verify two successive requests and their actual Workspace results before treating
an installation as end-to-end verified. A live socket alone is not enough.

## How it works

- The pinned `ambiguous notifications watch` process owns the authenticated live
  WebSocket and streams directed events as JSON lines.
- A separate `notifications poll` loop runs every 15 seconds and follows every
  unread page. It continues even if the socket is silent or wedged.
- The direct Node child is restarted every 90 seconds, with bounded requests,
  backoff, termination escalation and child reaping. No `npx` process tree.
- A private on-disk journal records pending notifications before native handoff.
  Failed handoffs retry; accepted handoffs have a bounded receipt lease. Duplicate
  watch/poll events share notification IDs. Restart restores pending work.
- OpenClaw registers a gateway service and calls `runtime.subagent.run` with
  `deliver: false`. Sessions are grouped by thread/resource by default; choose
  `--session-mode event` for separate event sessions or `shared` for one session.
- Hermes registers a native platform with its terminal toolset. A supervised
  bridge feeds MessageEvents and waits for handoff acknowledgements. `send()` and
  internal gateway events cannot automatically post messages.
- The bundled skill owns claiming, actual work, and intentional replies.

## Settings and delivery limits

`settings.local.json` contains absolute paths, expected user/workspace IDs,
`eventTypes` and `allowedActors` filters, optional `notBefore`, concurrency and
timeouts. It contains no tokens. Explicit file credentials override inherited
`AMBI_API_TOKEN` / `AMBI_API_URL` only in the short-lived CLI child environment.
Identity checks stop a changed credential from delivering another user's work.

`receiptLeaseMs` defaults to 15 minutes. An unread item still present after that
lease can be handed off again; the skill's atomic `was_unread` check prevents
duplicate action by competing workers. Handoff is not completion. Ambiguous's
read flag is not MMB's claim/done/block workflow: a crash after marking read can
lose automatic replay. Use native runtime recovery and operation idempotency;
this project does not promise exactly-once effects or cross-host work isolation.

The journal lock prevents two plugin processes sharing one state file. It does
not coordinate different machines; do not install several consumers for one
identity unless you also design shared execution/recovery ownership.

## Tests

```sh
npm test
npm run test:hermes
npm run check
```

Compatibility scripts exercise real host registration without an account or model
request. Live verification is documented in `docs/verification.md`; fixtures and
CI never contain real credentials or Workspace messages.
