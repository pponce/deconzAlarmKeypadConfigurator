"""Trusted local extension registrations and finite, peer-authenticated RPC.

External extensions execute in separately installed processes, never through
browser-provided code or paths. The application-owned coordinator adapter is
registered explicitly below. All registrations are maintenance obligations.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import time
from .common import atomic, loads, require, Rejected, LIMIT, RESPONSE_LIMIT

TRUSTED_UID = 0
NAME = '[a-z][a-z0-9-]{0,31}'


def declarations(rows):
    require(isinstance(rows,list) and len(rows)<=16,'extension_registry_invalid')
    seen=set()
    for row in rows:
        require(isinstance(row,dict) and set(row)=={'id','manifest'} and isinstance(row['id'],str) and
                re.fullmatch(NAME,row['id']) and len(row['id'])<=27 and row['id'] not in seen,'extension_registry_invalid')
        require(isinstance(row['manifest'],str) and Path(row['manifest']).is_absolute(),'extension_manifest_invalid')
        seen.add(row['id'])


def trusted_manifest(path):
    path=Path(path)
    require(path.resolve()==path and path.is_file() and path.stat().st_size<=65536,'extension_manifest_invalid')
    for item in (path,*path.parents):
        metadata=item.stat()
        sticky_parent=item!=path and stat.S_ISDIR(metadata.st_mode) and metadata.st_mode & stat.S_ISVTX
        require((metadata.st_uid==TRUSTED_UID if item==path else metadata.st_uid in (0,TRUSTED_UID)) and (not metadata.st_mode & 0o022 or sticky_parent),
                'extension_registration_not_trusted')
    return path.read_bytes()


class SocketTransport:
    def __call__(self,manifest,operation,body):
        path=Path(manifest['socket'])
        require(path.resolve()==path and path.is_socket(),'registered_extension_unavailable')
        parent=path.parent.stat()
        require(parent.st_uid in (0,manifest['peer_uid']) and not parent.st_mode & 0o022,'extension_socket_untrusted')
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(150)
            connection.connect(str(path))
            _,uid,_=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            require(uid==manifest['peer_uid'],'extension_peer_mismatch')
            raw=json.dumps({'schema':1,'id':manifest['id'],'version':manifest['version'],
                            'operation':operation,'body':body},allow_nan=False).encode()+b'\n'
            require(len(raw)<=LIMIT,'extension_request_too_large')
            connection.sendall(raw)
            response=connection.makefile('rb').readline(RESPONSE_LIMIT+1)
            require(len(response)<=RESPONSE_LIMIT and response.endswith(b'\n'),'extension_response_invalid')
            result=loads(response)
            require(isinstance(result,dict) and set(result)=={'data'},'extension_operation_unavailable')
            return result['data']


class Peer:
    api_version=1
    def __init__(self,manifest,transport):self.manifest=manifest;self.transport=transport
    def call(self,operation,body):
        try:return self.transport(self.manifest,operation,copy.deepcopy(body))
        except Exception:raise Rejected('registered_extension_unavailable_or_held') from None
    def check(self):
        result=self.call('handshake',{})
        require(result=={'schema':1,'id':self.manifest['id'],'version':self.manifest['version'],'api_version':1},
                'extension_api_incompatible')
    def acknowledged(self,operation,body):
        require(self.call(operation,body) is True,'extension_maintenance_not_acknowledged')
    def guard(self):self.check();self.acknowledged('guard',{})
    def applies(self,context):return 'maintenance' in self.manifest['permissions'] and context['operation']!='keypad_send'
    def preflight(self,context):self.check();self.acknowledged('maintenance_preflight',context)
    def pause(self,tx):self.acknowledged('maintenance_pause',tx)
    def verify(self,tx):self.acknowledged('maintenance_verify',tx)
    def resume(self,tx):self.acknowledged('maintenance_resume',tx)
    def complete(self,tx):self.acknowledged('maintenance_complete',tx)
    def recovery_ready(self,tx):
        try:self.check();return self.call('maintenance_recovery_ready',tx) is True
        except Exception:return False


class Hook:
    api_version=1
    def __init__(self,peer,context,started):
        self.peer=peer;self.started=started;self.note=None
        peer.check()
        result=peer.call('keypad_begin',context)
        require(isinstance(result,dict) and set(result)=={'token'} and isinstance(result['token'],str) and
                re.fullmatch('[0-9a-f]{48}',result['token']),'extension_keypad_context_invalid')
        self.token=result['token']
    def after(self,outcome,mode):
        result=self.peer.call('keypad_after',{'token':self.token,'outcome':outcome,'mode':mode,
                                           'elapsed':time.monotonic()-self.started})
        require(isinstance(result,dict) and set(result)=={'note'} and isinstance(result['note'],str) and len(result['note'])<=256,
                'extension_response_invalid')
        self.note=result['note']
    def failed(self,outcome):
        # No retry of an extension outcome request, including after transport loss.
        self.note='Extension result unavailable; no automatic retry'


class Registry:
    def __init__(self,core,transport=None):
        self.core=core;self.peers={};self.transport=transport or SocketTransport()
        declarations(core.config['extensions']);registry=[];scopes=set()
        for declaration in core.config['extensions']:
            raw=trusted_manifest(declaration['manifest']);m=loads(raw)
            require(isinstance(m,dict) and set(m)=={'schema','id','version','api_version','name','socket','peer_uid','permissions','scopes','routes','assets'} and
                    type(m['schema']) is int and m['schema']==1 and type(m['api_version']) is int and m['api_version']==1 and m['id']==declaration['id'],
                    'extension_manifest_invalid')
            require(isinstance(m['version'],str) and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',m['version']) and
                    isinstance(m['name'],str) and 0<len(m['name'])<=64,'extension_manifest_invalid')
            require(isinstance(m['socket'],str) and Path(m['socket']).is_absolute() and type(m['peer_uid']) is int and m['peer_uid']>=0,
                    'extension_manifest_invalid')
            require(isinstance(m['permissions'],list) and len(set(m['permissions']))==len(m['permissions']) and
                    set(m['permissions'])<={'maintenance','keypad'},'extension_permissions_invalid')
            require(isinstance(m['scopes'],list),'extension_scope_invalid')
            for scope in m['scopes']:
                require(isinstance(scope,dict) and set(scope)=={'gateway','identity','alarm'} and
                        scope['gateway'] in core.registrations and core.registrations[scope['gateway']]['identity']==scope['identity'] and
                        type(scope['alarm']) is int and 1<=scope['alarm']<=255,'extension_scope_invalid')
                key=(scope['gateway'],scope['alarm'])
                require(key not in scopes,'extension_keypad_scope_conflict');scopes.add(key)
            require(isinstance(m['routes'],dict) and len(m['routes'])<=32 and
                    all(re.fullmatch(NAME,k) and v in ('GET','POST','POST_RECOVERY') for k,v in m['routes'].items()),'extension_routes_invalid')
            require(isinstance(m['assets'],dict) and set(m['assets'])<={'index.html','app.js','style.css'} and
                    all(v=={'index.html':'text/html','app.js':'text/javascript','style.css':'text/css'}[k] for k,v in m['assets'].items()),
                    'extension_assets_invalid')
            peer=Peer(m,self.transport);self.peers[m['id']]=peer
            registry.append(dict(declaration,sha256=hashlib.sha256(raw).hexdigest(),version=m['version']))
        path=core.state/'extension-registrations.json'
        require(not path.is_symlink(),'extension_registry_invalid')
        if path.exists():
            require(path.stat().st_uid==os.geteuid() and not path.stat().st_mode & 0o077,'extension_registry_invalid')
            require(loads(path.read_bytes())==registry,'registered_extension_changed_review_required')
        elif registry:atomic(path,registry)
        if 'coordinator' in core.config:
            from coordinator_admin.integration import CoordinatorPeer, ID
            require(ID not in self.peers, 'coordinator_registration_conflict')
            peer = CoordinatorPeer(core.config['coordinator'], core)
            for scope in peer.manifest['scopes']:
                require((scope['gateway'], scope['alarm']) not in scopes, 'extension_keypad_scope_conflict')
            self.peers[ID] = peer
    def public(self):
        return [{'id':key,'name':peer.manifest['name'],'version':peer.manifest['version'],
                 'page':'/extensions/'+key+'/index.html' if 'index.html' in peer.manifest['assets'] else None,
                 **({'maintenance':'/api/extensions/'+key+'/maintenance'}
                    if 'maintenance' in peer.manifest['permissions'] and peer.manifest['routes'].get('maintenance')=='GET' else {})}
                for key,peer in self.peers.items()]
    def guard(self):
        for path in self.core.state.glob('transaction-*.json'):
            tx=self.core.transactions.load(path.name[len('transaction-'):-len('.json')])
            if tx and tx['stage']!='complete' and any(name.startswith('ext-') for name in tx['participants']):
                self.core.transactions.required(tx)
                raise Rejected('extension_maintenance_recovery_required')
        for peer in self.peers.values():peer.guard()
    def begin(self,view,started):
        context={'gateway':view.gateway_id,'identity':self.core.registrations[view.gateway_id]['identity'],'alarm':view.alarm_id}
        peers=[peer for peer in self.peers.values() if 'keypad' in peer.manifest['permissions'] and context in peer.manifest['scopes']]
        require(len(peers)<=1,'extension_keypad_scope_conflict')
        return Hook(peers[0],context,started) if peers else None
    def dispatch(self,body):
        require(set(body)=={'id','route','method','body','asset'} and isinstance(body['body'],dict),'extension_request_invalid')
        peer=self.peers.get(body['id']);require(peer is not None,'extension_not_registered')
        peer.check()
        if body['asset']:
            require(body['method']=='GET' and not body['body'] and body['route'] in peer.manifest['assets'],'extension_route_unavailable')
            result=peer.call('asset',{'name':body['route']})
            require(isinstance(result,str) and len(result)<=256*1024,'extension_asset_invalid')
            return {'content':result,'mime':peer.manifest['assets'][body['route']]}
        route=peer.manifest['routes'].get(body['route'])
        # Only the built-in coordinator may register POST_READ. It accepts a
        # controller selector for a hardware read, including in observation mode.
        read_probe = peer.manifest['id']=='homebridge-coordinator' and route=='POST_READ'
        require(route==body['method'] or (route=='POST_RECOVERY' or read_probe) and body['method']=='POST','extension_route_unavailable')
        if route=='POST':
            self.guard()
            for path in self.core.state.glob('transaction-*.json'):
                self.core.transactions.guard(path.name[len('transaction-'):-len('.json')])
        if body['method']=='POST' and not read_probe:require(self.core.config['access_mode']=='manage','candidate_read_only_required')
        return peer.call('route',{'name':body['route'],'body':body['body']})
