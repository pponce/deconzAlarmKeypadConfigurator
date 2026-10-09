# deCONZ Alarm / Keypad Configurator

**[Try the interactive demo](https://pponce.github.io/deconzAlarmKeypadConfigurator/)** · [Demo source and Pages setup](demo/README.md)

The demo runs entirely in your browser with fictional data. No deCONZ gateway, Homebridge or sign-in is needed. The hosted link becomes available once GitHub Pages is enabled.

A standalone Node.js web interface for managing deCONZ alarm users, PINs, keypad access and schedules. It is intended for people who want these administration features **without running Homebridge**.

## Project status

I actively use [homebridge-gdoor-admin-controller](https://github.com/pponce/homebridge-gdoor-admin-controller), which combines a Homebridge garage-door/bolt controller with the web administration interface.

**I am not currently running or actively testing this standalone version on my own setup.** I wanted to share it for anyone who would like to test it, extend it or help develop it further. It has automated tests, but should be treated as development software that needs testing on real installations.

The `main` branch contains the runnable Node.js application.

## What it does

- Create web accounts with administrator or regular-user permissions.
- Create and manage deCONZ alarm users and their individual PINs.
- Set access rights for each alarm, including arm/disarm permissions and which keypads a user can use.
- Set weekly schedules, validity dates and usage allowances.
- Configure alarm settings, failed-PIN lockout rules and keypad lockout resets.
- View activity history and use a virtual keypad in the browser.
- Optionally update the alarm PIN used by Homebridge-deCONZ.

Web accounts are separate from deCONZ alarm users: a web account signs in to this interface; an alarm user has a PIN and access permissions.

The virtual keypad communicates **directly with deCONZ**. It does not require Homebridge. This application does not include garage-door or bolt-control logic.

## Requirements

| Requirement | Details |
| --- | --- |
| **deCONZ** | A running deCONZ gateway with a compatible Zigbee coordinator, reachable from the machine running this server. |
| **Custom deconz-rest-plugin** | The alarm-user and keypad-access changes described in [deCONZ PR #8661](https://github.com/dresden-elektronik/deconz-rest-plugin/pull/8661) must be installed. A standard installation without these changes does not provide the APIs this application needs. |
| **Xfinity keypad** | An Xfinity/Comcast keypad paired with deCONZ and assigned to an alarm. The current hardware reference is the **URC4450BC0-X-R**, with the matching keypad definition included in the custom plugin. |
| **Server** | A Linux machine with Node.js **22.13 or later within the 22.x series, or Node.js 24.x**, npm and OpenSSL. Linux is the initial target platform. |
| **deCONZ API key** | An API key for this application to access your gateway. This is separate from an alarm PIN or Phoscon password. |

The custom deCONZ changes are available in [pponce/deconz-rest-plugin, branch alarm-users-upstream](https://github.com/pponce/deconz-rest-plugin/tree/alarm-users-upstream). See its [alarm users and access grants documentation](https://github.com/pponce/deconz-rest-plugin/blob/alarm-users-upstream/doc/alarm-users.md) for the API and installation considerations. The upstream PR is still open; do not assume these features are included in a standard deCONZ release.

### Other keypads

The access-policy functionality uses deCONZ's alarm and IAS ACE interfaces, so it can be adapted for other compatible keypads. Different models may need keypad-definition or event-handling changes and hardware testing. The Xfinity model above is the hardware reference; other models are not claimed as tested.

## Getting started

After the deCONZ requirements are in place:

```sh
git clone https://github.com/pponce/deconzAlarmKeypadConfigurator.git
cd deconzAlarmKeypadConfigurator
npm install --ignore-scripts
npm run setup
npm start
```

Setup runs in a local terminal. It asks for the web address, listening address, deCONZ connection and API key, and your first web administrator username and password. Passwords and API keys are hidden while entered.

The default web address is `https://localhost:9443`, accessible only from the server itself. To access it from another device, enter the server's LAN HTTPS address during setup and use `0.0.0.0` as the listening address. Open exactly the configured address in your browser. The server generates a self-signed certificate, which you will need to trust separately.

After signing in, use **Settings → Security** to manage web accounts and **Settings → Connections** to edit gateway connections. Connection changes require restarting this server.

Application data is stored under `~/.local/share/deconz-keypad-configurator`, separately from the source code. To choose another private directory, pass the same `--data-dir /absolute/private/path` to both setup and start:

```sh
npm run setup -- --data-dir /absolute/private/path
npm start -- --data-dir /absolute/private/path
```

## Optional Homebridge integration

**Homebridge is not required.** If you already use Homebridge with `homebridge-deconz`, the optional integration lets you select the deCONZ user and PIN used by its alarm accessories.

The current integration requires Homebridge on the same Linux host, `homebridge-deconz` in its own child bridge, and a Homebridge UI accepting local HTTP connections. Run this server as the same operating-system account as Homebridge so it can access the necessary files. New PIN updates use the official homebridge-deconz API and its UI discovery command; they do not require exact dependency versions, source fingerprints or accessory-file edits.

With this admin server stopped, run:

```sh
node bin/deconz-keypad-admin.js homebridge
```

Provide the Homebridge storage directory, its `config.json` path and the installed `homebridge-deconz` package directory, then restart this server. Include your `--data-dir` option if you use one.

A synchronized PIN update asks for your confirmation and a Homebridge administrator login. It updates and verifies the running PIN without restarting Homebridge. Homebridge saves the setting on its normal schedule. The confirmation window explains PIN logging and offers optional clearing of the current Homebridge log after success.

In the user editor, **Use for homebridge** appears below **Enabled on this gateway**. The guidance above the PIN fields changes with that selection. Leave both PIN fields blank to keep the current PIN when saving other user edits.

If an update is interrupted, reopen **Continue Homebridge update**. When the saved record confirms that no PIN write was attempted, **Cancel PIN change and restore service** restores the child bridge and closes the pending operation after verification. Otherwise, continue the saved checks without repeating the PIN change. The screen identifies failed checks, and the server allows time for the child bridge's device API to become reachable after restarting. Homebridge authorization may be requested again; passwords are not saved. New updates retain one small private PIN recovery record, replaced by the next prepared update. It does not back up the deCONZ gateway’s old PIN or provide automatic rollback of both systems. See [Homebridge PIN updates](docs/homebridge-pin.md) for persistence, log clearing and legacy recovery details.


## Testing and contributions

Testing on real installations, bug reports and contributions are welcome—particularly setup feedback and support for other keypads. Please include relevant software versions and keypad models when reporting issues, and remove API keys, passwords and PINs from anything you share.

Run the automated tests with:

```sh
npm test
```

The code also provides a programmatic extension interface for future integrations. No controller add-on is included.
