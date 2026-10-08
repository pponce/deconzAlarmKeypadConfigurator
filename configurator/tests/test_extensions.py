"""Neutral extension fixtures; no private modules are required or imported."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from configurator.common import atomic, Rejected
from configurator.core import Core
from configurator.extensions import trusted_manifest
from support import config, IDENTITY, USER
from test_editing import Model


def manifest(root):
    return {'schema':1,'id':'fixture','version':'1.0.0','api_version':1,'name':'Fixture extension',
            'socket':str(root/'fixture.sock'),'peer_uid':os.geteuid(),'permissions':['maintenance','keypad'],
            'scopes':[{'gateway':'test','identity':IDENTITY,'alarm':1}],
            'routes':{'settings':'GET','save':'POST','confirm':'POST_RECOVERY'},'assets':{'index.html':'text/html'}}


class PeerFixture:
    def __init__(self):self.calls=[];self.fail=None;self.note='Fixture outcome recorded';self.hooks={}
    def __call__(self,m,op,body):
        self.calls.append((op,copy.deepcopy(body)))
        if op==self.fail:raise OSError('fixture private detail must not escape')
        if op=='handshake':return {'schema':1,'id':m['id'],'version':m['version'],'api_version':1}
        if op=='keypad_begin':return {'token':'a'*48}
        if op=='keypad_after':return {'note':self.note}
        if op=='asset':return '<!doctype html><title>Fixture</title>'
        if op=='route':return {'route':body['name']}
        return True


class ExtensionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.trust=patch('configurator.extensions.TRUSTED_UID',os.geteuid());self.trust.start()
        self.model=Model();self.peer=PeerFixture()
        row={'id':'test','name':'Test','identity':IDENTITY,'endpoint':'http://127.0.0.1:1','key':'test-key'}
        self.cfg=config(self.root,[row]);(self.root/'backups').mkdir(mode=0o700)
        self.cfg.update(schema=2,access_mode='manage',backup_root=str(self.root/'backups'))
        self.manifest=manifest(self.root);self.path=self.root/'manifest.json';atomic(self.path,self.manifest)
        self.cfg['extensions']=[{'id':'fixture','manifest':str(self.path)}];self.restart()
    def tearDown(self):self.trust.stop();self.temp.cleanup()
    def restart(self):self.core=Core(copy.deepcopy(self.cfg),self.model.factory,extension_transport=self.peer)
    def call(self,op,body=None,alarm=1):return self.core.dispatch('gateway_request',{'gateway':'test','alarm':alarm,'operation':op,'body':body or {}})
    def route(self,name,method='GET',body=None,asset=False):
        return self.core.dispatch('extension_request',{'id':'fixture','route':name,'method':method,'body':body or {},'asset':asset})
    def draft(self):return dict(self.model.read('/alarmsystems/1/users')[USER],alarm=1,backup_acknowledged=True,name='Renamed')
    def test_registration_namespaced_routes_and_readonly_defaults(self):
        self.assertEqual(self.route('settings'),{'route':'settings'})
        self.assertEqual(self.route('index.html',asset=True)['mime'],'text/html')
        for name,method,asset in [('save','GET',False),('settings','POST',False),('../index.html','GET',True),('guard','POST',False)]:
            with self.assertRaises(Rejected):self.route(name,method,asset=asset)
        self.cfg['access_mode']='observe';self.restart()
        with self.assertRaisesRegex(Rejected,'read_only'):self.route('save','POST')
        self.assertEqual(self.route('settings'),{'route':'settings'})
    def test_missing_registered_extension_blocks_writes_and_keypad_before_gateway(self):
        self.peer.fail='handshake'
        with self.assertRaisesRegex(Rejected,'extension'):self.call('save_user',self.draft())
        with self.assertRaisesRegex(Rejected,'extension'):self.call('keypad_send',{'code':'1234','mode':'disarm','request_id':'f'*32})
        self.assertEqual(self.model.writes,[])
        self.assertTrue(self.core.dispatch('setup',{})['extensions'])
    def test_registration_omission_manifest_change_and_permissions_fail_closed(self):
        self.cfg['extensions']=[]
        with self.assertRaisesRegex(Rejected,'registered_extension'):self.restart()
        self.cfg['extensions']=[{'id':'fixture','manifest':str(self.path)}]
        self.path.chmod(0o666)
        with self.assertRaisesRegex(Rejected,'not_trusted'):self.restart()
        self.path.chmod(0o600);self.manifest['version']='1.0.1';atomic(self.path,self.manifest)
        with self.assertRaisesRegex(Rejected,'registered_extension'):self.restart()
    def test_maintenance_lifecycle_and_durable_missing_peer_recovery(self):
        self.peer.fail='maintenance_resume'
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.call('save_user',self.draft())
        self.assertEqual(len(self.model.writes),1)
        self.peer.fail='handshake';self.restart()
        self.assertFalse(self.call('review_recovery')['ready'])
        self.peer.fail=None
        review=self.call('review_recovery');self.assertTrue(review['ready'])
        self.call('recover_transaction',{'transaction_id':review['transaction_id'],'token':review['token'],'reviewed':True})
        self.assertEqual(len(self.model.writes),1)
        self.assertIn('maintenance_complete',[op for op,_ in self.peer.calls])
    def test_keypad_hook_scoped_no_pin_no_duplicate_or_uncertain_replay(self):
        self.call('keypad_send',{'code':'4567890123','mode':'disarm','request_id':'a'*32})
        after=[body for op,body in self.peer.calls if op=='keypad_after'];self.assertEqual(len(after),1)
        self.assertEqual(after[0]['outcome'],'accepted');self.assertNotIn('4567890123',json.dumps(self.peer.calls))
        self.call('keypad_send',{'code':'4567890123','mode':'disarm','request_id':'a'*32})
        self.assertEqual(len([1 for op,_ in self.peer.calls if op=='keypad_after']),1)
        self.call('keypad_send',{'code':'4567890123','mode':'disarm','request_id':'b'*32},alarm=2)
        self.assertEqual(len([1 for op,_ in self.peer.calls if op=='keypad_after']),1)
        self.peer.fail='keypad_after'
        result=self.call('keypad_send',{'code':'4567890123','mode':'disarm','request_id':'c'*32})
        self.assertTrue(result['uncertain']);self.assertEqual(result['result'],'accepted')
        self.assertNotIn('private detail',json.dumps(result))
    def test_symlink_registration_and_api_mismatch_are_rejected(self):
        linked=self.root/'link.json';linked.symlink_to(self.path)
        with self.assertRaises(Rejected):trusted_manifest(linked)
        self.manifest['api_version']=2;atomic(self.path,self.manifest)
        with self.assertRaisesRegex(Rejected,'manifest'):self.restart()
    def test_no_extension_import_or_browser_path_loader(self):
        self.assertNotIn('importlib',Path('configurator/extensions.py').read_text())
        with self.assertRaises(Rejected):self.route('register','POST',{'path':'/tmp/arbitrary.py'})

    def test_extension_http_routes_retain_login_origin_and_csrf_protection(self):
        import http.client
        import threading
        import time
        from http.server import ThreadingHTTPServer
        from configurator.server import handler,Security
        config={'origin':'http://127.0.0.1','socket':'fixture'};security=Security(config)
        security.sessions['test-session']={'account_id':None,'revision':None,'role':'admin','username':None,'csrf':'test-csrf','expires':time.monotonic()+100,'idle':time.monotonic()+100}
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(config,security,Path('configurator/static')))
        config['origin']='http://127.0.0.1:'+str(server.server_port)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def request(path,method='GET',headers=None):
            c=http.client.HTTPConnection('127.0.0.1',server.server_port)
            supplied=dict(headers or {})
            if method=='POST':supplied['Content-Type']='application/json'
            c.request(method,path,body='{}' if method=='POST' else None,headers=supplied)
            r=c.getresponse();result=r.status,r.read(),dict(r.getheaders());c.close();return result
        try:
            with patch('configurator.server.rpc',side_effect=lambda path,op,body:self.core.dispatch(op,body)):
                self.assertEqual(request('/extensions/fixture/index.html')[0],401)
                headers={'Cookie':'__Host-configurator=test-session'}
                status,raw,reply=request('/extensions/fixture/index.html',headers=headers)
                self.assertEqual(status,200);self.assertIn(b'<title>Fixture',raw)
                self.assertIn("frame-ancestors 'self'",reply['Content-Security-Policy'])
                self.assertEqual(reply['X-Frame-Options'],'SAMEORIGIN')
                _,_,shell=request('/',headers=headers)
                self.assertIn("frame-ancestors 'none'",shell['Content-Security-Policy'])
                self.assertEqual(shell['X-Frame-Options'],'DENY')
                status,_,denied=request('/extensions/unregistered/index.html',headers=headers)
                self.assertNotEqual(status,200)
                self.assertEqual(denied['X-Frame-Options'],'DENY')
                headers['Origin']=config['origin']
                self.assertEqual(request('/api/extensions/fixture/save','POST',headers)[0],400)
                headers['X-CSRF-Token']='test-csrf'
                self.assertEqual(request('/api/extensions/fixture/save','POST',headers)[0],200)
                headers['Origin']='https://foreign.invalid'
                self.assertEqual(request('/api/extensions/fixture/save','POST',headers)[0],400)
                self.assertEqual(request('/api/extensions/fixture/maintenance-pause','POST',headers)[0],400)
        finally:server.shutdown();server.server_close();thread.join()

    def test_real_local_transport_checks_peer_uid_and_protocol(self):
        import socket
        import socketserver
        import threading
        from configurator.extensions import SocketTransport
        path=self.root/'fixture.sock'
        try:
            probe=socket.socket(socket.AF_UNIX);probe.close()
        except PermissionError:
            if os.environ.get('GITHUB_ACTIONS')=='true':raise
            self.skipTest('Workspace prohibits AF_UNIX; required in Linux CI')
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                raw=self.rfile.readline(65537)
                if not raw:return
                request=json.loads(raw)
                self.wfile.write(json.dumps({'data':{'operation':request['operation'],'version':request['version']}}).encode()+b'\n')
        try:server=socketserver.UnixStreamServer(str(path),Handler)
        except PermissionError:
            if os.environ.get('GITHUB_ACTIONS')=='true':raise
            self.skipTest('Workspace prohibits AF_UNIX; required in Linux CI')
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            result=SocketTransport()(self.manifest,'handshake',{})
            self.assertEqual(result,{'operation':'handshake','version':'1.0.0'})
            # CI is unprivileged: emulate a root-owned runtime directory for
            # this negative peer check, while retaining the real kernel credentials.
            original_stat=Path.stat
            def root_owned_parent(path,*args,**kwargs):
                result=original_stat(path,*args,**kwargs)
                if path==self.root:
                    fields=list(result);fields[4]=0;return os.stat_result(fields)
                return result
            with patch.object(Path,'stat',root_owned_parent):
                with self.assertRaisesRegex(Rejected,'peer_mismatch'):
                    SocketTransport()(dict(self.manifest,peer_uid=os.geteuid()+1),'handshake',{})
        finally:server.shutdown();server.server_close();thread.join()
