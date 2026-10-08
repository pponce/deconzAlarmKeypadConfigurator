# deCONZ Keypad/Alarm Administration for the Homebridge Coordinator

The standalone web administrator for the [garage-door/bolt coordinator](https://github.com/pponce/homebridge-gDoorAndBolt-coordinator), preserving the existing interface, its own URL and Admin/Regular accounts. **It is not a Homebridge plugin in phase 1.**

**Status: ready for initial supervised owner testing.** The full existing interface is retained. Its Controller page now manages the coordinator's settings, commands, recovery and activity; virtual keypad and maintenance use the operational API. The coordinator provides the modern guided profile editor shared here. Start with the [installation and test guide](docs/owner-test.md); [validated revisions and limits](docs/status.md) are recorded separately.

The owner will stop the existing administrator and switch to this version when both projects are ready. Supporting simultaneous administrators or adapting the old installation is not required.

## Development checks

Python 3.10+ and Node 22/24; no Python dependencies are needed for these checks:

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 -m unittest discover -s configurator/tests -p 'test_*.py' -v
python3 tests/cross_repo.py ../homebridge-gDoorAndBolt-coordinator
```

Browser checks use Playwright 1.58.2 with Chromium and WebKit and launch only synthetic loopback fixtures. GitHub Actions runs the retained desktop/mobile UI scenarios and tests/coordinator_browser.cjs. They never access a real gateway, Homebridge installation, opener or bolt.

`python3 -m configurator.package /new/empty/development-bundle` creates an isolated source bundle, not a host installation. The original install/update scripts were deliberately not imported. The new `python3 -m coordinator_admin.install` prepares an isolated installation and state transfer; it never starts services. See docs/owner-test.md.

See the [implementation plan](docs/implementation-plan.md), [migration plan](docs/migration.md), [development connection contract](docs/coordinator-integration.md), [API contract](docs/api-v1.md), [UX parity checklist](docs/ux-parity.md), and [status](docs/status.md).
