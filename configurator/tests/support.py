import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import struct
import threading
from configurator.domain import ALARM_TIMINGS

IDENTITY = '0011223344556677'
USER = 'a'*32


def config(root, gateways=None):
    state = root / 'state'; state.mkdir(mode=0o700, exist_ok=True)
    return {'schema': 1, 'state': str(state), 'socket': str(root/'broker.sock'),
            'web_uid': os.geteuid(), 'web_gid': os.getegid(), 'node': shutil.which('node'),
            'gateways': gateways or [], 'homebridge': None, 'extensions': [], 'access_mode': 'observe'}


class FakeGateway:
    def __init__(self, bind='127.0.0.1'):
        self.identity = IDENTITY; self.capability = 2; self.requests = []
        self.names = 'Test user'; self.alarm_ids = ['1', '2']
        self.writer = None
        self.ws_clients = []; self.ws_connections = 0
        fixture = self
        class Websocket(socketserver.StreamRequestHandler):
            def handle(self):
                self.request.settimeout(5)
                self.rfile.readline()
                headers = {}
                while True:
                    line = self.rfile.readline().decode().strip()
                    if not line: break
                    key, value = line.split(':', 1); headers[key.lower()] = value.strip()
                accept = base64.b64encode(hashlib.sha1((headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                self.wfile.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n').encode())
                fixture.ws_clients.append(self.request); fixture.ws_connections += 1
                try:
                    self.request.settimeout(None)
                    while self.request.recv(1024): pass
                except OSError: pass
        class WS(socketserver.ThreadingTCPServer):
            daemon_threads = True; allow_reuse_address = True
        self.ws = WS((bind,0), Websocket)
        class HTTP(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                fixture.requests.append(('GET',self.path))
                data = fixture.response(self.path.removeprefix('/api/test-key'))
                raw = json.dumps(data).encode(); self.send_response(200)
                self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
            def do_POST(self):
                fixture.requests.append((self.command,self.path))
                if fixture.writer is None: self.send_error(500); return
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                value=fixture.writer(self.path.removeprefix('/api/test-key'),self.command,body)
                raw=json.dumps(value).encode();self.send_response(200)
                self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
            do_PUT=do_POST;do_DELETE=do_POST
        self.http = ThreadingHTTPServer((bind,0), HTTP)
        self.threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (self.ws,self.http)]
        for t in self.threads:t.start()

    def registration(self, gid='test'):
        return {'id':gid,'name':'Test gateway','identity':IDENTITY,
                'endpoint':'http://127.0.0.1:'+str(self.http.server_port),'key':'test-key'}

    def response(self, path):
        if path=='/config':return {'bridgeid':self.identity,'websocketport':self.ws.server_address[1], 'password':'never-project'}
        if path=='/sensors':return {'3':{'type':'ZHAAncillaryControl','name':'Test keypad','uniqueid':'test-device'}}
        alarm={'name':'Test alarm','devices':{'test-device':{}},
               'config':{'armmode':'disarmed',**{k:0 for k in ALARM_TIMINGS}},
               'state':{'armstate':'disarmed','seconds_remaining':0}}
        if path=='/alarmsystems':return {aid:alarm for aid in self.alarm_ids}
        if path.endswith('/capabilities'):return {'global_users_version':self.capability,'managed':True,'alarm_timing_version':1}
        if path.endswith('/users'):return {USER:{'id':USER,'name':self.names,'enabled':True,'user_revision':1,
            'remaining_uses':None,'revision':1,'api_arm_disarm':True,'grant_enabled':True,'owner':True,
            'arm':True,'disarm':True,'all_keypads':True,'keypads':[],'schedule':None,'pin':'never-project'}}
        if path in ('/alarmsystems/1','/alarmsystems/2'):return alarm
        return {}

    def emit(self, value):
        raw=json.dumps(value).encode(); header=b'\x81'+(bytes([len(raw)]) if len(raw)<126 else b'\x7e'+struct.pack('!H',len(raw)))
        for sock in list(self.ws_clients):
            try:sock.sendall(header+raw)
            except OSError:pass

    def close(self):
        for sock in self.ws_clients:
            try:sock.shutdown(socket.SHUT_RDWR)
            except OSError:pass
        for server in (self.http,self.ws):server.shutdown();server.server_close()
        for thread in self.threads:thread.join(2)
