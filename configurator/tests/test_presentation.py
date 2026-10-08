"""Administration parity contracts against the real independent core."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from configurator.common import Rejected
from configurator.core import Core
from configurator.debug import DebugCapture
from configurator.collector import Collector
from support import config, IDENTITY, USER
from test_editing import Model, owner

class PresentationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.model=Model();(self.root/'backups').mkdir(mode=0o700)
        rows=[{'id':'example','name':'Example','identity':IDENTITY,'endpoint':'http://127.0.0.1:1','key':'never-project'}]
        cfg=config(self.root,rows);cfg.update(schema=2,access_mode='manage',backup_root=str(self.root/'backups'))
        self.core=Core(cfg,self.model.factory)
        self.call('inventory',alarm=None)
    def tearDown(self):self.temp.cleanup()
    def call(self,operation,body=None,alarm=1):
        return self.core.dispatch('gateway_request',{'gateway':'example','alarm':alarm,'operation':operation,'body':body or {}})
    def test_projection_keeps_identity_and_alarm_grants_distinct(self):
        self.model.grants['2'][USER].update(remaining_uses=3,owner=False,schedule={'timezone':'UTC','windows':[{'day':1,'start':0,'end':1440}],'not_before':None,'expires_at':None})
        result=self.call('administration')
        self.assertEqual(len(result['identities']),1)
        self.assertIsNone(result['alarms'][0]['users'][0]['remaining_uses'])
        self.assertEqual(result['alarms'][1]['users'][0]['remaining_uses'],3)
        self.assertEqual(result['alarms'][1]['users'][0]['schedule']['windows'][0]['end'],1440)
        self.assertFalse(result['homebridge_sync']);self.assertIsNone(result['homebridge_binding'])
        self.assertEqual(self.model.writes,[])
        self.assertNotIn('never-project',json.dumps(result))
    def test_undiscovered_explicit_keypad_is_preserved_in_editor(self):
        pad={'source':'abc','endpoint':2};self.model.grants['1'][USER]['keypads']=[pad]
        self.assertEqual(self.call('administration')['keypads'][0]['source'],'abc')
    def test_homebridge_binding_and_pending_transaction_are_projected(self):
        self.core.homebridge=Mock();self.core.homebridge.status.return_value={'bindings':[{'gateway':'example','user':USER,'alarms':[1,2]}]}
        self.assertEqual(self.call('administration')['homebridge_binding']['alarms'],[1,2])
    def test_offline_activity_scopes_categories_and_historical_alarms(self):
        self.core.history('example',1).add('Visitor','Keypad','Code accepted','Accepted')
        self.core.history('example',2).add('Administrator','Configuration','save_user','Saved')
        self.core.history('example',3).add('Alarm','deCONZ','disarmed','Observed')
        self.model.factory=lambda *_a,**_k: (_ for _ in ()).throw(AssertionError('No gateway IO allowed'))
        rows=self.core.dispatch('history_query',{'gateway':'example','alarm':None,'categories':['keypad']})['rows']
        self.assertEqual([r['alarm_id'] for r in rows],[1])
        opts=self.core.dispatch('activity_options',{})
        self.assertFalse(opts['gateways'][0]['alarms'][-1]['observed'])
        self.assertFalse(self.core.discovery_requested['example'].is_set())
    def test_clear_is_exact_and_request_deduplication_survives(self):
        for aid in [1,2]:self.core.history('example',aid).add('User','Keypad','Code accepted','Accepted')
        ledger=self.core.state/'keypad-requests.sqlite';ledger.write_bytes(b'preserved')
        self.core.dispatch('history_clear',{'gateway':'example','alarm':1,'confirmed':True})
        self.assertEqual(self.core.history('example',1).rows(),[])
        self.assertEqual(len(self.core.history('example',2).rows()),1)
        self.assertEqual(ledger.read_bytes(),b'preserved')
    def test_invalid_scope_never_clears_anything(self):
        self.core.history('example',1).add('User','Keypad','Code accepted','Accepted')
        for body in [{'gateway':None,'alarm':1,'confirmed':True},{'gateway':'../example','alarm':None,'confirmed':True},{'gateway':'example','alarm':True,'confirmed':True},{'gateway':'example','alarm':1,'confirmed':False}]:
            with self.assertRaises(Rejected):self.core.dispatch('history_clear',body)
        self.assertEqual(len(self.core.history('example',1).rows()),1)
    def test_retention_is_revision_checked_and_shortening_explicit(self):
        for body in [{'days':3,'expected_days':90,'confirmed':False},{'days':3,'expected_days':30,'confirmed':True}]:
            with self.assertRaises(Rejected):self.core.dispatch('history_retention',body)
        self.assertEqual(self.core.dispatch('history_retention',{'days':3,'expected_days':90,'confirmed':True}),{'retention_days':3})
    def test_observation_blocks_history_mutation(self):
        self.core.config['access_mode']='observe'
        with self.assertRaisesRegex(Rejected,'read_only'):self.core.dispatch('history_clear',{'gateway':None,'alarm':None,'confirmed':True})
    def test_debug_is_scoped_bounded_and_anonymous(self):
        self.call('debug_control',{'action':'start'})
        collector=Collector(self.core)
        for n in range(210):
            event={'type':'invalid','alarm':1,'key':format(n,'032x'),'timestamp':'2026-09-25T00:00:00Z','pin':'PRIVATE','user':'PRIVATE','locked':False}
            self.core.debug_captures[('example',1)].observe(event)
        data=self.call('debug_status');self.assertEqual(len(data['events']),200)
        self.assertNotIn('PRIVATE',json.dumps(data));self.assertEqual(self.call('debug_status',alarm=2)['events'],[])
        with self.assertRaises(Rejected):self.call('debug_status',alarm=99)
    def test_symlink_history_is_refused(self):
        target=self.root/'unrelated';target.write_text('untouched')
        (self.core.state/'activity-example-alarm-1.sqlite').symlink_to(target)
        with self.assertRaises(Rejected):self.core.dispatch('activity_options',{})
        self.assertEqual(target.read_text(),'untouched')

if __name__=='__main__':unittest.main()

class PresentationSecurityTests(unittest.TestCase):
    def test_new_routes_require_session_origin_and_csrf(self):
        import hashlib
        from http.client import HTTPConnection
        from http.server import ThreadingHTTPServer
        import threading
        from unittest.mock import patch
        from configurator import server
        cfg={'salt':'00'*16,'password_hash':hashlib.scrypt(b'fixture',salt=bytes(16),n=16384,r=8,p=1).hex(),'origin':'https://fixture.invalid','socket':'unused'}
        security=server.Security(cfg);token=security.login('fixture');csrf=security.session(token)['csrf']
        http=ThreadingHTTPServer(('127.0.0.1',0),server.handler(cfg,security,Path(__file__).parents[1]/'static'))
        thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
        def call(path,method='GET',session=False,origin=None,csrf_value=None):
            c=HTTPConnection(*http.server_address)
            headers={'Host':'fixture.invalid'}
            if session:headers['Cookie']='__Host-configurator='+token
            if origin:headers['Origin']=origin
            if csrf_value:headers['X-CSRF-Token']=csrf_value
            body=None
            if method=='POST':body='{}';headers['Content-Type']='application/json'
            c.request(method,path,body,headers);r=c.getresponse();r.read();status=r.status;c.close();return status
        try:
            with patch('configurator.server.rpc',return_value={}) as rpc:
                for path in ['/api/administration','/api/activity-options','/api/debug']:
                    self.assertEqual(call(path),401)
                for path in ['/api/history/query','/api/history/clear','/api/history/retention','/api/debug/control']:
                    self.assertEqual(call(path,'POST',True,'https://fixture.invalid'),400)
                    self.assertEqual(call(path,'POST',True,'https://foreign.invalid',csrf),400)
                rpc.assert_not_called()
                self.assertEqual(call('/api/history/query','POST',True,'https://fixture.invalid',csrf),200)
                rpc.assert_called_once_with('unused','authenticated_request',{'account_id':None,'revision':None,'operation':'history_query','body':{}})
        finally:http.shutdown();http.server_close();thread.join(2)
