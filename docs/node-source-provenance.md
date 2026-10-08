# Node source extraction

Source: `pponce/homebridge-gdoor-admin-controller`, `web-admin-lan-controller-timings`, commit `e037d9c252f72eb3828e4cb9d625acd1db45023c` (0.4.25). Its main branch was still at the older 0.4.24 when this port began.

Destination: the `standalone-node` development branch of `pponce/deconzAlarmKeypadConfigurator`.

| Source area | Destination / treatment |
| --- | --- |
| `src/web-admin-*` authentication, gateway, domain/editor, schedules, history, collector, transactions, backups and keypad | Reused under `src/`; standalone storage paths replace the coordinator directory. |
| `web-admin/public` UI and icons | Reused under the same path, preserving latest mobile/user/password fixes; controller screen/script removed, setup/help text adapted. |
| Homebridge host/client/maintenance and reviewed source fingerprints | Reused as an optional adapter; Homebridge storage is separate from standalone data and package paths are explicitly registered locally. |
| Combined `web-admin-service.js` and `web-admin-manager.js` wiring | Replaced with standalone composition, lifecycle, private config and interactive CLI. No plugin runtime is instantiated. |
| `src/ownership.js`, `src/fault.js` | Reused/adapted for the standalone process lock. |
| Admin unit tests, parity fixtures and browser checks | Reused with controller-specific tests removed and standalone integration coverage added. |
| Controller, commissioning, accessory platform, Homebridge UI and plugin dependencies | Not included. |

The source manifest records upstream Git blob IDs for copied files, their destination hashes and adaptations. Binary icons retain their original contents. New standalone files are listed separately. Nothing was removed from or pushed to the source plugin, the original Python repository, or the preserved Python branch.

This is a reviewed source extraction, not an automatic cross-repository synchronization mechanism. Future shared fixes should identify their source commit and receive relevant tests in both products. The existing `UNLICENSED` designation is retained.
