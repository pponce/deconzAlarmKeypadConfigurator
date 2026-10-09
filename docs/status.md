## PIN update button confirmation

Removed the redundant PIN confirmation checkbox at the owner's request. Clicking Update PIN authorizes submission; other integration preparation checks still apply. Version 0.1.0-dev.6. The owner confirmed 0.4.38 worked on the live host. CI 37889401052 passed desktop Chromium and mobile WebKit PIN update/recovery checks on source `ddeef48010a2bb9dd48f95f7246da50b7e078eea`. Node 22/24 checks passed; combined Homebridge 2.0/2.4 checks passed. Source publication does not mean npm publication or host installation.

## Homebridge PIN authorization and user form

Web-admin administrators authorize new PIN API updates; Homebridge UI credentials are requested only for optional log clearing. Legacy offline recovery still requires Homebridge authorization. Live scoped API readback checks gateway/accessory identity and readiness without authenticated UI process inspection. Preflight errors retain a safe reason/kind and explicitly report no PIN write. The current Homebridge user keeps implicit selection with its redundant checkbox hidden and clear blank-PIN guidance. Local validation: 44 focused combined tests and all 154 standalone tests passed; both demos rebuilt and combined browser syntax checked. CI 37888669757 passed on exact source `7fe338bb96668fb540af0fe37230cc2992fada86`, including desktop Chromium and mobile WebKit read/write/recovery. Combined Homebridge 2.0/2.4 integration and package checks passed; GitHub release v0.4.38 is available. Source/release publication is not npm publication or live installation.

# Standalone Node port status

## 2026-10-09 — Official Homebridge PIN API and optional log clearing

New updates use the maintainer's Configuration API and installed ui discovery command. The owner explicitly accepts upstream PIN logging and normal deferred persistence; no routine restart or saved accessory-file edit is made. Source fingerprints remain only for already-pending legacy offline operations. Preserve identity, mapping, grant, auth, private storage, single gateway write and recovery checks. Small private PIN recovery data replaces full-cache snapshots for new updates. Live API readback establishes runtime application, not a disk flush.

The review window offers an unchecked option to clear the entire current Homebridge log after all transaction participants complete. Use the administrator log/truncate API with a JSON body; record deletion intent once and keep failures separate from PIN completion. Never automatically repeat deletion or uncertain PIN writes. Archived/downloaded/externally collected logs are unaffected.

All 152 standalone tests pass locally and on Node 22/24 with normal npm dependencies. [CI run 37886367448](https://github.com/pponce/deconzAlarmKeypadConfigurator/actions/runs/37886367448) passes on `207f6a6b74c37fbdb6d0ba5b6ec387f81e7ec917`, including Chromium desktop and WebKit mobile production read/write/recovery flows, unchecked log opt-in and cleanup failure after a successful update. Tests verify no service stop/start, one gateway write and no repeated Homebridge write during recovery. The initial browser pass caught a combined-controller name in the standalone readiness message; it was corrected before this passing run. No npm publication, host installation or hardware acceptance is claimed.


## 2026-10-09 — Source-based Homebridge PIN compatibility

Remove exact installed package-version equality as requested. Package names and every previously reviewed source fingerprint still must match. The manifest labels the originating releases as reviewed_version, informational provenance only. All cache schema/identity/mapping/PIN checks, stopped-process checks, backup, compare-and-replace and restart/recovery checks remain. New regression coverage accepts version-only changes while rejecting wrong package identity, modified source under either version, and missing source.

The private backup retains before/after Homebridge accessory-file data in one overwritten file. It is not a deCONZ credential backup or an automatic cross-system rollback. Recovery verifies or completes the saved operation without replaying the gateway PIN write.

All 144 standalone tests pass locally and on Node 22/24 with normal npm dependencies. Chromium desktop and WebKit mobile read/write/recovery workflows pass in [CI run 37884257521](https://github.com/pponce/deconzAlarmKeypadConfigurator/actions/runs/37884257521) for `cbf227bfce5ef0077d5705a2a75ef11116b1f321`. No live host changes are part of this source update.

Current development version: `0.1.0-dev.3`.

Implemented: independent HTTPS process, interactive local account/gateway/network setup, private config and process ownership, gateway identity verification, existing web account roles, users/PINs/access/schedules, alarm and lockout administration, history, durable writes/recovery, direct virtual keypad, and optional local Homebridge child-bridge PIN workflow. The latest combined-plugin user/mobile/password UI is retained. No garage/bolt code or Homebridge plugin runtime is included.

The preserved Python branch and source repositories are unchanged. A programmatic extension seam is available; no controller add-on or dynamic plugin system ships.

## Static public demo

The public README now links directly to the hosted demo. Removed the separate demo setup README at the owner’s request. Documentation-only change; reviewed the links and confirmed the generator does not require that file. Generated demo assets and application behavior are unchanged.

On 2026-10-09, the owner made the repository public and enabled GitHub Actions as the Pages source. Updated the hosting instructions and deployed the current demo successfully in [Actions run 37890391580](https://github.com/pponce/deconzAlarmKeypadConfigurator/actions/runs/37890391580), source `e28ee09b5bca9ff67b0b9abe6beac17914f831c4`. Generated-asset checks, Chromium desktop, WebKit mobile and the Pages deployment all passed. The published URL is https://pponce.github.io/deconzAlarmKeypadConfigurator/. Independent retrieval of the hosted URL was unavailable from this environment; publication is confirmed by GitHub’s successful deployment result.

Added `demo/`, generated from the current standalone UI at `7f45cf48347b3663dde823a42f85e4500b25117b`. `scripts/build-demo.mjs` records the exact adaptations: fixed demo mode, synthetic session/setup, removed live API and extension transports, hidden installation/account controls, relative assets, separate browser-storage keys and a restrictive content security policy. The application source and runtime behavior are unchanged.

The README links the intended Pages URL. `.github/workflows/demo-pages.yml` checks generated assets, runs desktop/mobile browser exercises and uploads only `demo/`. Deployment waits until the owner makes the repository public and selects GitHub Actions in Pages settings. Local generation/consistency, JavaScript syntax, asset resolution and demo-engine checks passed. [Demo CI run 37883279146](https://github.com/pponce/deconzAlarmKeypadConfigurator/actions/runs/37883279146) passed on implementation commit `617d52e212230e7b23936f57c5983ad55207bbf2`: Chromium desktop and WebKit mobile navigation, user edits across reload, PIN non-persistence, protection/alarm changes, simulated keypad acceptance, gateway switching, reset, mobile layout and no API/external requests. Tests serve the actual `demo/` folder under the project-site URL prefix. Only the static folder was uploaded; deployment was correctly skipped while the repository remained private. No live services or hardware were involved.

[Publication review](publication-review.md) records the sensitivity sanity check across all reachable Node/Python history and its limits.

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
- Homebridge PIN updates require local Linux, the installed homebridge-deconz UI command, one child bridge, local HTTP UI and matching OS ownership. New API updates do not require source fingerprints; legacy pending offline operations retain their reviewed checks. Remote/HTTPS UI support needs separate work.
- Uncertain credential writes remain held when reliable evidence is unavailable. Policy backups do not contain gateway PINs. There is no unsafe bypass or automatic retry.
- Future controller support is an extension seam, not a functioning add-on. Shared code is extracted source rather than a published common package.
