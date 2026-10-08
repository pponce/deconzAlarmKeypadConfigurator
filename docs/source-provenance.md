# Source provenance and extraction boundary

Reference: pponce/garageDoorController at commit `7d4e0f04e4ef3631e721e571adb292cf11988e87` (2026-10-06).

The reviewed extraction contains 73 files, enumerated in source-manifest.json with upstream Git blob IDs and SHA-256 hashes. It includes the 32-module runtime dependency closure, the Node event observer, all 21 generic browser assets (including the original binary icons), and selected application/browser regression fixtures. Original file bytes were verified against the pinned Git blobs before copying.

All 21 original browser assets are retained; 20 remain byte-identical. Changes to imported files in this milestone are limited to:

- configurator/configuration.py: optional native coordinator declaration.
- configurator/extensions.py: explicitly registered application-owned adapter, preserving external extension checks; finite POST_READ route class limited to the built-in adapter for explicit read-only probes. All mutation/maintenance guards remain enforced.
- configurator/static/app.js: disable the settings button while the existing action guard is busy, including background protection refreshes. This makes its availability reflect the guard and prevents a seemingly available settings tap from being discarded during a refresh.
- configurator/tests/parity_fixture.py: remove the private controller fixture and support the new coordinator connection.
- configurator/tests/test_setup_connect.py: test enrollment holds through the runtime transaction guard rather than importing the old installer.

All other imported files retain their recorded upstream SHA-256. The coordinator adapter, controller connection page and development bundle builder are new source. The bundle builder includes both Python packages and does not install services.

Not imported: original Git history, household notes or configuration, credentials/PINs, runtime state, old admin application, private controller runtime/extension, installer/provisioning/migration/retirement/update scripts or systemd units. The Controller page is newly implemented against the native coordinator API and shared profile editor, rather than importing the old private controller extension. Physical acceptance is recorded separately.

No top-level license was present in the reviewed source tree; this extraction does not introduce a new license grant. Existing source notices/comments were retained. Both destination and source repositories remain private.

The new bundle builder now includes editor.js/editor.css and install.py. The controller editor and installation preparer are new source. The native adapter also reconciles a completed local maintenance transaction with a matching verified coordinator hold after interruption; it does not repeat the gateway write.
