# Selected migration: switch to the new administrator

Decision updated 2026-10-06: the owner will install the new standalone administrator and stop running the existing one when both new projects are ready. Both may remain installed, but only one will be used at a time. Parallel-admin coordination and a read-only second installation are not phase-1 requirements. An adapter for the old application's controller extension is no longer required.

## Order when ready

1. Preserve a bounded backup and inventory of accounts, settings, gateway identities, controller settings, inputs, HomeKit links and service paths.
2. Install the completed coordinator plugin in non-actuating commissioning mode, using Tailwind local API and direct deCONZ for the bolt.
3. Install the completed standalone administrator from this repository. Use its own URL; the existing address can be reused after the old web service stops.
4. Stop the existing administrator and its private extension. Transfer approved application state into the new installation, retaining account roles, UI preferences, activity and necessary transaction history. Do not copy old controller-extension registrations into the new application.
5. Verify the new administrator's connection, controller settings, virtual keypad and maintenance behavior. Stop the old movement engine and automatic input paths before enabling the coordinator.
6. Commission the new combined garage and optional Lock tiles, physical operation and recovery. Remap HomeKit scenes/automations as needed, then retire the two obsolete HTTP Webhooks definitions.
7. Keep the stopped original installation only for the agreed rollback window. Record the eventual cleanup list.

This is the migration overview. The isolated installation preparer and operational integration are implemented. Follow [owner-test.md](owner-test.md) for commands, review points and rollback, using the revisions recorded in [status.md](status.md). Initial installation and physical acceptance remain owner-run steps.
