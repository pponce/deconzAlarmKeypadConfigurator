"""Small wire protocol. No raw error strings cross privilege or HTTP boundaries."""
import json
import os
from pathlib import Path
import socket

LIMIT = 65536
RESPONSE_LIMIT = 16 * 1024 * 1024  # Global identities/grants can exceed request size.
class Rejected(Exception):
    pass

def require(ok, reason='request_rejected'):
    if not ok:
        raise Rejected(reason)

def loads(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate_fields')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: require(False, 'invalid_number'))

def atomic(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def rpc(path, operation, body):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(150)
        connection.connect(str(path))
        connection.sendall(json.dumps({'operation': operation, 'body': body}, allow_nan=False).encode() + b'\n')
        raw = connection.makefile('rb').readline(RESPONSE_LIMIT + 1)
        require(len(raw) <= RESPONSE_LIMIT, 'response_too_large')
        reply = loads(raw)
        if 'error' in reply:
            raise Rejected(reply['error'])
        return reply['data']

