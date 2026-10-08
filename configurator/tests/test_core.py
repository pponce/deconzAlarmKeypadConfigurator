import copy
from datetime import datetime, timezone
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from configurator.common import Rejected, atomic, rpc
from configurator.configuration import validate
from configurator.core import Core
from configurator.collector import Collector
from configurator.gateway import Gateway
from configurator.package import build
from support import config, FakeGateway, IDENTITY, USER


def wait_for(check, seconds=8):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        try:
            value=check()
            if value:return value
        except (OSError, Rejected):pass
        time.sleep(.03)
    raise AssertionError('Timed out waiting for synthetic service')


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.fake=FakeGateway();self.cfg=config(self.root,[self.fake.registration()])
        self.core=Core(self.cfg)
    def tearDown(self):self.fake.close();self.temp.cleanup()
    def request(self,op,alarm=1):return self.core.dispatch('gateway_request',{'gateway':'test','alarm':alarm,'operation':op,'body':{}})

    def test_zero_gateway_startup_and_fail_closed_integrations(self):
        cfg=config(self.root)
        self.assertEqual(Core(cfg).dispatch('setup',{})['gateway_count'],0)
        for key,value in [('extensions',[{'id':'safety','version':1}]),('homebridge',{}),('access_mode','manage')]:
            bad=copy.deepcopy(cfg);bad[key]=value
            with self.assertRaises(Rejected):Core(bad)
        self.assertEqual(self.fake.requests,[])

    def test_identity_capability_and_registration_isolation(self):
        self.assertEqual(len(self.request('inventory',None)['alarms']),2)
        self.fake.identity='FFEEDDCCBBAA0099'
        with self.assertRaisesRegex(Rejected,'identity'):self.request('overview')
        self.fake.identity=IDENTITY;self.fake.capability=1
        with self.assertRaisesRegex(Rejected,'enhanced_plugin'):self.request('overview')
        cfg=copy.deepcopy(self.cfg);cfg['gateways'][0]['identity']='FFEEDDCCBBAA0099'
        with self.assertRaisesRegex(Rejected,'history_gateway_identity'):Core(cfg)

    def test_owner_grants_schedules_uses_projection_and_no_secrets(self):
        data=self.request('overview');user=data['users'][0]
        self.assertTrue(user['owner']);self.assertIsNone(user['remaining_uses']);self.assertIsNone(user['schedule'])
        self.assertTrue(user['grant_enabled']);self.assertEqual(user['id'],USER)
        self.assertNotIn('never-project',json.dumps(data))
        self.assertNotIn('test-key',json.dumps(self.core.dispatch('setup',{})))
        self.request('overview',2)
        self.assertIn(('GET','/api/test-key/alarmsystems/2/users'),self.fake.requests)

    def test_no_mutation_at_both_boundaries_and_no_implicit_alarm(self):
        for op in ('save_user','delete_user','save_alarm','keypad_send','reset_lockout','recover','setup_save'):
            with self.assertRaises(Rejected):self.request(op)
        with self.assertRaisesRegex(Rejected,'explicit_alarm'):self.request('overview',None)
        with self.assertRaises(Rejected):Gateway(self.fake.registration()).exchange('/alarmsystems/1','PUT',{'armmode':'disarmed'})
        self.assertTrue(all(method=='GET' for method,_ in self.fake.requests))

    def test_invalid_config_paths_and_duplicate_identity(self):
        duplicate=copy.deepcopy(self.cfg);duplicate['gateways'].append(dict(duplicate['gateways'][0],id='second'))
        with self.assertRaises(Rejected):validate(duplicate)
        for endpoint in ('http://user:password@localhost','http://localhost/api','file:///tmp/data','http://localhost/?key=x'):
            bad=copy.deepcopy(self.cfg);bad['gateways'][0]['endpoint']=endpoint
            with self.assertRaises(Rejected):validate(bad)
        Path(self.cfg['state']).chmod(0o755)
        with self.assertRaises(Rejected):validate(self.cfg)

    def test_lockout_expiry_requires_fresh_status(self):
        history=self.core.history('test',1)
        stamp=datetime.now(timezone.utc).isoformat()
        history.lockout_event({'key':'e'*32,'timestamp':stamp,'sensor':'3','locked_until':int(time.time()*1000)-1000,
                              'remaining_seconds':1,'level':1})
        collector=Collector(self.core)
        collector.verify_lockouts('test',['1'])
        self.assertFalse(any(r['action']=='Lockout expired' for r in history.rows()))
        self.assertTrue(any(r['action']=='Lockout status unavailable' for r in history.rows()))
        original=self.fake.response
        self.fake.response=lambda path: {'policy':{'enabled':True},'keypads':[]} if path.endswith('/lockout') else original(path)
        collector.verify_lockouts('test',['1'])
        self.assertTrue(any(r['action']=='Lockout expired' for r in history.rows()))

    def test_browser_closed_collection_discovery_without_socket_replacement(self):
        collector=Collector(self.core,interval=.15);collector.start()
        try:
            wait_for(lambda:self.core.connected.get('test'))
            initial=self.fake.ws_connections
            stamp=datetime.now(timezone.utc).isoformat()
            event={'t':'event','r':'alarmsystems','id':'1','e':'alarm_command','source':'rest',
                   'timestamp':stamp,'event_id':'b'*32,'uses_consumed':0,'action':'disarm','result':'accepted','user_id':USER}
            self.fake.emit(event)
            wait_for(lambda:any(r['user']=='Test user' for r in self.core.history('test',1).rows()))
            generation=collector.generations['test']
            self.fake.names='Renamed user';self.fake.alarm_ids.append('3')
            # The catalog can refresh before the separate user-name GET completes.
            # Wait past an in-flight discovery and one whole subsequent refresh.
            wait_for(lambda:collector.generations.get('test',0)>=generation+2)
            wait_for(lambda:any(a['id']==3 for a in self.core.catalog['test']['alarms']))
            self.assertEqual(self.fake.ws_connections,initial)
            event.update(event_id='c'*32,timestamp=datetime.now(timezone.utc).isoformat())
            self.fake.emit(event)
            wait_for(lambda:any(r['user']=='Renamed user' for r in self.core.history('test',1).rows()))
            self.fake.emit(event)  # immutable event deduplication
            time.sleep(.1)
            rows=self.core.history('test',1).rows()
            self.assertEqual(sum(r['source']=='REST/API' for r in rows),2)
            self.assertTrue(any(r['user']=='Test user' for r in rows))
            self.assertFalse(any(r['source']=='REST/API' for r in self.core.history('test',2).rows()))
            self.fake.identity='FFEEDDCCBBAA0099'
            wait_for(lambda:not self.core.connected.get('test'))
            self.assertTrue(all(method=='GET' for method,_ in self.fake.requests))
        finally:collector.close()


class IsolatedApplicationTests(unittest.TestCase):
    def test_packaged_broker_and_https_without_private_modules(self):
        try:
            probe=socket.socket(socket.AF_UNIX);probe.close()
        except PermissionError:
            if os.environ.get('GITHUB_ACTIONS') == 'true':raise
            self.skipTest('Execution workspace prohibits Unix sockets; mandatory on Linux CI')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);bundle=root/'bundle';hashes=build(bundle)
            self.assertFalse((bundle/'admin').exists());self.assertFalse((bundle/'scripts').exists())
            # Every packaged import must resolve in this package or Python stdlib.
            self.assertEqual(set(p.relative_to(bundle).as_posix() for p in bundle.rglob('*') if p.is_file()),set(hashes)|{'manifest.json'})
            cfg=config(root);atomic(root/'broker.json',cfg)
            cert=root/'cert.pem';key=root/'key.pem'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
                            '-keyout',str(key),'-out',str(cert)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            origin='https://127.0.0.1:'+str(port);salt='11'*16
            web={'bind':'127.0.0.1','port':port,'origin':origin,'socket':cfg['socket'],'cert':str(cert),'key':str(key),
                 'salt':salt,'password_hash':hashlib.scrypt(b'test-password',salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()}
            atomic(root/'web.json',web)
            processes=[]
            def launch(module,path):
                # -I excludes cwd/PYTHONPATH, and cwd contains no original repository.
                code='import sys,runpy;sys.path.insert(0,sys.argv.pop(1));runpy.run_module("configurator.'+module+'",run_name="__main__")'
                p=subprocess.Popen([sys.executable,'-I','-B','-c',code,str(bundle),'--config',str(path)],cwd=root,
                                   stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin'})
                processes.append(p);return p
            try:
                broker=launch('broker',root/'broker.json')
                wait_for(lambda:Path(cfg['socket']).exists())
                self.assertEqual(rpc(cfg['socket'],'setup',{})['gateway_count'],0)
                second=launch('broker',root/'broker.json');second.wait(4)
                self.assertNotEqual(second.returncode,0)
                self.assertEqual(rpc(cfg['socket'],'setup',{})['access_mode'],'observe')
                server=launch('server',root/'web.json')
                context=ssl._create_unverified_context() # synthetic self-signed fixture only
                def request(method,path,body=None,headers=None):
                    h={'Host':'127.0.0.1:'+str(port),**(headers or {})}
                    if body is not None:h['Content-Type']='application/json'
                    c=http.client.HTTPSConnection('127.0.0.1',port,context=context,timeout=3)
                    c.request(method,path,None if body is None else json.dumps(body),h)
                    response=c.getresponse();result=response.read();status=response.status;rh=dict(response.getheaders());c.close()
                    return status,rh,result
                wait_for(lambda:request('GET','/')[0]==200)
                self.assertEqual(request('GET','/api/setup')[0],401)
                self.assertEqual(request('POST','/api/login',{'password':'test-password'})[0],400)
                self.assertEqual(request('POST','/api/login',{'password':'test-password'},{'Origin':'https://elsewhere.invalid'})[0],400)
                status,headers,body=request('POST','/api/login',{'password':'test-password'},{'Origin':origin})
                self.assertEqual(status,200);cookie=headers['Set-Cookie'];csrf=json.loads(body)['csrf']
                self.assertIn('Secure; HttpOnly; SameSite=Strict',cookie)
                h={'Cookie':cookie.split(';')[0],'Origin':origin}
                self.assertEqual(json.loads(request('GET','/api/setup',headers=h)[2])['gateway_count'],0)
                self.assertEqual(request('POST','/api/logout',{},h)[0],400)
                h['X-CSRF-Token']=csrf
                self.assertEqual(request('POST','/api/users/save',{},h)[0],400)
                self.assertEqual(request('POST','/api/logout',{},h)[0],200)
                self.assertEqual(request('GET','/api/setup',headers=h)[0],401)
                self.assertIsNone(broker.poll());self.assertIsNone(server.poll())
                # Restart the isolated broker with a synthetic gateway and verify
                # authenticated, scoped end-to-end reads through the Unix socket.
                fake=FakeGateway()
                try:
                    broker.terminate();broker.communicate(timeout=5)
                    cfg['gateways']=[fake.registration()];atomic(root/'broker.json',cfg)
                    broker=launch('broker',root/'broker.json')
                    wait_for(lambda:rpc(cfg['socket'],'setup',{})['gateway_count']==1)
                    status,headers,body=request('POST','/api/login',{'password':'test-password'},{'Origin':origin})
                    self.assertEqual(status,200)
                    h={'Cookie':headers['Set-Cookie'].split(';')[0], 'X-Configurator-Gateway':'test','X-Configurator-Alarm':'2'}
                    status,_,raw=request('GET','/api/overview',headers=h)
                    self.assertEqual(status,200);self.assertEqual(json.loads(raw)['users'][0]['id'],USER)
                    self.assertNotIn(b'never-project',raw)
                    self.assertTrue(all(method=='GET' for method,_ in fake.requests))
                    # Explicit management profile only in this synthetic fixture.
                    from test_editing import Model, owner
                    model=Model();original=fake.response
                    fake.response=lambda path: original(path) if path in ('/config','/sensors') else model.read(path)
                    fake.writer=model.change
                    broker.terminate();broker.communicate(timeout=5)
                    backups=root/'backups';backups.mkdir(mode=0o700)
                    cfg.update(schema=2,access_mode='manage',backup_root=str(backups));atomic(root/'broker.json',cfg)
                    broker=launch('broker',root/'broker.json')
                    wait_for(lambda:rpc(cfg['socket'],'setup',{})['access_mode']=='manage')
                    h['Origin']=origin
                    draft=dict(owner(),alarm=2,name='Updated by synthetic HTTPS',backup_acknowledged=True)
                    # Authenticated mutation still needs the session's CSRF token.
                    self.assertEqual(request('POST','/api/users/save',draft,h)[0],400)
                    h['X-CSRF-Token']=json.loads(body)['csrf']
                    status,_,raw=request('POST','/api/users/save',draft,h)
                    self.assertEqual(status,200,raw.decode());self.assertTrue(json.loads(raw)['saved'])
                    self.assertEqual(model.identities[USER]['name'],'Updated by synthetic HTTPS')
                    self.assertEqual(sum(method!='GET' for method,_ in fake.requests),1)

                finally:fake.close()

            finally:
                for p in processes:
                    if p.poll() is None:p.terminate()
                    p.communicate(timeout=5)
