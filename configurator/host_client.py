"""Finite root helper client. No cache bytes, paths or commands from the browser."""
from .common import require, Rejected
from .extensions import SocketTransport
from .homebridge import Adapter
from .transactions import digest


def binding(config):
    return digest({k:config.get(k,[]) for k in ('gateways','homebridge','database_backups')})


class Peer:
    def __init__(self,core,transport=None):
        self.core=core;self.transport=transport or SocketTransport()
        self.manifest={'socket':core.config['host_helper']['socket'],'peer_uid':0,'id':'host-maintenance','version':'1.0.0'}
    def call(self,operation,body):
        try:
            return self.transport(self.manifest,operation,{'binding':binding(self.core.config),'request':body})
        except Exception:raise Rejected('host_helper_unavailable_or_held') from None


class RemoteAdapter(Adapter):
    def __init__(self,core,peer):super().__init__(core,host=object());self.peer=peer
    def refresh_bindings(self):
        if not hasattr(self,'peer'):return
        from .homebridge import validate
        rows=self.peer.call('status',{}).get('bindings')
        require(isinstance(rows,list),'host_helper_invalid')
        registrations={r['id']:r['identity'] for r in self.core.config['gateways']}
        full=[dict(r,identity=registrations.get(r.get('gateway'))) for r in rows]
        validate(dict(self.config,bindings=full),self.core.config['gateways'])
        self.bindings={r['gateway']:r for r in full}
    def record(self):return None  # The durable service lease stays inside the helper.
    def guard(self):
        super().guard()
        # Complete is an idempotent bookkeeping callback, not a service restart.
        # Reconcile a crash after the core's durable completion but before delivery.
        status=self.peer.call('status',{})
        for obligation in status.get('obligations',[]):
            tx=self.core.transactions.load(obligation['gateway'])
            if tx and tx['stage']=='complete' and tx['id']==obligation['id']:self.complete(tx)
        require(self.peer.call('guard',{}) is True,'host_helper_held')
    def status(self):
        value=super().status()
        try:value['helper']=self.peer.call('status',{})
        except Exception:value['helper']={'available':False}
        return value
    def preflight(self,context):
        self.guard();self.prepared=self.peer.call('preflight',{'context':context,'pin':self.pin})
        require(isinstance(self.prepared,str) and len(self.prepared)==48,'host_helper_invalid')
    def pause(self,tx):require(self.peer.call('pause',{'transaction':tx,'token':self.prepared}) is True,'host_helper_held')
    def verify(self,tx):require(self.peer.call('verify',tx) is True,'host_helper_held')
    def resume(self,tx):require(self.peer.call('resume',tx) is True,'host_helper_held')
    def complete(self,tx):require(self.peer.call('complete',tx) is True,'host_helper_held')
    def recovery_ready(self,tx):
        try:return self.peer.call('recovery_ready',tx) is True
        except Exception:return False


class RemoteEvidence:
    api_version=1
    def __init__(self,peer):self.peer=peer
    def prepare(self,tx,pin):
        if tx['operation']=='rotate_pin' and any(r['gateway']==tx['gateway'] for r in self.peer.core.config.get('database_backups',[])):require(self.peer.call('evidence_prepare',{'transaction':tx,'pin':pin}) is True,'host_helper_held')
    def submit(self,tx,pin):return self.peer.call('evidence_submit',{'transaction':tx,'pin':pin})
    def verify(self,tx):
        if tx['operation']!='rotate_pin':return False
        try:return self.peer.call('evidence_verify',tx) is True
        except Exception:return False


class RemoteBackup:
    api_version=1
    def __init__(self,peer,local):self.peer,self.local=peer,local
    def status(self):return self.local.status()
    def save(self,context,snapshot):return self.peer.call('backup',{'context':context,'snapshot_digest':digest(snapshot)})
