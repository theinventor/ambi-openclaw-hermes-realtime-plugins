# Verification

## Pinned compatibility targets

| Component | Tested version |
| --- | --- |
| Ambiguous CLI | 0.9.1 |
| OpenClaw | 2026.9.4, Node 24.16.0 |
| Hermes | `1c671beab29164d8931c5d01c5739502267089d8`, Python 3.13 |
| Plugin | 0.1.0 |

The JavaScript regression suite and isolated Python adapter suite run without
credentials. Tests cover inherited-auth override, wrong-identity rejection, Unicode
stream boundaries, malformed output, timeout escalation and child reaping,
deduplication, persisted retries, queue limits, pagination, receipt leases, shutdown,
session routing, native handoff failures, internal-event filtering, no-auto-send,
installer backups and preservation of unrelated settings.

CI repeats these on Linux/macOS and Node 22/24/26. Windows is not a verified target.
The host compatibility jobs use the pinned actual upstream packages. They do not
spend model tokens or access a real Workspace. A passing SDK import is not a live
OpenClaw model-turn test; the real Hermes handoff test also uses a fixture handler.

## Reproduce host checks

```sh
OPENCLAW_PACKAGE=/absolute/path/to/openclaw npm run test:compat:openclaw
HERMES_SOURCE=/absolute/path/to/hermes-agent /path/to/hermes/.venv/bin/python scripts/compat-hermes.py
/path/to/hermes/.venv/bin/python -m hermes_cli.main plugins doctor "$PWD" --ci
```

Hermes's plugin doctor uses real discovery, manifest parsing, import and
registration with isolated state and blocked Python network calls. The adapter
does not connect to Ambiguous during registration.

## Live acceptance procedure

1. Record the existing saved identity and back up native settings. Do not publish
   the credential, raw notification payloads or private configuration.
2. Check for other listeners/cron jobs for that identity. Pause the old consumer
   during the test, keeping its exact job ID available for rollback.
3. Install as the runtime home owner; use a recent `--not-before` cutoff so testing
   does not process old unread work. Restart only the selected runtime.
4. Run doctor and confirm the expected identity. Compare
   `serverReportedLiveConnected` with transport logs and actual event delivery.
5. Send a small directed request and verify its actual Workspace response, not
   just the socket or journal. Repeat with a second notification in the same thread.
6. Exercise restart/unread recovery, then verify there is just one watcher and
   unchanged model/auth configuration. Confirm unrelated unread work was not claimed.
7. Remove the cutoff only when intentional backlog processing is desired.

## Live results, 2026-09-14

Joe's existing Hermes installation was used with its saved Ambiguous credential
and unchanged OpenAI Codex subscription provider. Only the target bot's container
was restarted. Its previous five-minute Ambiguous cron consumer was paused, not
deleted. A cutoff preserved the three pre-existing unread notifications.

- Native discovery, registration, platform toolset, installed skill and runtime
  MessageEvent handling passed.
- A real Workspace reminder produced an exact `AMBI-REALTIME-ONE` channel reply.
- A second reminder arrived through `notifications watch`, was acknowledged by
  Hermes, and produced `AMBI-REALTIME-TWO` in the requested thread. Both responses
  were verified through the Workspace API, not inferred from final agent text.
- A third reminder was confirmed unread while the bot container was stopped.
  After startup, the independent poll recovered it before the socket connected;
  Joe posted `AMBI-REALTIME-RECOVERED` in the correct thread. The original three
  unrelated notifications remained unread, and neither earlier reply was repeated.
- A before/after settings comparison showed changes only in `plugins`,
  `platform_toolsets` and `display`. The saved Ambiguous credential file retained
  its pre-rollout modification time and 0600 mode. Model configuration was equal.
- The local suite contains 18 JavaScript and 4 Python tests. CI adds actual
  OpenClaw SDK and Hermes loader/handoff checks across pinned versions.

Two upstream/account caveats remain distinct from plugin handoff:

1. `GET /api/agents/{id}/transport` reported `connected: false` even while the
   official CLI logged an open socket and delivered a real notification. Treat
   that endpoint as a server-reported diagnostic, not authoritative acceptance.
2. An external email to the test agent's generated Workspace address was accepted
   by the destination SMTP server but did not appear in the agent's Ambiguous mail
   inbox or directed notifications. Its email-address list was empty. This does
   not establish the underlying cause, and email arrival is **not live-verified**
   for that account. The plugin cannot dispatch a notification the server never
   creates. No address provisioning or credential changes were attempted.

No live model-turn test was run on an OpenClaw installation. Its actual SDK entry,
installed metadata, registration and supervised-service contract were tested,
with delivery behavior covered by the regression suite.
