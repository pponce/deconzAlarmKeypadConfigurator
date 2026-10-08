"""Prepare an isolated Linux installation from a stopped existing administrator.

No service installation/start, network access, device commands or source edits.
The generated units and private configuration are reviewed before activation.
"""
import argparse
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
from urllib.parse import urlsplit
from configurator.common import atomic, loads, require
from configurator.configuration import read, validate
from configurator.setup import activate
from configurator.package import build


def regular(path, maximum=4 * 1024 * 1024):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'migration_path_invalid')
    meta = path.lstat()
    require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and meta.st_size <= maximum,
            'migration_file_invalid')
    return path


def private_copy(source, target, maximum=4 * 1024 * 1024):
    source = regular(source, maximum)
    with source.open('rb') as incoming, target.open('xb') as outgoing:
        os.chmod(target, 0o600)
        shutil.copyfileobj(incoming, outgoing)
        outgoing.flush(); os.fsync(outgoing.fileno())


def prepare(broker_path, web_path, identity_path, destination, origin, port, bind, scopes, management_port=27773):
    destination = Path(destination)
    require(destination.is_absolute() and destination.resolve() == destination and
            re.fullmatch(r'[A-Za-z0-9_./-]+', str(destination)) and not destination.exists(), 'new_destination_required')
    base = read(broker_path)
    old = activate(base)
    source_state = Path(old['state'])
    web = loads(regular(web_path).read_bytes())
    identity = loads(regular(identity_path, 1024).read_bytes())
    require(isinstance(identity, dict) and set(identity) >= {'instanceId','token'}, 'coordinator_identity_invalid')
    url = urlsplit(origin)
    require(url.scheme == 'https' and url.hostname and not url.username and not url.password and
            not url.path and not url.query and not url.fragment and 1024 <= port <= 65535 and
            (url.port or 443) == port, 'installation_origin_invalid')
    require(isinstance(web, dict) and {'salt','password_hash','cert','key'} <= set(web), 'web_configuration_invalid')
    for marker in ('integration-pending.json', 'web-account.json.new'):
        require(not (source_state / marker).exists(), 'finish_existing_recovery_before_migration')
    for file in source_state.glob('transaction-*.json'):
        require(loads(regular(file).read_bytes()).get('stage') == 'complete', 'finish_existing_recovery_before_migration')
    lease = source_state / 'homebridge-maintenance.json'
    if lease.exists():
        # Completed leases are handled by the retained adapter. A pending lease
        # must be resolved with the old application before transferring state.
        value = loads(regular(lease).read_bytes())
        require(value.get('complete') is True, 'finish_existing_homebridge_recovery_before_migration')
    registrations = {g['id']: g for g in old['gateways']}
    mappings = []
    for scope in scopes:
        parts = scope.split(':')
        require(len(parts) == 3 and parts[0] in registrations and parts[1].isdigit(), 'migration_scope_invalid')
        mappings.append({'gateway': parts[0], 'identity': registrations[parts[0]]['identity'],
                         'alarm': int(parts[1]), 'controller': parts[2]})
    # Hold the source broker's normal ownership lock throughout the copy. This
    # prevents an accidental restart while files are being transferred.
    with ExitStack() as stack:
        lock = stack.enter_context((source_state / 'broker.lock').open('a'))
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('stop_existing_broker_before_migration') from None
        destination.mkdir(mode=0o711)
        try:
            for name in ('state','backups','private','web','run','units'):
                (destination / name).mkdir(mode=0o700)
            build(destination / 'app')
            (destination / 'app').chmod(0o755)
            # Web needs only source, its own TLS/login configuration and the
            # authenticated broker socket; no coordinator/device credentials.
            for folder in (destination / 'app').rglob('*'):
                if folder.is_dir(): folder.chmod(0o755)
            exact = {'web-account.json','application.local.json','activity-retention.local.json',
                     'identities.json','first-run.json','deployment.json','homebridge-registration.json','host-helper-registration.json'}
            for source in source_state.iterdir():
                if source.name in exact or re.fullmatch(r'transaction-[a-z][a-z0-9-]{0,31}\.json', source.name):
                    private_copy(source, destination / 'state' / source.name)
                elif re.fullmatch(r'activity-[a-z][a-z0-9-]{0,31}-alarm-[0-9]{1,3}\.sqlite', source.name):
                    regular(source, 2 * 1024**3)
                    target = destination / 'state' / source.name
                    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as incoming, sqlite3.connect(target) as outgoing:
                        incoming.backup(outgoing)
                    target.chmod(0o600)
            # Preserve backup receipts/data in an independent directory. Bound
            # the transfer and reject links/devices rather than copying blindly.
            old_backups = Path(old['backup_root']) if old.get('backup_root') else None
            total = 0
            if old_backups:
                for source in sorted(old_backups.rglob('*')):
                    require(not source.is_symlink(), 'backup_link_requires_review')
                    target = destination / 'backups' / source.relative_to(old_backups)
                    if source.is_dir(): target.mkdir(mode=0o700)
                    else:
                        regular(source, 2 * 1024**3); total += source.stat().st_size
                        require(total <= 4 * 1024**3, 'backup_transfer_limit_requires_review')
                        private_copy(source, target, 2 * 1024**3)
            token_path = destination / 'private/coordinator-token.json'
            atomic(token_path, {'token': identity['token']})
            config = {**old, 'schema': 2, 'state': str(destination / 'state'), 'backup_root': str(destination / 'backups'),
                      'socket': str(destination / 'run/broker.sock'), 'extensions': [],
                      'coordinator': {'base_url': 'http://127.0.0.1:' + str(management_port),
                                      'token_file': str(token_path), 'instance_id': identity['instanceId'], 'scopes': mappings}}
            validate(config)
            atomic(destination / 'private/broker.json', config)
            private_copy(web['cert'], destination / 'web/tls.crt')
            private_copy(web['key'], destination / 'web/tls.key')
            web_config = {k: web[k] for k in ('salt','password_hash','username') if k in web}
            web_config.update(bind=bind, port=port, origin=origin, socket=config['socket'],
                              cert=str(destination / 'web/tls.crt'), key=str(destination / 'web/tls.key'))
            atomic(destination / 'web/web.json', web_config)
            web_uid, web_gid = old['web_uid'], old['web_gid']
            require(os.geteuid() == 0 or (web_uid == os.geteuid() and web_gid == os.getegid()), 'web_identity_requires_root')
            for path in [destination / 'web', *(destination / 'web').iterdir()]: os.chown(path, web_uid, web_gid)
            os.chown(destination / 'run', os.geteuid(), web_gid); (destination / 'run').chmod(0o750)
            def unit(name, module, config_path, uid, gid, extra=''):
                text = ('[Unit]\nDescription=Garage coordinator '+name+'\nAfter=network.target\n'+extra+
                        '\n[Service]\nType=simple\nUser='+str(uid)+'\nGroup='+str(gid)+'\nWorkingDirectory='+str(destination / 'app')+
                        '\nExecStart='+sys.executable+' -B -m '+module+' --config '+str(config_path)+
                        '\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n')
                (destination / 'units' / ('gdoor-admin-'+name+'.service')).write_text(text)
            unit('broker','configurator.broker',destination / 'private/broker.json',os.geteuid(),os.getegid())
            unit('web','configurator.server',destination / 'web/web.json',web_uid,web_gid,'Requires=gdoor-admin-broker.service\nAfter=gdoor-admin-broker.service\n')
            atomic(destination / 'private/migration.json', {'schema':1,'source_broker':str(broker_path),'source_state':str(source_state),
                  'source_unchanged':True,'services_started':False,'preserved_host_helper':bool(old.get('host_helper'))})
        except BaseException:
            # Leave private partial data for inspection. Never erase the source
            # or reuse a partially prepared destination as a successful install.
            raise
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('broker','web','coordinator-identity','destination','origin'):
        parser.add_argument('--'+flag, required=True)
    parser.add_argument('--port', type=int, default=8788)
    parser.add_argument('--bind', default='0.0.0.0')
    parser.add_argument('--scope', action='append', default=[], help='gateway-id:alarm-number:controller-id')
    parser.add_argument('--management-port', type=int, default=27773)
    args = parser.parse_args()
    try:
        require(1024 <= args.management_port <= 65535, 'management_port_invalid')
        destination = prepare(Path(args.broker),Path(args.web),Path(args.coordinator_identity),Path(args.destination),args.origin,args.port,args.bind,args.scope,args.management_port)
        print('Prepared installation at '+str(destination)+'. No services were installed or started. Review docs/owner-test.md before activation.')
    except Exception:
        # No config, password hashes, tokens, gateway URLs or device keys.
        print('Preparation stopped. Check source ownership, stopped services, completed maintenance, paths and scope mappings. A partial destination must be reviewed before retrying.', file=sys.stderr)
        raise SystemExit(1) from None

if __name__ == '__main__': main()
