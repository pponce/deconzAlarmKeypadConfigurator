"""Separately installed, peer-authenticated Linux maintenance helper."""
import argparse
import copy
import fcntl
import os
from pathlib import Path
import re
import secrets
import socket
import socketserver
import struct
import time
from .common import LIMIT, atomic, loads, require
from .configuration import read
from .core import Core
from .editing import Editor, WRITE_OPS
from .host_client import binding
from .transactions import digest


class Service:
    def __init__(self,core):self.core=core;self.prepared=None
    def context(self,value):
        require(isinstance(value,dict) and value.get('gateway') in self.core.registrations,'host_scope_invalid')
        require(value.get('identity')==self.core.registrations[value['gateway']]['identity'] and
                type(value.get('alarm')) is int and 1<=value['alarm']<=255 and value.get('operation') in WRITE_OPS,'host_scope_invalid')
        return value
    def transaction(self,tx,maintenance=False):
        self.context(tx)
        require(tx.get('schema')==1 and isinstance(tx.get('id'),str) and re.fullmatch('[0-9a-f]{32}',tx['id']) and
                tx.get('operation')=='rotate_pin' and isinstance(tx.get('intent'),dict) and tx['intent'].get('kind')=='identity' and
                tx['intent'].get('uid')==tx.get('identity_id') and isinstance(tx.get('identity_id'),str) and
                re.fullmatch('[0-9a-f]{32}',tx['identity_id']) and type(tx.get('verified')) is bool and
                type(tx.get('write_attempted')) is bool,'host_transaction_invalid')
        require(tx.get('homebridge_selection')==tx['intent'].get('homebridge_selection'),'host_transaction_changed')
        if maintenance:
            require(self.core.homebridge is not None and self.core.homebridge.applies(tx) and
                    tx.get('participants',{}).get('homebridge')==1,'host_scope_invalid')
        previous=self.core.transactions.load(tx['gateway'])
        require(previous is None or previous['stage']=='complete' or previous['id']==tx['id'],'host_pending_transaction')
        if previous and previous['id']==tx['id']:
            require(all(previous[k]==tx[k] for k in ('intent','identity','alarm','identity_id','snapshot_digest','participants')),'host_transaction_changed')
            require(not previous['write_attempted'] or tx['write_attempted'],'host_transaction_changed')
            require(not previous['verified'] or tx['verified'],'host_transaction_changed')
        return tx
    def dispatch(self,operation,envelope):
        require(isinstance(envelope,dict) and set(envelope)=={'binding','request'} and
                envelope['binding']==binding(self.core.config),'host_registration_changed')
        body=envelope['request'];require(isinstance(body,dict),'host_request_invalid')
        adapter=self.core.homebridge
        if operation=='status':
            require(not body,'host_request_invalid')
            obligations=[]
            for gateway in self.core.registrations:
                tx=self.core.transactions.load(gateway)
                if tx and tx['stage']!='complete':obligations.append({'gateway':gateway,'id':tx['id']})
            return {'available':True,'pending':bool(adapter and adapter.status()['pending']),'obligations':obligations,'bindings':adapter.status()['bindings'] if adapter else []}
        require(self.core.config['access_mode']=='manage','host_observe_only')
        if operation=='guard':
            require(not body and adapter is not None,'host_request_invalid');adapter.guard();return True
        if operation=='preflight':
            require(set(body)=={'context','pin'} and adapter is not None,'host_request_invalid')
            context=self.context(body['context']);require(adapter.applies(context),'host_scope_invalid')
            require(self.prepared is None or time.monotonic()>self.prepared[2],'host_preflight_pending')
            adapter.pin=body['pin']
            try:adapter.preflight(context)
            except Exception:
                adapter.pin=None;adapter.prepared=None;self.prepared=None
                raise
            token=secrets.token_hex(24);self.prepared=(token,copy.deepcopy(context),time.monotonic()+60)
            return token
        if operation=='backup':
            require(set(body)=={'context','snapshot_digest'},'host_request_invalid')
            context=self.context(body['context']);editor=Editor(self.core.view(context['gateway'],context['alarm']))
            snapshot=editor.snapshot()
            if context['operation'] in ('save_lockout','reset_lockout'):snapshot['lockout']=editor.view.lockout()
            require(digest(snapshot)==body['snapshot_digest'],'host_snapshot_changed')
            return self.core.backup.save(context,snapshot)
        if operation in ('evidence_prepare','evidence_submit','evidence_verify'):
            require(self.core.transactions.evidence is not None,'local_credential_evidence_required')
            if operation=='evidence_verify':tx=self.transaction(body)
            else:
                require(set(body)=={'transaction','pin'},'host_request_invalid');tx=self.transaction(body['transaction'])
            evidence=self.core.transactions.evidence
            if operation=='evidence_prepare':
                require(tx['stage']=='preparing' and not tx['write_attempted'],'host_transaction_invalid')
                evidence.prepare(tx,body['pin']);return True
            if operation=='evidence_submit':return evidence.submit(tx,body['pin'])
            return evidence.verify(tx)
        require(operation in ('pause','verify','resume','complete','recovery_ready') and adapter is not None,'host_operation_unavailable')
        if operation=='pause':
            require(set(body)=={'transaction','token'},'host_request_invalid')
            tx=self.transaction(body['transaction'],True)
            require(self.prepared and body['token']==self.prepared[0] and time.monotonic()<self.prepared[2] and
                    all(tx.get(k)==v for k,v in self.prepared[1].items()) and tx['stage']=='preparing' and not tx['write_attempted'],'host_preflight_expired')
            self.prepared=None;self.core.transactions.save(tx)
            try:adapter.pause(tx)
            finally:adapter.pin=None;adapter.prepared=None
            return True
        tx=self.transaction(body,True)
        previous=self.core.transactions.load(tx['gateway'])
        require(previous and previous['id']==tx['id'],'host_transaction_missing')
        require(tx['stage'] in ('verified','resuming','recovery_required','complete'),'host_transaction_invalid')
        if operation in ('verify','resume','complete'):require(tx['verified'] is True,'host_write_unverified')
        if operation=='complete':require(tx['stage']=='complete','host_transaction_invalid')
        # Persist a hold until the requested callback has actually succeeded.
        record=copy.deepcopy(tx);record['stage']='recovery_required';self.core.transactions.save(record)
        result=getattr(adapter,operation)(tx)
        if operation=='complete':self.core.transactions.save(tx)
        return result if operation=='recovery_ready' else True


def handler(service,uid):
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            try:
                self.request.settimeout(150)
                _,actual,_=struct.unpack('3i',self.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                require(actual==uid,'host_peer_invalid')
                raw=self.rfile.readline(LIMIT+1)
                require(len(raw)<=LIMIT and raw.endswith(b'\n'),'host_request_invalid')
                message=loads(raw)
                require(set(message)=={'schema','id','version','operation','body'} and message['schema']==1 and
                        message['id']=='host-maintenance' and message['version']=='1.0.0','host_protocol_invalid')
                result={'data':service.dispatch(message['operation'],message['body'])}
            except Exception:result={'error':'host_operation_unavailable_or_held'}
            try:
                import json
                self.wfile.write(json.dumps(result,allow_nan=False).encode()+b'\n')
            except Exception:pass
    return Handler


def serve(config,uid,gid,path):
    require(os.geteuid()==0 and type(uid) is int and uid>0 and type(gid) is int and gid>0,'host_identity_invalid')
    require('host_helper' not in config and not config['extensions'],'host_configuration_invalid')
    core=Core(config);service=Service(core);path=Path(path)
    require(path.resolve()==path and path.parent.is_dir() and path.parent.stat().st_uid==0 and not path.parent.stat().st_mode&0o022,'host_socket_invalid')
    fd=os.open(core.state/'host.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if path.exists():require(path.is_socket() and path.stat().st_uid==0,'host_socket_invalid');path.unlink()
        class Server(socketserver.UnixStreamServer):
            def handle_error(self,*_):pass
            def service_actions(self):
                if service.prepared and time.monotonic()>service.prepared[2]:
                    service.prepared=None
                    if core.homebridge:core.homebridge.pin=None;core.homebridge.prepared=None
        with Server(str(path),handler(service,uid)) as server:
            os.chown(path,0,gid);os.chmod(path,0o660);server.serve_forever(poll_interval=.5)
    finally:os.close(fd)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path,required=True);parser.add_argument('--peer-uid',type=int,required=True);parser.add_argument('--peer-gid',type=int,required=True);parser.add_argument('--socket',required=True)
    args=parser.parse_args()
    try:
        require(os.geteuid()==0,'host_identity_invalid');serve(read(args.config),args.peer_uid,args.peer_gid,args.socket)
    except Exception:raise SystemExit('Host helper unavailable; private details omitted.') from None

if __name__=='__main__':main()
