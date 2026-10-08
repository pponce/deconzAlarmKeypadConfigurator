"""Synthetic same-host cache/service tests. Never invokes installed services."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from configurator.common import Rejected, atomic
from configurator.core import Core
from configurator.homebridge_local import SECURITY, pin_context, replace_cache
from support import config, IDENTITY, USER
from test_editing import Model, PIN, NEW_PIN, OTHER, owner


def cache():
    return [{'platform':'deCONZ','context':{'id':'alarm-'+str(a),'context':{'gid':IDENTITY},
            SECURITY:{'pin':PIN}},'services':[{'UUID':SECURITY}]} for a in (1,2)]


class Host:
    def __init__(self,root):
        self.path=root/'cache.json';atomic(self.path,cache());self.config=b'{"platforms":[]}'
        self.running=True;self.pid=100;self.calls=[];self.fail=None
    def files(self):
        if self.fail=='sources':raise Rejected('homebridge_source_changed_review_required')
        return self.path,self.path.read_bytes(),self.config
    def resolve(self,raw,binding):
        if self.fail=='restart' and self.pid!=100:raise Rejected('homebridge_restart_unverified')
        if not self.running:raise Rejected('homebridge_listener_unverified')
        return {str(a):'alarm-'+str(a) for a in binding['alarms']},self.pid
    def stop(self,pid):
        self.calls.append('stop')
        if self.fail=='stop':raise Rejected('homebridge_stop_not_confirmed')
        self.running=False
    def assert_stopped(self,pid):
        if self.running:raise Rejected('homebridge_stop_not_confirmed')
    def replace(self,path,old,new):
        self.calls.append('replace')
        if self.fail=='replace':raise Rejected('homebridge_cache_changed')
        replace_cache(path,old,new)
    def start(self):self.calls.append('start');self.running=True;self.pid+=1


class HomebridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.backups=self.root/'backups';self.backups.mkdir(mode=0o700)
        self.model=Model();self.host=Host(self.root)
        registration={'id':'test','name':'Test gateway','identity':IDENTITY,'endpoint':'http://127.0.0.1:1','key':'test-key'}
        self.cfg=config(self.root,[registration]);self.cfg.update(schema=2,access_mode='manage',backup_root=str(self.backups))
        self.cfg['homebridge']={'schema':1,'profile':'local-hb-service','storage':str(self.root),
            'package':str(self.root/'plugin'),'bindings':[{'gateway':'test','identity':IDENTITY,'user':USER,'alarms':[1,2]}]}
        self.restart()
    def tearDown(self):self.temp.cleanup()
    def restart(self):self.core=Core(copy.deepcopy(self.cfg),self.model.factory,homebridge_host=self.host)
    def call(self,op,body=None,alarm=1):
        return self.core.dispatch('gateway_request',{'gateway':'test','alarm':alarm,'operation':op,'body':body or {}})
    def rotate(self):
        return self.call('rotate_pin',{'id':USER,'revision':1,'user_revision':1,'new_pin':NEW_PIN,'repeat_pin':NEW_PIN,'backup_acknowledged':True})
    def test_selected_rotation_updates_every_explicit_alarm_only_after_gateway_ack(self):
        self.assertTrue(self.rotate()['saved'])
        self.assertEqual(self.host.calls,['stop','replace','start'])
        self.assertEqual(self.model.pins[USER],NEW_PIN)
        for a in (1,2):self.assertEqual(pin_context(json.loads(self.host.path.read_bytes()),IDENTITY,'alarm-'+str(a))['pin'],NEW_PIN)
        self.assertFalse(self.core.homebridge.status()['pending'])
        self.assertIsNone(self.core.homebridge.pin)
        for path in Path(self.cfg['state']).rglob('*'):
            if path.is_file():
                for pin in (PIN,NEW_PIN):self.assertNotIn(pin.encode(),path.read_bytes())
        for path in self.backups.rglob('*'):
            if path.is_file():self.assertEqual(path.stat().st_mode & 0o077,0)
    def test_pending_gateway_write_holds_service_and_cannot_be_retried_or_disabled(self):
        self.model.failure='after'
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.rotate()
        self.assertEqual(self.host.calls,['stop']);self.assertFalse(self.host.running)
        self.restart()
        with self.assertRaisesRegex(Rejected,'shared_service'):self.rotate()
        self.assertFalse(self.call('review_recovery')['ready'])
        cfg=copy.deepcopy(self.cfg);cfg['homebridge']=None
        with self.assertRaisesRegex(Rejected,'registered_homebridge'):Core(cfg,self.model.factory)
        self.assertEqual(len(self.model.writes),1)
    def test_verified_write_cache_failure_recovers_without_second_gateway_write(self):
        self.host.fail='replace'
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.rotate()
        self.assertFalse(self.host.running)
        self.host.fail=None;self.restart()
        review=self.call('review_recovery');self.assertTrue(review['ready'])
        self.assertTrue(self.call('recover_transaction',{'transaction_id':review['transaction_id'],'token':review['token'],'reviewed':True})['recovered'])
        self.assertEqual(len(self.model.writes),1);self.assertTrue(self.host.running)
    def test_definite_rejection_restarts_with_original_cache(self):
        self.model.identities[OTHER]={k:owner(OTHER)[k] for k in ('id','name','enabled','revision','user_revision')}
        self.model.grants['1'][OTHER]=owner(OTHER);self.model.pins[OTHER]=NEW_PIN
        with self.assertRaises(Rejected):self.rotate()
        self.assertEqual(self.host.calls,['stop','start'])
        self.assertTrue(self.host.running);self.assertEqual(self.model.pins[USER],PIN)
        self.assertFalse(self.core.homebridge.status()['pending'])
    def test_protected_grants_and_global_disable_no_service_or_gateway_writes(self):
        self.model.identities[OTHER]={k:owner(OTHER)[k] for k in ('id','name','enabled','revision','user_revision')}
        for a in ('1','2'):self.model.grants[a][OTHER]=owner(OTHER)
        for field,value in [('enabled',False),('grant_enabled',False),('api_arm_disarm',False),('remaining_uses',3)]:
            draft=dict(self.model.read('/alarmsystems/2/users')[USER],alarm=2,backup_acknowledged=True)
            draft[field]=value
            with self.assertRaisesRegex(Rejected,'homebridge_user'):self.call('save_user',draft,2)
        with self.assertRaisesRegex(Rejected,'homebridge_user'):
            self.call('delete_user',{'id':USER,'alarm':2,'revision':1,'user_revision':1,'backup_acknowledged':True},2)
        self.assertEqual(self.host.calls,[]);self.assertEqual(self.model.writes,[])
    def test_ordinary_rename_does_not_restart_homebridge(self):
        draft=dict(self.model.read('/alarmsystems/1/users')[USER],name='Renamed',alarm=1,backup_acknowledged=True)
        self.assertTrue(self.call('save_user',draft)['saved']);self.assertEqual(self.host.calls,[])
    def test_source_or_stop_failure_never_writes_gateway(self):
        self.host.fail='sources'
        with self.assertRaisesRegex(Rejected,'preflight'):self.rotate()
        self.assertEqual(self.host.calls,[]);self.assertEqual(self.model.writes,[])
        self.host.fail='stop'
        with self.assertRaisesRegex(Rejected,'recovery'):self.rotate()
        self.assertEqual(self.model.writes,[]);self.assertTrue(self.core.homebridge.status()['pending'])
    def test_no_shell_fields_remote_profile_duplicate_or_implicit_bindings(self):
        from configurator.configuration import validate
        for change in ({'profile':'remote'},{'command':'echo unsafe'},{'bindings':[]}):
            cfg=copy.deepcopy(self.cfg);cfg['homebridge'].update(change)
            with self.assertRaises(Rejected):validate(cfg)
        cfg=copy.deepcopy(self.cfg);cfg['homebridge']['bindings'][0]['alarms']=[1,1]
        with self.assertRaises(Rejected):validate(cfg)

    def test_shared_hold_blocks_unrelated_gateway_without_any_write(self):
        other=Model();other.identity='8899AABBCCDDEEFF'
        self.cfg['gateways'].append(dict(self.cfg['gateways'][0],id='second',identity=other.identity))
        factory=lambda registration,writable=False:(self.model if registration['id']=='test' else other).factory(registration,writable)
        self.core=Core(self.cfg,factory,homebridge_host=self.host)
        self.model.failure='after'
        with self.assertRaises(Rejected):self.rotate()
        body=dict(other.read('/alarmsystems/1/users')[USER],alarm=1,backup_acknowledged=True,name='Changed')
        with self.assertRaisesRegex(Rejected,'shared_service'):
            self.core.dispatch('gateway_request',{'gateway':'second','alarm':1,'operation':'save_user','body':body})
        self.assertEqual(other.writes,[])

    def test_participant_resume_failure_keeps_shared_hold_and_does_not_restart_twice(self):
        class Participant:
            api_version=1
            fail=True
            def preflight(self,context):pass
            def pause(self,tx):pass
            def verify(self,tx):pass
            def resume(self,tx):
                if self.fail:raise Rejected('fixture_hold')
        participant=Participant()
        self.core=Core(self.cfg,self.model.factory,participants={'fixture':participant},homebridge_host=self.host)
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.rotate()
        self.assertTrue(self.host.running);self.assertTrue(self.core.homebridge.status()['pending'])
        self.core=Core(self.cfg,self.model.factory,homebridge_host=self.host)
        with self.assertRaisesRegex(Rejected,'participant_unavailable'):self.call('review_recovery')
        participant.fail=False
        self.core=Core(self.cfg,self.model.factory,participants={'fixture':participant},homebridge_host=self.host)
        review=self.call('review_recovery')
        self.call('recover_transaction',{'transaction_id':review['transaction_id'],'token':review['token'],'reviewed':True})
        self.assertEqual(self.host.calls.count('start'),1)
        self.assertFalse(self.core.homebridge.status()['pending'])

    def test_local_cache_refuses_symlink_permissions_and_stale_replacement(self):
        from configurator.homebridge_local import private_read
        link=self.root/'linked';link.symlink_to(self.host.path)
        with self.assertRaises(Rejected):private_read(link)
        self.host.path.chmod(0o666)
        with self.assertRaises(Rejected):private_read(self.host.path)
        self.host.path.chmod(0o600)
        before=self.host.path.read_bytes()
        with self.assertRaises(Rejected):replace_cache(self.host.path,b'changed',b'[]')
        self.assertEqual(self.host.path.read_bytes(),before)

    def test_binding_scope_preserves_other_cached_credentials(self):
        rows=cache()
        extra=copy.deepcopy(rows[0]);extra['context']['id']='unbound';extra['context'][SECURITY]['pin']='45678901';rows.append(extra)
        atomic(self.host.path,rows)
        self.rotate()
        self.assertEqual(pin_context(json.loads(self.host.path.read_bytes()),IDENTITY,'unbound')['pin'],'45678901')

    def test_changed_revision_after_restart_keeps_hold(self):
        original=self.host.start
        def start():
            original();self.model.identities[USER]['user_revision']+=1
        self.host.start=start
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.rotate()
        self.assertTrue(self.core.homebridge.status()['pending'])
        self.assertFalse(self.call('review_recovery')['ready'])

    def test_local_resolution_uses_only_verified_loopback_listing(self):
        from unittest.mock import patch
        from configurator.homebridge import LocalHost
        host=LocalHost(self.cfg['homebridge'])
        raw=json.dumps(cache()+[{'platform':'deCONZ','context':{'className':'Gateway','id':IDENTITY,'uiPort':12345}}]).encode()
        binding=self.cfg['homebridge']['bindings'][0]
        response={ 'alarm-'+str(a):{'type':'alarmsystems','resources':['/alarmsystems/'+str(a)]} for a in (1,2)}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,limit):return json.dumps(response).encode()
        requests=[]
        class Opener:
            def open(self,request,timeout):requests.append(request);return Response()
        with patch('configurator.homebridge.listener_owner',return_value=100),patch('configurator.homebridge.build_opener',return_value=Opener()):
            mapping,pid=host.resolve(raw,binding)
            self.assertEqual(mapping,{'1':'alarm-1','2':'alarm-2'});self.assertEqual(pid,100)
            response['duplicate']=response['alarm-1']
            with self.assertRaisesRegex(Rejected,'one_homebridge_alarm'):host.resolve(raw,binding)
        self.assertTrue(all(r.full_url=='http://127.0.0.1:12345/gateways/'+IDENTITY+'/accessories' and r.get_method()=='GET' for r in requests))
        self.assertTrue(all(r.data is None for r in requests))

    def test_reviewed_source_profile_rejects_other_versions(self):
        from unittest.mock import patch
        from configurator.homebridge import LocalHost
        from configurator.homebridge_sources import EXPECTED
        host=LocalHost(self.cfg['homebridge'])
        with patch('configurator.homebridge.inspect',return_value=copy.deepcopy(EXPECTED)):host.sources()
        changed=copy.deepcopy(EXPECTED);changed['plugin']['version']='0.0.0'
        with patch('configurator.homebridge.inspect',return_value=changed):
            with self.assertRaisesRegex(Rejected,'source_changed'):host.sources()

    def test_restart_verification_failure_recovers_without_second_start(self):
        self.host.fail='restart'
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.rotate()
        self.assertTrue(self.core.homebridge.status()['pending'])
        self.host.fail=None;self.restart()
        review=self.call('review_recovery')
        self.call('recover_transaction',{'transaction_id':review['transaction_id'],'token':review['token'],'reviewed':True})
        self.assertEqual(self.host.calls.count('start'),1);self.assertEqual(len(self.model.writes),1)

    def test_failed_earlier_participant_retains_shared_service_obligation(self):
        class Participant:
            api_version=1
            def preflight(self,context):pass
            def pause(self,tx):raise Rejected('fixture_pause_failed')
            def verify(self,tx):pass
            def resume(self,tx):pass
        self.core=Core(self.cfg,self.model.factory,participants={'fixture':Participant()},homebridge_host=self.host)
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.rotate()
        self.assertIsNone(self.core.homebridge.record())
        with self.assertRaisesRegex(Rejected,'shared_service'):self.core.homebridge.guard()
        self.assertEqual(self.host.calls,[]);self.assertEqual(self.model.writes,[])

    def test_backup_permissions_rechecked_before_stopping_or_staging_credentials(self):
        self.backups.chmod(0o755)
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.rotate()
        self.assertEqual(self.host.calls,[]);self.assertEqual(self.model.writes,[])
        self.assertEqual(list(self.backups.iterdir()),[])
