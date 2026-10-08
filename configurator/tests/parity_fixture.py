"""Loopback-only synthetic preview: real core/security, no host or gateway transport."""
import copy
import hashlib
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from configurator.core import Core
from configurator import server
from support import config, IDENTITY, USER
from test_editing import Model, owner
from test_homebridge import Host
from configurator.common import Rejected

class PreviewModel(Model):
    def __init__(self):
        super().__init__()
        for n, name in [(12, 'Visitor'), (13, 'Service user')]:
            uid = format(n, '032x')
            row = owner(uid, name)
            row.update(owner=False, remaining_uses=3 if n == 12 else None)
            self.identities[uid] = {k: row[k] for k in ('id','name','enabled','revision','user_revision')}
            self.grants['1'][uid] = copy.deepcopy(row)
            self.grants['2'][uid] = copy.deepcopy(row)
            self.pins[uid] = '234567' if n == 12 else '345678'
        self.grants['2'][format(12,'032x')]['schedule'] = {'timezone':'UTC','not_before':None,'expires_at':None,'windows':[{'day':1,'start':540,'end':1020}]}
    def read(self, path):
        if path == '/alarmsystems':
            return {aid:{'name':name,'state':{'armstate':'disarmed'},'devices':{'00:11:22:33:44:55:66:77-01':{}}}
                    for aid,name in [('1','Entry alarm'),('2','Workshop alarm')]}
        if path == '/sensors':
            return {'1':{'type':'ZHAAncillaryControl','name':'Entry keypad','uniqueid':'00:11:22:33:44:55:66:77-01','config':{'reachable':True}}}
        return super().read(path)

if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='configurator-synthetic-') as folder:
        root = Path(folder); backups=root/'backups';backups.mkdir(mode=0o700)
        registration={'id':'example','name':'Example gateway','identity':IDENTITY,'endpoint':'http://127.0.0.1:1','key':'synthetic-unused'}
        cfg=config(root,[registration]);cfg.update(schema=2,access_mode='manage',backup_root=str(backups))
        class PreviewHost(Host):
            first=True
            def replace(self,path,old,new):
                if self.first:
                    self.first=False
                    raise Rejected('homebridge_cache_changed')
                return super().replace(path,old,new)
        cfg['homebridge']={'schema':1,'profile':'local-hb-service','storage':str(root),
            'package':str(root/'synthetic-plugin'),'bindings':[{'gateway':'example','identity':IDENTITY,'user':USER,'alarms':[1,2]}]}
        mode = os.environ.get('CONFIGURATOR_DEPLOYMENT', 'local-homebridge')
        if mode != 'local-homebridge': cfg['homebridge'] = None
        if os.environ.get('CONFIGURATOR_ACCOUNTS')=='synthetic':cfg['homebridge']['bindings'][0]['user']=format(13,'032x')
        model=PreviewModel()
        if os.environ.get('CONFIGURATOR_PROTECTION') == 'synthetic':
            from test_lockout_status import KeypadModel
            class ProtectionModel(PreviewModel, KeypadModel):
                read = KeypadModel.read
                change = KeypadModel.change
            model=ProtectionModel()
        coordinator_url = os.environ.get('COORDINATOR_FIXTURE_URL')
        if coordinator_url:
            from configurator.common import atomic
            credential = root / 'coordinator-token.json'
            atomic(credential, {'token': os.environ['COORDINATOR_TEST_TOKEN']})
            cfg['coordinator'] = {
                'base_url': coordinator_url, 'token_file': str(credential),
                'instance_id': '00000000-0000-4000-8000-000000000001', 'scopes': [],
            }
        core=Core(cfg,model.factory,homebridge_host=PreviewHost(root))
        if os.environ.get('CONFIGURATOR_FIRST_RUN') == 'synthetic':
            from configurator.common import atomic
            atomic(core.state/'first-run.json', {'schema': 1, 'complete': False})
            atomic(core.state/'deployment.json', {'schema': 1, 'mode': mode, 'gateway_id': 'example', 'gateway_identity': IDENTITY, 'backup_acknowledged': True})
        core.view('example',1).inventory()
        core.history('example',1).add('Visitor','Keypad','Code accepted','Synthetic fixture; no device action')
        core.history('example',2).add('Administrator','Configuration','Settings saved','Synthetic fixture')
        server.rpc=lambda socket,op,body:core.dispatch(op,body)
        security_config={'salt':'00'*16,'password_hash':hashlib.scrypt(b'preview',salt=bytes(16),n=16384,r=8,p=1).hex()}
        http=ThreadingHTTPServer(('127.0.0.1',0),server.handler(security_config,server.Security(security_config, lambda op,body:core.dispatch(op,body)),Path(__file__).parents[1]/'static'))
        security_config.update(origin='https://127.0.0.1:'+str(http.server_port),socket='unused',port=http.server_port,bind='127.0.0.1')
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'key'),'‑out'.replace('‑','-'),str(root/'cert'),'-days','1','-subj','/CN=localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(root/'cert',root/'key');http.socket=tls.wrap_socket(http.socket,server_side=True)
        print(json.dumps({'origin':security_config['origin'],'password':'preview'}),flush=True)
        http.serve_forever()
