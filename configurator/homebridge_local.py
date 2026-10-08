"""Reviewed local Homebridge cache primitives, independent of private modules."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from .common import loads, require, Rejected

SECURITY = '0000007E-0000-1000-8000-0026BB765291'
HOME = Path('/var/lib/homebridge')

def validate_pin(value):
    require(isinstance(value, str) and re.fullmatch('[0-9]{4,16}', value), 'invalid_pin')

def eligible(user):
    return (user.get('enabled') is True and user.get('grant_enabled') is True and
            user.get('arm') is True and user.get('disarm') is True and user.get('api_arm_disarm') is True and
            user.get('remaining_uses') is None and user.get('schedule') is None)


def private_read(path):
    require(path.resolve() == path and path.is_file(), 'homebridge_file_path_invalid')
    st = path.stat()
    require(not st.st_mode & 0o022 and st.st_size <= 16*1024*1024, 'homebridge_file_permissions_invalid')
    return path.read_bytes()


def cache_path(config, root=HOME):
    rows = [p for p in config.get('platforms', []) if p.get('platform') == 'deCONZ']
    require(len(rows) == 1 and isinstance(rows[0].get('_bridge'), dict), 'one_homebridge_child_bridge_required')
    username = rows[0]['_bridge'].get('username', '')
    require(re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}', username) is not None,
            'homebridge_child_identity_invalid')
    require('homebridge-deconz' not in config.get('disabledPlugins', []) and
            ('plugins' not in config or 'homebridge-deconz' in config['plugins']), 'homebridge_plugin_disabled')
    return root / 'accessories' / ('cachedAccessories.' + username.replace(':', '').upper())


def gateway_port(rows, gid):
    gateways = [x for x in rows if x.get('platform') == 'deCONZ' and
                x.get('context', {}).get('className') == 'Gateway' and x['context'].get('id') == gid]
    require(len(gateways) == 1, 'homebridge_gateway_identity_changed')
    port = gateways[0]['context'].get('uiPort')
    require(type(port) is int and 1024 <= port <= 65535, 'homebridge_ui_port_invalid')
    return port


def pin_context(rows, gid, accessory):
    matches = [x for x in rows if x.get('platform') == 'deCONZ' and
               x.get('context', {}).get('id') == accessory and
               x['context'].get('context', {}).get('gid') == gid]
    require(len(matches) == 1, 'homebridge_accessory_identity_changed')
    row = matches[0]
    services = [s for s in row.get('services', []) if s.get('UUID') == SECURITY]
    require(len(services) == 1, 'one_homebridge_alarm_service_required')
    key = SECURITY + ('.' + str(services[0]['subtype']) if services[0].get('subtype') is not None else '')
    context = row['context'].get(key)
    require(isinstance(context, dict), 'homebridge_cache_schema_unsupported')
    validate_pin(context.get('pin'))
    return context


def edited_cache(raw, gid, accessory, pin):
    validate_pin(pin)
    value = loads(raw)
    pin_context(value, gid, accessory)['pin'] = pin
    return json.dumps(value, ensure_ascii=False, allow_nan=False).encode()


def replace_cache(path, expected, value):
    require(private_read(path) == expected, 'homebridge_cache_changed')
    meta = path.stat()
    tmp = path.with_name(path.name + '.configurator-new')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(value)
            os.fchown(stream.fileno(), meta.st_uid, meta.st_gid)
            # Cache contains credentials: retain or tighten to owner-only.
            os.fchmod(stream.fileno(), 0o600)
            stream.flush(); os.fsync(stream.fileno())
        require(private_read(path) == expected, 'homebridge_cache_changed')
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if tmp.exists(): tmp.unlink()


def run(*args):
    # Never put a PIN in argv, environment, stdout, stderr or exception messages.
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=200,
                            env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
    require(result.returncode == 0, 'homebridge_service_operation_failed')



def stopped(pid, timeout=30):
    """Wait for service teardown; never repeat the stop command."""
    deadline = time.monotonic() + timeout
    while True:
        result = subprocess.run(
            ['systemctl', 'show', 'homebridge.service', '--property=ActiveState,MainPID'],
            capture_output=True, timeout=5)
        fields = dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)
        if (result.returncode == 0 and fields.get('ActiveState') == 'inactive' and
                fields.get('MainPID') == '0' and not Path('/proc', str(pid)).exists()):
            return
        require(time.monotonic() < deadline, 'homebridge_stop_not_confirmed')
        time.sleep(.25)


def listener_owner(port):
    """Require the loopback UI socket to belong to this Homebridge service."""
    address = '0100007F:' + format(port, '04X')
    lines = Path('/proc/net/tcp').read_text().splitlines()[1:]
    sockets = [line.split()[9] for line in lines if line.split()[1] == address and line.split()[3] == '0A']
    require(len(sockets) == 1, 'homebridge_listener_unverified')
    owners = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit(): continue
        try:
            if any(os.readlink(p) == 'socket:[' + sockets[0] + ']' for p in (proc/'fd').iterdir()):
                command = (proc/'cmdline').read_bytes().lower()
                group = (proc/'cgroup').read_text()
                require(b'homebridge' in command and b'deconz' in command and
                        '/homebridge.service' in group, 'homebridge_listener_unverified')
                owners.append(int(proc.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    require(len(owners) == 1, 'homebridge_listener_unverified')
    return owners[0]


