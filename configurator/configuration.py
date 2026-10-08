"""Application-owned configuration; no discovery of other applications."""
import os
from pathlib import Path
import re
from urllib.parse import urlsplit
from .common import loads, require


def directory(value):
    require(isinstance(value, str), 'invalid_directory')
    path = Path(value)
    require(path.is_absolute() and path.resolve() == path and path.is_dir(), 'invalid_directory')
    require(path.stat().st_uid == os.geteuid() and path.stat().st_mode & 0o077 == 0, 'private_directory_required')
    return path


def validate(value):
    fields = {'schema','state','socket','web_uid','web_gid','node','gateways','homebridge','extensions','access_mode'}
    require(isinstance(value, dict) and type(value.get('schema')) is int and value['schema'] in (1,2), 'configuration_version_unsupported')
    optional={'coordinator'} | ({'database_backups','host_helper'} if value['schema']==2 else set())
    require(fields | ({'backup_root'} if value['schema']==2 else set()) == set(value)-optional, 'configuration_invalid')
    directory(value['state'])
    require(value['access_mode'] == 'observe' or value['schema'] == 2 and value['access_mode'] == 'manage', 'candidate_read_only_required')
    if value['schema'] == 2:
        directory(value['backup_root'])
        state, backup = Path(value['state']), Path(value['backup_root'])
        require(not state.is_relative_to(backup) and not backup.is_relative_to(state), 'separate_backup_directory_required')
    if value['homebridge'] is not None:
        from .homebridge import validate as validate_homebridge
        validate_homebridge(value['homebridge'], value['gateways'])
    from .extensions import declarations
    declarations(value['extensions'])
    require(all(type(value[k]) is int and value[k] >= 0 for k in ('web_uid','web_gid')), 'web_identity_invalid')
    socket = Path(value['socket'])
    require(socket.is_absolute() and socket.resolve() == socket and socket.parent.is_dir(), 'socket_path_invalid')
    node = Path(value['node'])
    require(node.is_absolute() and node.is_file(), 'node_runtime_required')
    validate_gateways(value['gateways'])
    if 'coordinator' in value:
        from coordinator_admin.integration import validate_connection
        validate_connection(value['coordinator'], value['gateways'])
    if 'host_helper' in value:
        helper=value['host_helper']
        require(isinstance(helper,dict) and set(helper)=={'socket'} and isinstance(helper['socket'],str) and
                Path(helper['socket']).is_absolute() and Path(helper['socket']).resolve()==Path(helper['socket']),'host_helper_configuration_invalid')
    if 'database_backups' in value:
        from .backup import profiles
        profiles(value['database_backups'],value['gateways'])
    return value


def read(path):
    path=Path(path)
    require(path.resolve()==path and path.is_file() and path.stat().st_uid==os.geteuid() and
            path.stat().st_mode & 0o077==0,'private_configuration_required')
    require(path.stat().st_size<=65536,'configuration_too_large')
    return validate(loads(path.read_bytes()))


def validate_gateways(rows):
    require(isinstance(rows,list) and len(rows)<=16, 'gateway_registry_invalid')
    ids=set(); identities=set()
    for row in rows:
        require(isinstance(row,dict) and set(row)=={'id','name','identity','endpoint','key'}, 'gateway_registry_invalid')
        require(isinstance(row['id'],str) and re.fullmatch('[a-z][a-z0-9-]{0,31}',row['id']) and row['id'] not in ids,'gateway_id_invalid')
        require(isinstance(row['identity'],str) and re.fullmatch('[0-9A-F]{16}',row['identity']) and row['identity'] not in identities,'gateway_identity_invalid')
        require(isinstance(row['name'],str) and 0<len(row['name'])<=64,'gateway_name_invalid')
        require(isinstance(row['key'],str) and re.fullmatch('[A-Za-z0-9_-]{1,128}',row['key']), 'gateway_key_invalid')
        require(isinstance(row['endpoint'],str), 'gateway_endpoint_invalid')
        u=urlsplit(row['endpoint'])
        require(u.scheme in ('http','https') and u.hostname and u.path in ('','/') and
                not u.username and not u.password and not u.query and not u.fragment,'gateway_endpoint_invalid')
        require(u.port is None or 1<=u.port<=65535,'gateway_endpoint_invalid')
        ids.add(row['id']);identities.add(row['identity'])
