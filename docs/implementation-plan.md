# Standalone administration implementation plan

Updated 2026-10-06. Development is authorized. Leave the current source repository and running installation unchanged.

## Agreed target

Preserve the full existing administration interface and UX, including its own URL, Admin/Regular accounts, users/grants, alarm and keypad settings, visual keypad, activity, schedules, protection, mobile layouts and home-screen branding. Phase 1 is a standalone web application; Homebridge hosting is deferred.

The owner will install this version and stop the existing administrator when both new projects are ready. Both can remain installed, but only one will be used at a time. Do not add parallel-admin orchestration, shared ownership coordination or a required read-only second installation. A compatibility adapter for the old installation is no longer a prerequisite.

The coordinator repository owns hardware drivers, movement, profiles and HomeKit accessories. This repository owns deCONZ administration and its native coordinator adapter. Generic deCONZ administration remains available without a coordinator configured. There is no second movement engine here.

## A1 — Shared API foundation: complete

- Authenticated loopback-only Python client with pinned instance identity, bounded responses, strict version/capability checks and sanitized errors.
- Shared API contract and tests against the actual sibling Node server.

## A2 — Existing interface and initial native adapter: implemented, validation recorded separately

- Extract a reviewed runtime dependency closure and the existing browser assets from the pinned source. Preserve upstream hashes in source-manifest.json; do not copy private history, household configuration or the old controller runtime.
- Preserve application auth, Admin/Regular rules, original screen assets, account operations, activity, keypad and gateway administration code.
- Add an application-owned Controller entry through the existing navigation/extension machinery. Its authenticated page reads fresh inventory from the coordinator; credentials remain in a private backend file.
- Register coordinator maintenance/keypad obligations. Until those operations exist, configured integration must reject affected changes before a gateway write; connection success is not operational readiness.
- Bundle both Python packages without dependencies on the original checkout. Do not reuse the old installer/service migration logic.
- Run retained application tests, desktop/mobile browser scenarios, adapter checks and the actual cross-repository test. Record skipped host-dependent checks separately.

## A3 — Complete controller settings, keypad and maintenance

- Implement controller selection and full settings review/apply/cancel/confirmation through the coordinator's revision-checked API. Retain useful existing timing help and add the sensor/timed-feedback questionnaire.
- Bootstrap settings belong to Homebridge; controller profiles/state belong to the plugin. Homebridge's configuration UI and the admin use the same profile authority. Do not edit Homebridge files directly.
- Add input setup that separates source/event, target assembly, action and motor path, with per-input timing and capability-specific stop/reverse settings. HomeKit and virtual keypad retain the primary opener path; physical keypad and indoor profiles can select the motor relay. The administrator does not subscribe physical controls or move a relay directly.
- Bind keypad delivery to gateway identity, alarm and controller. Validate the PIN through the existing deCONZ workflow, then send only scoped, fresh, deduplicated outcomes. Never forward raw PINs or replay uncertain commands.
- Implement real maintenance pause/verify/resume/recovery and preserve holds across restarts. Retain protected controller/Homebridge identities and transaction recovery. Do not acknowledge unimplemented operations.
- Verify behavior when the plugin is unavailable, restarts mid-operation, rejects identity/version, or changes configuration concurrently with a review.
- Physical keypad processing belongs to the plugin and must function when the administrator is stopped or the browser is closed.

## A4 — Standalone installation and state migration

- Implement installation paths and service identities for this new application, keeping its own URL and the full existing interface. Optional reuse of the old URL follows stopping the old web service.
- Transfer approved accounts, roles, branding/preferences, gateway identities, history and recovery state. Exclude old private-controller registrations and source bundles; attach the native coordinator adapter instead.
- Preserve automatic newest-20 eligible backup retention and all UI requirements in ux-parity.md.
- Supply bounded backups, installation/rollback receipts and a clear eventual cleanup list. Leave original repository history and operational notes private.

## A5 — Joint owner testing and cutover

- Coordinator acceptance requires working Tailwind/direct-deCONZ drivers, serialized coordination, stable HomeKit accessories, feedback policies and supported input behavior.
- Administrator acceptance requires full controller settings, virtual keypad, activity, gateway maintenance, account/UI preservation and restart recovery against that coordinator.
- Validate both new projects together before inviting the owner to install/test on the live Homebridge setup. A mock browser test or read-only connection is not sufficient.
- Install the coordinator initially non-actuating, switch to this administrator and stop the old administrator, then transfer movement ownership from the old controller.
- Remove old HTTP Webhooks accessory definitions only after physical and HomeKit acceptance.

## Deferred phase 2

Package this full web application as a Homebridge plugin while retaining its own web URL. Homebridge settings contain high-level server/setup settings. This is not part of the current implementation.

## Current implementation checkpoint

A3 operational integration and A4 isolated installation preparation are implemented. Release CI and cross-repository tests pass. A5 is ready for owner installation/testing; owner-host state transfer and physical acceptance remain outstanding; see status.md and owner-test.md.
