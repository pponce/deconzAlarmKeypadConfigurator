# Administration source comparison and current UI baseline

Compared on 2026-10-08 to answer the owner's concern that recent UI changes or fixes might have been omitted from the preserved Python branch.

## Findings

The preserved Python administrator contains the latest generic Python admin UI and fixes present in the original repository at the inspected heads. No newer generic Python UI fix was found in the original repository that needs to be copied into `legacy-python`.

This is a comparison of the separated administrator under `garageDoorController/configurator/`, rather than the older `admin/` application. The original repository retains both generations. The latest observed change under `admin/static/` was on 2026-09-26 UTC; `configurator/static/` includes the later October changes.

The Python extraction is a different integration/deployment variant, not a wholesale newer rewrite. Its only generic UI difference is a settings-button busy-state fix. The newest overall web-admin improvements are in the later Node.js combined plugin and are the baseline for the future Node.js standalone app.

## Exact revisions

| Role | Repository and revision |
| --- | --- |
| Original Python source | `pponce/garageDoorController` at `a47fa4db3a12e5239d447ee4c5213c59eeb81542` |
| Extracted Python source copied earlier | `pponce/homebridge-deconzKeypadAlarm-admin` at `45e26c1d586bdcfa22b3b3b486485ba78ee4db6e` |
| Preserved Python branch inspected | `pponce/deconzAlarmKeypadConfigurator:legacy-python` at `69fda52efebf42a7d4dd0877e4a138738ad22401` |
| Latest Node.js admin baseline inspected | `pponce/homebridge-gdoor-admin-controller:web-admin-lan-controller-timings` at `e037d9c252f72eb3828e4cb9d625acd1db45023c`, package `0.4.25` |

Both branches in the original repository point at the same Python revision. There is no newer original feature branch to collect. The inspected Node.js baseline is eight commits ahead of the combined plugin's `main` (`0182430c3dd0d8b31ece53ffece85a000671dc9a`, package `0.4.24`). Do not use that older default branch accidentally. Recheck branch heads before beginning implementation.

## Python source comparison

There are **74 common files under configurator/**: **68 byte-identical files and six changed files**. All **21 generic browser assets** are present in the copy: **20 are byte-identical**, and `static/app.js` differs by one settings-button change.

| Area | Result |
| --- | --- |
| Login, web accounts, permissions and web server | Same source bytes in the common modules. |
| deCONZ users, PINs, grants, schedules, alarm/keypad protection and lockout | Same source bytes in the common modules. |
| Homebridge/deCONZ PIN maintenance, local host adapter and browser flow | Same source bytes. Fresh-install registration tooling is discussed separately below. |
| Virtual keypad, activity/history, backup retention and transaction recovery | Same source bytes in the common modules. |
| Generic HTML, CSS, mobile styles, settings, keypad, Homebridge flow, setup/welcome assets and icons | Same source bytes, except the settings-button change in app.js. |
| Controller integration | Original private Python controller extension versus the extracted Homebridge coordinator adapter. |
| Installation and host lifecycle | Different distributions; the original has broader fresh-install/provisioning/migration tools. |

Recent original Python changes confirmed present in the copy include the generic backup-notice removal, remembering a registered extension page across refresh, restoring phone navigation when continuing a saved update, and completing integration confirmations after a rejected credential change. This follows from the exact current-file comparison, not merely commit dates.

### The six changed common files

| File | Exact effect in the preserved copy |
| --- | --- |
| [configurator/configuration.py](https://github.com/pponce/deconzAlarmKeypadConfigurator/blob/69fda52efebf42a7d4dd0877e4a138738ad22401/configurator/configuration.py) | Accepts and validates an optional `coordinator` connection. |
| [configurator/extensions.py](https://github.com/pponce/deconzAlarmKeypadConfigurator/blob/69fda52efebf42a7d4dd0877e4a138738ad22401/configurator/extensions.py) | Registers the built-in Homebridge coordinator adapter; permits its explicit read-only POST probe in observation mode. Existing mutation and maintenance checks remain. |
| [configurator/package.py](https://github.com/pponce/deconzAlarmKeypadConfigurator/blob/69fda52efebf42a7d4dd0877e4a138738ad22401/configurator/package.py) | Packages the admin runtime plus `coordinator_admin`, using a different allowlist from the original fresh-install distribution. |
| [configurator/static/app.js](https://github.com/pponce/deconzAlarmKeypadConfigurator/blob/69fda52efebf42a7d4dd0877e4a138738ad22401/configurator/static/app.js) | Adds `#settings-gear` to controls disabled while an action is busy. This makes the button's visible availability match the existing busy guard. No other difference in this file. |
| [configurator/tests/parity_fixture.py](https://github.com/pponce/deconzAlarmKeypadConfigurator/blob/69fda52efebf42a7d4dd0877e4a138738ad22401/configurator/tests/parity_fixture.py) | Replaces the old private-controller test fixture with the optional coordinator fixture. |
| [configurator/tests/test_setup_connect.py](https://github.com/pponce/deconzAlarmKeypadConfigurator/blob/69fda52efebf42a7d4dd0877e4a138738ad22401/configurator/tests/test_setup_connect.py) | Uses the existing runtime transaction guard rather than importing the original installer guard. |

## Original-only code and practical limits

The original has 42 additional files under `configurator/`: 12 Python setup/deployment/lifecycle modules, the installation guide, three systemd templates and 26 tests/fixtures. These are not missing ordinary admin UI updates, but they matter if someone wants the original generic fresh-install distribution.

Notable examples are [install.py](https://github.com/pponce/garageDoorController/blob/a47fa4db3a12e5239d447ee4c5213c59eeb81542/configurator/install.py), [browser_install.py](https://github.com/pponce/garageDoorController/blob/a47fa4db3a12e5239d447ee4c5213c59eeb81542/configurator/browser_install.py), [onboarding.py](https://github.com/pponce/garageDoorController/blob/a47fa4db3a12e5239d447ee4c5213c59eeb81542/configurator/onboarding.py), [homebridge_setup.py](https://github.com/pponce/garageDoorController/blob/a47fa4db3a12e5239d447ee4c5213c59eeb81542/configurator/homebridge_setup.py), provisioning, migration, runtime updating, retirement and writer coordination. The initial Homebridge-registration wizard is in this original tooling; the already-configured PIN maintenance logic remains identical in the copied runtime.

The extracted [coordinator_admin/install.py](https://github.com/pponce/deconzAlarmKeypadConfigurator/blob/69fda52efebf42a7d4dd0877e4a138738ad22401/coordinator_admin/install.py) instead prepares a new installation from a stopped existing administrator, carries over reviewed accounts/settings/history and the optional Homebridge registration/helper, and attaches the separate Homebridge coordinator. It requires the prior broker/web configuration and coordinator identity. It prepares files and units; it does not itself install/start services.

The original controller page and integration live in `private_extensions/controller/`. The copy instead includes the nine files under `coordinator_admin/`, with the controller API client, UI, maintenance/keypad integration and installation preparer. Neither the original movement engine nor its private extension was copied into this repository.

Accordingly, `legacy-python` preserves the extracted admin source and latest generic Python UI; it is not a full copy of the old Mint deployment or its generic fresh installer. Those remain preserved in `garageDoorController`.

## Baseline for the new standalone Node.js app

Use the latest Node.js administration code and assets at [e037d9c252f72eb3828e4cb9d625acd1db45023c](https://github.com/pponce/homebridge-gdoor-admin-controller/commit/e037d9c252f72eb3828e4cb9d625acd1db45023c), or a reviewed newer descendant, when implementing the standalone application. Preserve applicable improvements including:

- Clear separation and labeling of the signed-in account's password form.
- Specific Homebridge setup/readiness messages.
- Visible Homebridge-user selection with readiness and eligibility feedback.
- Mobile user details opening before the readiness check.
- Existing Node.js account, authorization, PIN, schedule, lockout, history, virtual-keypad, backup and recovery behavior.

The shared administration code must be separated from plugin startup, storage and connection configuration. The standalone Node.js product has no controller, controller page or controller connection. The optional controller adapter remains only in the historical Python branch. Homebridge/deCONZ alarm-PIN maintenance remains optional for the standalone Node.js product.

Node.js controller-timing features belong to the combined plugin and are excluded from the standalone app. Homebridge-specific connection/lifecycle wording needs adaptation, not blind file replacement.

The Node.js UI must not simply be dropped into the Python branch: its changed endpoints, response fields and integration wiring have corresponding Node.js backend changes. Preserve the historical Python implementation separately and carry the latest applicable UI fixes into the Node.js product.

## Work performed and verification

Compared Git blob IDs and file modes, read all six changed common files, reviewed original-only setup paths and both controller integrations, and inspected the latest Node.js UI commits. No source-code behavior, installed service, gateway data or runtime state changed during this comparison. No hardware tests were performed.

The `legacy-python` branch remains unchanged at the inspected preservation commit. This update adds the comparison and source-selection record to `main`, with a link from its README. It does not implement the standalone Node.js application or claim that the Node.js sources have already been copied here.
