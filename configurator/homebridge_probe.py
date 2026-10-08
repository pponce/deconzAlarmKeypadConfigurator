"""Fingerprint public plugin sources without executing JavaScript."""
import hashlib
import json
from pathlib import Path
import re

FILES = {
    'homebridge-deconz': ('lib/DeconzService/AlarmSystem.js',
        'lib/DeconzAccessory/index.js', 'lib/DeconzAccessory/Gateway.js',
        'lib/DeconzPlatform.js', 'cli/ui.js'),
    'homebridge-lib': ('lib/CharacteristicDelegate.js', 'lib/Platform.js',
        'lib/ServiceDelegate.js', 'lib/AccessoryDelegate.js', 'lib/Delegate.js'),
}

def inspect_package(root, name):
    package = json.loads((root / 'package.json').read_bytes())
    if package.get('name') != name:
        raise ValueError('wrong_package')
    version = package.get('version')
    if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', version):
        raise ValueError('invalid_version')
    files = {}
    for relative in FILES[name]:
        path = root / relative
        data = path.read_bytes()
        if len(data) > 1024 * 1024:
            raise ValueError('source_too_large')
        files[relative] = hashlib.sha256(data).hexdigest()
    return {'package': name, 'version': version, 'source_sha256': files}

def inspect(root):
    plugin = inspect_package(root, 'homebridge-deconz')
    # Follow Node's nearest-parent node_modules resolution; do not execute JS.
    candidates = [root / 'node_modules/homebridge-lib']
    candidates += [p / 'node_modules/homebridge-lib' for p in root.parents
                   if p.name != 'node_modules']
    library = next((p for p in candidates if (p / 'package.json').is_file()), None)
    return {'plugin': plugin, 'library': inspect_package(library, 'homebridge-lib')
            if library else None, 'loaded_runtime_verified': False}

