# Preserved separated Python administrator

Preserved on 2026-10-08 at the owner's request. This branch is the historical Python implementation; ongoing standalone development belongs to the Node.js product on `main`.

## Exact source and verification

- Source repository: [pponce/homebridge-deconzKeypadAlarm-admin](https://github.com/pponce/homebridge-deconzKeypadAlarm-admin).
- Latest source `main`: [45e26c1d586bdcfa22b3b3b486485ba78ee4db6e](https://github.com/pponce/homebridge-deconzKeypadAlarm-admin/commit/45e26c1d586bdcfa22b3b3b486485ba78ee4db6e) (2026-10-07 23:35:43 UTC).
- Source tree: `7aad26d763148a43bf6796f7444a5e5fb05ec596`.
- Destination branch: [pponce/deconzAlarmKeypadConfigurator:legacy-python](https://github.com/pponce/deconzAlarmKeypadConfigurator/tree/legacy-python).
- Exact, unchanged destination snapshot: [54a65744846c4cf83d14859b1214f290ab9effdd](https://github.com/pponce/deconzAlarmKeypadConfigurator/commit/54a65744846c4cf83d14859b1214f290ab9effdd).
- Preserved files: **102**, including all source, browser assets and binary icons, tests, packaging and installation code, documentation, instructions and CI configuration.
- Every preserved path, Git blob ID and file mode matches the source. The exact destination snapshot has the same root Git tree ID as the source.
- [docs/python-preservation-manifest.json](docs/python-preservation-manifest.json) records all 102 source files and their Git blob IDs, sizes and modes.

At preservation, source `main` and its existing `legacy-python` branch pointed at the same revision. The only other branch, `coordinator-ui-011-preview`, was four commits behind with no unique commits ahead. It contained no newer Python implementation.

This branch adds only this note and the preservation manifest after the exact source snapshot. The original 102 files are unchanged, including the original README, package metadata, API contract and existing source-manifest/provenance files.

## Included behavior and boundaries

The retained `configurator/` package provides the separated deCONZ web administration interface, web accounts and Admin/Regular permissions, users, grants, PINs, schedules, alarm/keypad protection and lockout, history, backups and transaction recovery.

The existing optional Homebridge integration is retained in `configurator/homebridge.py`, its related local host/probe/helper modules, `configurator/static/homebridge-flow.js` and associated tests. It includes the original local Homebridge/deCONZ alarm-PIN maintenance workflow. Its documented compatibility, permissions and restart/recovery requirements still apply.

The optional separate controller connection is retained in `coordinator_admin/`, the configurator configuration/extension hooks, controller UI and API/integration tests. This connects to the separate Homebridge garage/bolt coordinator. It is not the original Python controller and does not contain a movement engine. Generic deCONZ administration is available without a coordinator configured; a configured integration retains its maintenance obligations.

The Python implementation uses its documented Node event observer and development tools. This is an exact preservation of the existing implementation, not a new dependency-free Python distribution.

The optional controller connection belongs only to this legacy Python branch. The planned standalone Node.js product on `main` has **no controller or controller connection**, while retaining optional Homebridge/deCONZ alarm-PIN integration. The combined Homebridge controller/admin remains in [homebridge-gdoor-admin-controller](https://github.com/pponce/homebridge-gdoor-admin-controller).

## History, installation and archival status

The original repository is retained separately; this task copies its latest tracked source snapshot, not its Git commit history, issues, pull requests or Actions logs. Archiving the original repository preserves those records and existing source/provenance links.

The owner recalls that this extracted Python repository was never installed or used on Mint. Earlier deployed separated Python web administration was still sourced from `garageDoorController`. Do not infer deployment from source availability or the historical owner-test instructions.

This copy changes no host services, accounts, gateway PINs, controller settings or installed files. No live installation or hardware test was performed. Verification for this preservation is exact Git object identity, not a new runtime acceptance test. Historical validation and limits remain in `docs/status.md`; historical installation instructions remain in `docs/owner-test.md`.

Original Git history, household-specific notes from `garageDoorController`, runtime/private configuration and credentials were not imported. No new software license is granted. Both repositories were private at preservation.

Treat the inherited plans and working agreements as the historical context of this source snapshot. Do not resume those old development milestones merely because they remain in the preserved documentation.
