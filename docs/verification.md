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
4. Run doctor and confirm the expected identity and `liveConnected: true`.
5. Send a small directed request and verify its actual Workspace response, not
   just the socket or journal. Repeat with a second notification in the same thread.
6. Exercise restart/unread recovery, then verify there is just one watcher and
   unchanged model/auth configuration. Confirm unrelated unread work was not claimed.
7. Remove the cutoff only when intentional backlog processing is desired.

Live acceptance results are recorded after testing; no private bot IDs, tokens or
Workspace content should be committed to this repository.
