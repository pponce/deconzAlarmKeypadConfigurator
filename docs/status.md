# Standalone Node port status

Current development version: `0.1.0-dev.2`.

Implemented: independent HTTPS process, interactive local account/gateway/network setup, private config and process ownership, gateway identity verification, existing web account roles, users/PINs/access/schedules, alarm and lockout administration, history, durable writes/recovery, direct virtual keypad, and optional local Homebridge child-bridge PIN workflow. The latest combined-plugin user/mobile/password UI is retained. No garage/bolt code or Homebridge plugin runtime is included.

The preserved Python branch and source repositories are unchanged. A programmatic extension seam is available; no controller add-on or dynamic plugin system ships.

## Admin fixes ported through combined-plugin 0.4.35

Ported the applicable 0.4.26–0.4.35 changes from source commit `370f6236a304572e862ec67137448c80d6f72a7e`: user/PIN guidance, Homebridge prerequisite diagnostics, JSON service-control requests, interrupted-update cancellation before any PIN write, accurate saved-operation tracking, recovery failure attribution, completion ordering and read-only device-API startup checks. The source manifest records exact provenance and adaptations. Controller changes and deployment scripts were excluded.

Local Node 24: **143 tests passed**, including separate standalone/Homebridge storage, no-write cancellation, recovery without replay, bounded inventory readiness and diagnostic privacy. Local tests use the existing compiled official Temporal 0.5.1 source dependency; CI verifies published npm dependencies. Browser regression coverage now exercises checkbox placement/guidance, cancellation and a subsequent new update, stale completed-operation rejection, failed restart verification, and a blocked recovery without repeated login prompts. [CI run 37879338419](https://github.com/pponce/deconzAlarmKeypadConfigurator/actions/runs/37879338419) passed for commit `3563f36bb28a02c6944927cdb3b3769c85d44fdb`: normal npm dependency installation, all 143 tests on both Node 22 and Node 24, and Chromium desktop/WebKit mobile read and production save/recovery workflows. The branch also incorporates the current main README without discarding the new recovery guidance.

The owner confirmed the combined plugin's 0.4.35 Homebridge update flow worked. This is evidence for the source fix, **not standalone hardware acceptance**. This port has not been installed on a live host.

## Initial port validation

[GitHub Actions run 37826329754](https://github.com/pponce/deconzAlarmKeypadConfigurator/actions/runs/37826329754) passed for implementation commit `499f892badc4b69c62e9085ff079fe5d23600374`:

- Normal published npm dependency installation and **122 tests on both Node 22 and Node 24**.
- Chromium desktop and WebKit mobile read flows for administrator and regular accounts.
- Chromium/WebKit standalone startup, real HTTPS, user rename, PIN change, alarm save, lost-response recovery without replay, preferences, web accounts, activity history, confirmed Homebridge child-bridge PIN restart and regular-account protections. All gateways and host actions were synthetic fixtures.
- New integration tests specifically cover default operation without Homebridge, exact direct alarm request delivery, duplicate suppression across restart, private credentials, one process per data directory, connection-change holds/restart activation, role restrictions, identity verification, and separate optional Homebridge storage.

Local Node 24 tests also passed. Local npm/browser downloads were restricted; the CI checks above used normal published dependencies and actual browsers. Screenshots are attached to that workflow run.

No live deCONZ gateway, Homebridge child bridge, garage door or bolt was contacted or operated. No deployment, npm release or host-data migration was performed.

## Remaining release work

- A fresh-host installation and physical alarm acceptance remain owner testing tasks; synthetic CI does not establish hardware acceptance.
- Initial setup is terminal-based. There is no browser installer, automatic API-key enrollment, packaged service installer, automatic update mechanism or Python data importer yet.
- Homebridge PIN maintenance is local Linux only, with the existing reviewed homebridge-deconz 1.3.5/homebridge-lib 8.1.5 source checks, one child bridge, local HTTP UI and matching OS ownership. Broader versions/remote/HTTPS UI support need separate work.
- Uncertain credential writes remain held when reliable evidence is unavailable. Policy backups do not contain gateway PINs. There is no unsafe bypass or automatic retry.
- Future controller support is an extension seam, not a functioning add-on. Shared code is extracted source rather than a published common package.
