# Standalone Node port status

First runnable development port, version `0.1.0-dev.1`.

Implemented: independent HTTPS process, interactive local account/gateway/network setup, private config and process ownership, gateway identity verification, existing web account roles, users/PINs/access/schedules, alarm and lockout administration, history, durable writes/recovery, direct virtual keypad, and optional local Homebridge child-bridge PIN workflow. The latest combined-plugin user/mobile/password UI is retained. No garage/bolt code or Homebridge plugin runtime is included.

The preserved Python branch and source repositories are unchanged. A programmatic extension seam is available; no controller add-on or dynamic plugin system ships.

## Validation

- 122 local Node 24 tests passed, including the inherited admin contracts and new real-HTTPS standalone tests.
- New tests cover default operation without Homebridge, exact direct alarm request delivery, duplicate suppression across restart, private credentials, one process per data directory, connection-change holds/restart activation, role restrictions, identity verification, and separate optional Homebridge storage.
- The local npm registry and browser binary downloads returned network-policy 403 responses. Runtime tests used the official Temporal v0.5.1 and JSBI v4.3.0 tagged source, compiled locally with Node's TypeScript transform, outside the repository. No dependency source or workaround was vendored into the application.
- GitHub Actions is configured to install the published dependencies normally and check Node 22/24 plus Chromium desktop and WebKit mobile. Results are recorded in the development PR.

No live deCONZ gateway, Homebridge child bridge, garage door or bolt was contacted or operated. No deployment, npm release or host-data migration was performed.

## Remaining release work

- Browser acceptance and normal npm dependency installation must pass CI; a fresh-host installation and physical alarm acceptance remain owner testing tasks.
- Initial setup is terminal-based. There is no browser installer, automatic API-key enrollment, packaged service installer, automatic update mechanism or Python data importer yet.
- Homebridge PIN maintenance is local Linux only, with the existing reviewed homebridge-deconz 1.3.5/homebridge-lib 8.1.5 source checks, one child bridge, local HTTP UI and matching OS ownership. Broader versions/remote/HTTPS UI support need separate work.
- Uncertain credential writes remain held when reliable evidence is unavailable. Policy backups do not contain gateway PINs. There is no unsafe bypass or automatic retry.
- Future controller support is an extension seam, not a functioning add-on. Shared code is extracted source rather than a published common package.
