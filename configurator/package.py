"""Build an isolated development source bundle; not a host installer."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

FILES = ('__init__.py', 'activity.py', 'authorization.py', 'backup.py', 'broker.py', 'collector.py', 'common.py', 'configuration.py', 'core.py', 'credential_evidence.py', 'debug.py', 'deployment.py', 'domain.py', 'domain_methods.py', 'editing.py', 'extensions.py', 'gateway.py', 'history.py', 'homebridge.py', 'homebridge_local.py', 'homebridge_probe.py', 'homebridge_sources.py', 'host_client.py', 'host_service.py', 'keypad_core.py', 'observe.cjs', 'presentation.py', 'schedule.py', 'server.py', 'setup.py', 'static/app-icon-192.png', 'static/app-icon-512.png', 'static/app-icon.svg', 'static/app.js', 'static/apple-touch-icon.png', 'static/demo.js', 'static/homebridge-flow.js', 'static/index.html', 'static/install.html', 'static/install.js', 'static/installation-help.html', 'static/keypad.js', 'static/manifest.webmanifest', 'static/settings.js', 'static/setup-app.js', 'static/setup-style.css', 'static/setup.html', 'static/style.css', 'static/welcome.css', 'static/welcome.html', 'static/welcome.js', 'transactions.py', 'virtual_keypad.py', 'web_account.py', 'package.py')
ADAPTER_FILES = ('__init__.py', 'client.py', 'integration.py', 'static/index.html', 'static/app.js', 'static/style.css', 'static/editor.js', 'static/editor.css', 'install.py')


def build(destination):
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    root = Path(__file__).resolve().parents[1]
    hashes = {}
    for package, names in [('configurator', FILES), ('coordinator_admin', ADAPTER_FILES)]:
        for name in names:
            source = root / package / name
            if source.is_symlink() or not source.is_file():
                raise ValueError('package_source_invalid')
            target = destination / package / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o644)
            hashes[package + '/' + name] = hashlib.sha256(target.read_bytes()).hexdigest()
    (destination / 'manifest.json').write_text(json.dumps({
        'schema': 1, 'profile': 'coordinator-admin-development', 'files': hashes}, indent=2)+'\n')
    return hashes


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', type=Path)
    build(parser.parse_args().destination)
