"""Private web-login verifier storage, reachable only over the web-peer broker socket.

No plaintext passwords, gateway keys, service control or browser-readable hashes.
The immutable installer verifier is used only until the first persisted change.
"""
import json
import os
from pathlib import Path
import re
from .common import loads, require
from .setup import private_load


def validate(value):
    if isinstance(value, dict) and value.get('schema') == 2:
        require(set(value) == {'schema','revision','accounts'} and type(value['revision']) is int and value['revision'] > 0,
                'web_account_invalid')
        rows = value['accounts']
        require(isinstance(rows, list) and 1 <= len(rows) <= 64, 'web_account_invalid')
        ids, names = set(), set()
        for row in rows:
            require(isinstance(row, dict) and set(row) == {'id','username','role','enabled','salt','password_hash'}, 'web_account_invalid')
            require(isinstance(row['id'], str) and re.fullmatch('[0-9a-f]{32}', row['id']) and row['id'] not in ids,
                    'web_account_invalid')
            username(row['username'])
            require(row['username'].casefold() not in names, 'username_in_use')
            require(row['role'] in ('admin','regular') and type(row['enabled']) is bool, 'web_account_invalid')
            validate({'schema':1,'revision':1,'salt':row['salt'],'password_hash':row['password_hash']})
            ids.add(row['id']); names.add(row['username'].casefold())
        require(any(r['enabled'] and r['role'] == 'admin' for r in rows), 'last_admin_required')
        return value
    require(isinstance(value, dict) and set(value) == {'schema', 'revision', 'salt', 'password_hash'} and
            value['schema'] == 1 and type(value['revision']) is int and value['revision'] > 0 and
            isinstance(value['salt'], str) and re.fullmatch('[0-9a-f]{32}', value['salt']) and
            isinstance(value['password_hash'], str) and re.fullmatch('[0-9a-f]{128}', value['password_hash']),
            'web_account_invalid')
    return value


def username(value):
    require(isinstance(value, str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,63}', value), 'username_invalid')
    return value


def read(state):
    path = Path(state) / 'web-account.json'
    require(not os.path.lexists(str(path) + '.new'), 'web_account_pending_review')
    if not os.path.lexists(path): return None
    require(path.stat().st_nlink == 1, 'web_account_invalid')
    return validate(private_load(path))


def dispatch(state, operation, body):
    current = read(state)
    if operation == 'web_auth_read':
        require(not body, 'invalid_request'); return current
    require(operation == 'web_auth_change' and set(body) in ({'expected_revision', 'salt', 'password_hash'},
                                                           {'expected_revision','accounts'}), 'invalid_request')
    expected = current['revision'] if current else None
    require(body['expected_revision'] == expected and type(body['expected_revision']) is type(expected), 'web_account_changed')
    if 'accounts' in body:
        value = validate({'schema':2,'revision':(expected or 0)+1,'accounts':body['accounts']})
    else:
        require(current is None or current['schema'] == 1, 'web_account_downgrade_forbidden')
        value = validate({'schema': 1, 'revision': (expected or 0) + 1,
                          'salt': body['salt'], 'password_hash': body['password_hash']})
    path = Path(state) / 'web-account.json'; temporary = Path(str(path) + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
    return {'revision': value['revision']}
