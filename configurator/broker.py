"""Finite read-only RPC broker. No service control or integration imports."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
from .common import LIMIT, Rejected, loads, require
from .configuration import read
from .core import Core


def serve(config):
    from .collector import Collector
    os.umask(0o077)
    path = Path(config['socket'])
    # A second broker must not unlink the first broker's socket or share its state.
    with open(Path(config['state']) / 'broker.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        core = Core(config)
        if path.exists():
            require(path.is_socket() and not path.is_symlink() and path.stat().st_uid == os.geteuid(), 'socket_path_invalid')
            path.unlink()
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                try:
                    self.request.settimeout(10)
                    _, uid, _ = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    require(uid == config['web_uid'], 'peer_not_allowed')
                    raw = self.rfile.readline(LIMIT + 1)
                    require(len(raw) <= LIMIT and raw.endswith(b'\n'), 'request_too_large')
                    message = loads(raw)
                    require(isinstance(message, dict) and set(message) == {'operation', 'body'}, 'invalid_request')
                    result = {'data': core.dispatch(message['operation'], message['body'])}
                except Rejected as error: result = {'error': str(error)}
                except Exception: result = {'error': 'operation_failed_private_details_omitted'}
                try: self.wfile.write(json.dumps(result, allow_nan=False).encode() + b'\n')
                except Exception: pass
        class Server(socketserver.UnixStreamServer):
            def handle_error(self, *_): pass
        with Server(str(path), Handler) as server:
            os.chown(path, os.geteuid(), config['web_gid'])
            os.chmod(path, 0o660)
            collector = Collector(core)
            collector.start()
            try: server.serve_forever()
            finally: collector.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    try: serve(read(args.config))
    except Exception: raise SystemExit('Broker startup failed; private details omitted.') from None


if __name__ == '__main__': main()
