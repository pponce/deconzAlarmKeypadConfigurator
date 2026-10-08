# deCONZ Alarm / Keypad Configurator

This repository is the home for the planned standalone Node.js web administrator for deCONZ alarms and keypads.

## Active development: main

The Node.js application has not been implemented here yet. Its intended scope is web accounts and permissions, deCONZ users and PINs, access grants and schedules, alarm and keypad protection, lockout rules, activity and administration.

Homebridge is optional. An optional integration will manage the alarm PIN used by homebridge-deconz. This standalone Node.js product will not include a garage/bolt controller or a controller connection.

The combined Homebridge controller and web administrator is developed separately in [homebridge-gdoor-admin-controller](https://github.com/pponce/homebridge-gdoor-admin-controller). The intended implementation shares reusable Node.js administration code between the two products.

## Preserved Python implementation: legacy-python

The [legacy-python branch](https://github.com/pponce/deconzAlarmKeypadConfigurator/tree/legacy-python) preserves the latest separated Python administrator from pponce/homebridge-deconzKeypadAlarm-admin at commit `45e26c1d586bdcfa22b3b3b486485ba78ee4db6e`.

That historical implementation includes optional local Homebridge/deCONZ alarm-PIN maintenance and an optional connection to the separate Homebridge garage/bolt coordinator. The controller connection belongs only to the preserved Python implementation, not the planned standalone Node.js product.

See [PYTHON-ARCHIVE.md](https://github.com/pponce/deconzAlarmKeypadConfigurator/blob/legacy-python/PYTHON-ARCHIVE.md) on that branch for provenance, integrity verification, integration boundaries and validation limits.

The Python branch is a source reference, not an ongoing feature-development branch. Its original runtime, documentation and tests are retained. This preservation does not install an application, migrate host data or grant a new software license.
