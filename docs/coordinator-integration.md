# Coordinator integration in the new application

This documents the backend connection. Use [owner-test.md](owner-test.md) for installation and state preparation; the example below contains synthetic values.

The broker accepts an optional coordinator object in its own private configuration:

```json
{
  "base_url": "http://127.0.0.1:27773",
  "token_file": "/absolute/private/path/coordinator-token.json",
  "instance_id": "00000000-0000-4000-8000-000000000001",
  "scopes": [
    {
      "gateway": "example",
      "identity": "0011223344556677",
      "alarm": 1,
      "controller": "example-garage"
    }
  ]
}
```

The credential file contains only {"token":"..."}, belongs to the broker's operating-system user and has mode 0600. It must be a regular file, not a link. The installation preparer provisions it from the plugin's private identity file without relaxing Homebridge storage permissions. The backend reads the credential for requests, validates the expected plugin UUID and exposes neither token nor private paths to the browser.

The native adapter is registered as homebridge-coordinator. Admin accounts see its Controller page in the existing navigation. Regular accounts retain their existing permissions and cannot access that page. Routes continue through the authenticated web server and broker; browser scripts never call the plugin directly.

The Controller page provides connection/inventory, current status and an explicit Check connections button per assembly. Probes support Tailwind, deCONZ and configured Homebridge service mappings. The browser receives timestamped, validated sensor/relay evidence with fixed setup guidance. A probe cannot commission or actuate. Finite POST_READ operations remain available in observation mode with authentication, Admin-only authorization, same-origin and CSRF checks; mutation guards remain enforced. Failed reads clear inventory instead of presenting old state as current. Unknown state and unavailable operations remain explicit. Configuration validation and startup never send hardware commands.

The routing inventory shows HomeKit and virtual keypad on the primary opener (Tailwind for the owner), and configured buttons/keypads on their chosen motor path. Physical subscriptions belong to the commissioned coordinator and continue when this administrator is stopped. The page also supports coordinated commands, explicit commissioning/recovery, bounded activity and settings review/apply/cancel through the shared profile editor. Profiles use revision checks; changed device keys or assembly settings require commissioning again. Keys and device discovery stay in Homebridge plugin settings. Commands carry boot identity, freshness and a request ID; uncertain movement is never automatically retried.

The native adapter registers required maintenance and scoped keypad obligations. The original deCONZ flow validates a keypad request; the adapter forwards only the fresh scoped outcome, not the PIN. A valid disarm uses the primary opener; a rejected code requests closing according to the configured policy. A busy, stale, unavailable or mismatched coordinator cannot count as a successful operation.

Maintenance pauses the coordinator durably, verifies after the gateway change and releases only the matching completed transaction. Homebridge/PIN maintenance retains physical bolt/stillness confirmation. While paused, direct deCONZ control is used for the physical bolt check; the coordinator's own Lock tile remains paused. A locally completed transaction can reconcile a matching verified coordinator hold after interruption without repeating the gateway change. An unavailable participant blocks the affected change.

No systemd calls or legacy controller-file writes exist in this adapter. The generic application's separate deCONZ/Homebridge maintenance adapters retain their original responsibilities. An existing separately registered host helper is retained by installation preparation when configured.
