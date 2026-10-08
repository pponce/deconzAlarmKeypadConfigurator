# deCONZ Alarm / Keypad Configurator

Standalone Node.js web administration for deCONZ keypads and alarms. Homebridge is optional. This is the first development port, based on the current combined plugin's admin UI and backend.

- Named web accounts with administrator and regular-user permissions.
- Gateway users, PINs, per-alarm access, keypad permissions, schedules and use allowances.
- Alarm settings, physical-keypad lockout policy and lockout reset.
- Direct-to-deCONZ virtual keypad, activity history and private recovery snapshots.
- Optional local Homebridge-deCONZ alarm-PIN synchronization.

There is no garage-door or bolt controller, movement logic, HomeKit accessory registration, Homebridge plugin entry point or required Homebridge dependency. A programmatic extension boundary is retained for future add-ons; none is installed or enabled by default.

## Run the development version

Use Node.js **22.13+ in the 22 line, or 24**, plus OpenSSL on PATH. Linux is the initial host target. The optional Homebridge adapter specifically requires Linux. The gateway must provide the enhanced deCONZ managed-users API (`global_users_version: 2`); ordinary deCONZ without those endpoints is insufficient.

```sh
npm install --ignore-scripts
npm run setup
npm start
```

Setup runs interactively in a local terminal. It asks for the HTTPS address, listening address, deCONZ endpoint and API key, and your first web administrator account. Passwords and API keys are hidden while entered. Setup reads the gateway identity and pins it; it does not create users or send alarm commands.

The default listener is `https://localhost:9443` on `127.0.0.1`. Trust the generated self-signed certificate separately. For LAN use, enter the machine's LAN HTTPS address during setup and choose `0.0.0.0` as the listening address. Use exactly the configured origin in the browser. Initial account creation is local; there is no public signup endpoint.

For a custom private data directory:

```sh
npm run setup -- --data-dir /absolute/private/path
npm start -- --data-dir /absolute/private/path
```

Use the same directory and operating-system account for every command. The default is `~/.local/share/deconz-keypad-configurator`; private application files live in its `deconz-keypad-admin` child directory. The directory must belong to the service account, with mode 0700. A process lock prevents two instances from using the same state. Account verifiers, API keys, TLS keys, SQLite history and recovery records stay outside the source repository.

Stop the process with Ctrl-C/SIGTERM. There is no automatic installer, service takeover, npm publication or migration of an existing Python/Homebridge installation.

## Configuration and ordinary use

Use Settings → Security to add web accounts and change passwords. Regular accounts can manage ordinary alarm users/access and reset lockouts; protected owner and Homebridge identities require an administrator. Web accounts are separate from alarm users and PINs.

Use Settings → Connections to edit a saved gateway. A blank key keeps the existing key. Changes are identity-verified and activate after restarting this server; gateway actions are held until then.

These local commands run while the server is stopped:

```sh
node bin/deconz-keypad-admin.js gateway     # add or update a gateway
node bin/deconz-keypad-admin.js network     # listener, HTTPS address, manage/observe mode
node bin/deconz-keypad-admin.js homebridge  # optional local Homebridge registration
```

Append `--data-dir /absolute/private/path` if using custom storage. The first port uses terminal setup; it does not yet provide a browser installer or automatic gateway discovery/enrollment. [Installation help](web-admin/public/installation-help.html) explains API keys and ordinary workflows.

The virtual keypad talks **directly to deCONZ**. Homebridge is not required. It submits each request once and retains a durable duplicate-request ledger across restarts. Physical keypad lockout rules do not also protect the REST keypad. Observation mode disables changes and commands.

## Optional Homebridge alarm PIN

The initial adapter supports a **local Linux** Homebridge instance, one deCONZ platform in its own child bridge, and a Homebridge UI accepting local HTTP requests. Run the standalone server as the Homebridge operating-system account; it needs narrowly scoped access to the selected accessory cache. Its own data remains separate.

The `homebridge` command asks for the Homebridge storage directory, its `config.json` path, and the installed `homebridge-deconz` package directory. No Homebridge configuration or installed plugin source is rewritten. The adapter checks source fingerprints for `homebridge-deconz 1.3.5` and `homebridge-lib 8.1.5`; different versions remain unavailable until reviewed. Remote hosts and HTTPS-only Homebridge UI are not supported in this first adapter.

In Users, select the Homebridge user and included alarms. Changing its PIN requires confirmation and a Homebridge administrator login. The existing workflow stops the deCONZ child bridge, makes the bounded PIN update, restarts it and checks the saved result. The standalone web server stays running. The password/OTP are used only for that operation. Private credential-recovery backups remain protected in the standalone data directory.

Interrupted changes retain their recovery holds. A lost reply is never automatically retried. Policy-only backups do not recover gateway PINs, and some ambiguous credential outcomes need external evidence. See [status](docs/status.md).

## Development and provenance

Run `npm test`. GitHub Actions checks Node 22/24 plus Chromium desktop and WebKit mobile workflows against synthetic devices. Browser scripts use an explicitly installed Playwright module via `PLAYWRIGHT_MODULE`; they never access household hardware.

The Node baseline is [homebridge-gdoor-admin-controller 0.4.25 at e037d9c2](https://github.com/pponce/homebridge-gdoor-admin-controller/commit/e037d9c252f72eb3828e4cb9d625acd1db45023c), from `web-admin-lan-controller-timings`. This retains the latest user-selection, mobile editor and separate signed-in-password UI fixes. The source plugin is unchanged. Extraction details and source hashes are in [source provenance](docs/node-source-provenance.md) and [manifest](docs/node-source-manifest.json). Shared upstream fixes can be ported deliberately; this is not yet a shared npm package.

See [extension boundary](docs/extensions.md) for the future add-on seam. It is a trusted programmatic API, not an installed controller, browser plugin loader or remote controller protocol.

## Preserved Python version

The frozen [legacy-python branch](https://github.com/pponce/deconzAlarmKeypadConfigurator/tree/legacy-python) remains unchanged. It preserves the separated Python administrator from `homebridge-deconzKeypadAlarm-admin` at `45e26c1d586bdcfa22b3b3b486485ba78ee4db6e`, including its optional Homebridge PIN maintenance and separate-controller connection.

[PYTHON-ARCHIVE.md](https://github.com/pponce/deconzAlarmKeypadConfigurator/blob/legacy-python/PYTHON-ARCHIVE.md) records its integrity verification. The [earlier source comparison](docs/admin-source-comparison.md) explains its relationship to `garageDoorController`. Python is historical reference; ongoing development is Node.js. No new software license is granted by this extraction.
