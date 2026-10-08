# Install the standalone administrator for owner testing

Use the coordinator and administrator revisions recorded as passed in their status.md files. The web application remains standalone, with its own HTTPS URL and the full existing login, accounts, deCONZ pages and virtual keypad. It is not hosted inside Homebridge.

## Prepare from the existing installation

Install/configure the coordinator first but leave its garage disabled. Its child bridge must be separate from the homebridge-deconz child bridge that maintenance may restart. Both the new administrator and coordinator run on the same host for the loopback API.

Identify the current broker and web configuration paths from the existing service units. Complete any outstanding maintenance/recovery in the old interface. Stop the old web service, broker, controller extension, movement service and physical-input services when ready to switch. If there is a separately registered host maintenance helper, keep that helper running: the preparer retains its existing protected registration and service-control/database-backup role. This does not retain the old web interface or controller. Do not stop unrelated Homebridge/deCONZ services.

Clone this private repository on the host using your normal GitHub account access. Run the preparer under the existing broker's account (typically root when the existing broker owns privileged maintenance). Substitute your actual paths, URL and controller ID; these are examples, not detected host values:

```sh
sudo python3 -m coordinator_admin.install \
  --broker /path/to/current/broker.json \
  --web /path/to/current/web.json \
  --coordinator-identity /path/to/homebridge/gdoorandbolt-coordinator/identity.json \
  --destination /opt/gdoor-coordinator-admin \
  --origin https://your-hostname:8788 \
  --port 8788 \
  --scope your-gateway-id:1:your-controller-id
```

Run from this repository directory. Python 3.10+ and Node 22/24 are required. `--scope` is repeatable and binds the existing gateway registration ID, alarm number and coordinator ID. Match it to the virtual-keypad alarm configured in the coordinator. For a nondefault API port also supply `--management-port`. Keep credentials out of command-line arguments: the preparer reads the private identity file directly.

The destination must not exist. Preparation copies only approved application state: account verifiers/roles, branding/preferences, gateway identities, SQLite activity, completed transactions and bounded backups. Runtime gateway registrations are folded into the new private config. Old private-controller registrations are excluded. Incomplete old transactions stop the transfer. The source files remain intact; the old broker's normal ownership lock is held during copying. A failed preparation leaves an inert private partial directory for inspection, never an activated installation.

TLS certificate/key are copied from the current web installation. Use a hostname covered by that certificate; changing its port does not change certificate identity. The preparer preserves the existing broker/web service accounts, selected Homebridge/deCONZ integration and optional host helper. It creates a new application bundle, private coordinator-token file and two service units, but **does not install or start any service**. If the existing installation is in observe mode, that mode is preserved; deliberately review/manage mode before expecting gateway writes.

## Review and start

Review `private/broker.json`, `web/web.json`, `private/migration.json` and the units privately on the host. Do not paste these files into Git/issues. Confirm the new state, backup, socket and URL paths are separate from the old installation, and the scope points at your saved coordinator profile.

For the example destination, install the prepared units:

```sh
sudo install -m 0644 /opt/gdoor-coordinator-admin/units/gdoor-admin-broker.service /etc/systemd/system/
sudo install -m 0644 /opt/gdoor-coordinator-admin/units/gdoor-admin-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gdoor-admin-broker.service gdoor-admin-web.service
```

Open the chosen HTTPS URL and use your existing account. Confirm the Regular/Admin distinction, accounts, branding, history, alarms and keypad pages. The Controller page should show the coordinator and saved settings; its device discovery and private connection-key entry are in the Homebridge plugin settings. Both editors write the same versioned profiles. The new interface does not edit Homebridge configuration files.

With the old movement and input services stopped, use **Enable / recover this garage** after physical checks. Follow the coordinator's owner-test.md for the observed open/close/bolt/button/keypad sequence. Generic deCONZ changes use the original maintenance transaction flow, now with a durable coordinator pause; Homebridge/PIN maintenance retains preparation and physical confirmation prompts. An unavailable coordinator blocks affected changes rather than claiming success.

Check service status with `systemctl status gdoor-admin-broker gdoor-admin-web`; logs omit device keys and PINs. A failure to reach the coordinator, wrong scope or missing identity must be resolved before operational tests. The initial setup/copy and physical mechanisms are owner-host acceptance steps, not established by CI.

## Rollback

Stop the new web/broker services and the coordinator child bridge. Check physical state and review changes made during testing. Restart the stopped old interface/controller/input services only after the new controller is off. Old accounts/state/source remain in place; do not blindly restore old gateway/PIN data. Keep the prepared migration receipt and private diagnostics until acceptance, then decide separately when to remove the old installation. Parallel interface management is not required for this migration.
