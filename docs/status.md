# Standalone Node port status

First runnable development port, version `0.1.0-dev.1`.

Implemented: independent HTTPS process, interactive local account/gateway/network setup, private config and process ownership, gateway identity verification, existing web account roles, users/PINs/access/schedules, alarm and lockout administration, history, durable writes/recovery, direct virtual keypad, and optional local Homebridge child-bridge PIN workflow. The latest combined-plugin user/mobile/password UI is retained. No garage/bolt code or Homebridge plugin runtime is included.

The preserved Python branch and source repositories are unchanged. A programmatic extension seam is available; no controller add-on or dynamic plugin system ships.

## Validation

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
