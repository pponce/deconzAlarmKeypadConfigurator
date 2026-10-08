# Development status

## Coordinator 0.4.13 shared device connections

The coordinator adds an optional connections catalog alongside the existing fully resolved controller profiles. The client accepts validated catalog entries and preserves them through settings/review/apply, while remaining compatible with older coordinators that omit the field. Unknown fields, raw secrets, credential-bearing URLs, invalid door counts and duplicate IDs are rejected. The existing standalone Controller editor keeps the catalog when editing profiles; named shared-connection management lives in the Homebridge plugin settings under General. The API contract copies are byte-identical, and all 16 actual Node/Python cross-repository tests pass, including catalog round-trip preservation. Update this administrator before editing 0.4.13+ coordinator settings here if it is already installed. Its URL, login, user roles, deCONZ administration and movement routing remain unchanged.

## Coordinator 0.4.11 contract

The coordinator's 0.4.11 UI work adds optional POST /v1/controllers/{id}/disable with revision/boot identity checks and durable, idle-only, non-actuating disablement. Its reviewed name-only edits preserve already-valid enablement. The copied API contract is synchronized; this administrator's runtime does not invoke the new endpoint and needs no installation update for these UI changes. All 16 cross-repository checks pass locally. The coordinator implementation passed all five jobs in CI run 37665272198 at 365e01c642a6ce3252d7272c40dbb7d9422926a1. These contract-only notes accompany that release; the administrator runtime is unchanged and needs no installation update for the coordinator UI.

## Optional coordinator reporting experiments (0.4.9)

The authoritative API copy includes independent event recording/subscriber inspection modes and optional deferred garage publication. These process-local experiments default and restore to full diagnostics/inline reporting during the unresolved Home display investigation. The owner is proceeding from 0.4.6 failures and 0.4.7 successes; no new ON/OFF/ON result is assumed. Administrator code and installation remain unchanged and do not depend on the optional endpoint. All 16 cross-repository checks pass, including byte-identical API contracts and existing managed operations.

2026-10-06: ready for initial supervised owner installation/testing with the coordinator. Physical and owner-host acceptance remain outstanding. Follow [owner-test.md](owner-test.md); install/configure the coordinator first and leave its garage disabled until the old movement/input services are stopped.

## Validated source

- Administrator: `c43a269646fd79b919cf5c99b0871efbfbe6550e`, package `0.5.0.dev1`. [Passing release checks](https://github.com/pponce/homebridge-deconzKeypadAlarm-admin/actions/runs/37527386237).
- Coordinator: `295f995f8484095b9534054e0fc7f124467ef7f9`, package `0.4.0-dev.1`. [Passing release checks](https://github.com/pponce/homebridge-gDoorAndBolt-coordinator/actions/runs/37528567117).
- Later documentation-only commits retain this tested implementation. Requirements: Python 3.10+, Node 22/24, Homebridge 2 for the coordinator and same-host loopback connectivity.

## Implemented and checked

The full generic administration application remains present: its own HTTPS URL, accounts/roles, virtual keypad, deCONZ pages, activity, preferences and maintenance. The native Controller page supports current status, coordinated commands, commissioning/recovery, profile review/apply/cancel and bounded activity. It shares the coordinator's guided profile editor; private device keys and discovery stay in Homebridge settings. Keypad outcomes and maintenance use the authenticated coordinator API. No second movement engine is added.

The installation preparer creates a separate application bundle, private configurations, copied accounts/preferences/history/backups and reviewable service units from a stopped existing installation. It excludes old private-controller registrations and does not install/start services. Pending old maintenance must be resolved before state transfer. A separately registered host maintenance helper is retained when configured.

Validation passed:

- 28 client, adapter and installation checks on Python 3.10 and 3.12.
- 162 retained application checks in Linux CI. Local validation passed 160 with two Unix-socket checks skipped by this workspace; CI covers those two.
- Existing account, settings, protection and desktop/mobile browser scenarios in Chromium/WebKit, plus the native Controller observation flow. The settings button now reflects the existing busy guard during background refreshes.
- 16 actual Node/Python cross-repository checks, including managed settings, commissioning, keypad delivery, movement, command deduplication and maintenance. The shared API documents and profile editor are identical between repositories.
- The coordinator separately passed 89 tests on Node 22/24, actual Homebridge child-bridge HAP movement, actual custom settings server IPC and desktop/mobile configuration browser checks.

No live state has been copied, no host service stopped/started, and no household physical acceptance performed. Owner acceptance must verify the preserved accounts/history on the real installation, configured scopes, physical routes/timings, maintenance and recovery. Keep the original installation for rollback and retire obsolete HTTP Webhooks tiles only after both HomeKit and physical tests pass.

## Optional coordinator reporting diagnostic (0.4.7)

The authoritative API copy now documents the optional, authenticated, read-only HomeKit reporting endpoint. Existing administrator behavior and required capabilities are unchanged; no administrator update is needed for the owner's diagnostic test. All 16 cross-repository checks pass with the 0.4.7 candidate, including byte-identical contracts and existing managed operations. The coordinator's Home display issue remains unresolved pending its paired-connection capture.


## Optional coordinator recording comparison contract

The API document includes coordinator 0.4.8's optional process-local HomeKit diagnostic recording switch and monotonic trace timestamps. Administrator code and installation are unchanged; it does not use this endpoint. This supports the coordinator's controlled live comparison after two successful owner-reported 0.4.7 display cycles. The cause remains unconfirmed. All 16 cross-repository checks pass.


Coordinator 0.4.19 compatibility: routing validation now accepts an opted-in physical keypad on a declared interruption-capable relay, while still rejecting primary routes. Legacy editor preserves the setting on render and describes the PIN policy. Devices/Controls layout changes are in the Homebridge coordinator UI, not this administrator. API contract synchronized. Run client and cross-repository tests before source publication.
