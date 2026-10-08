"""Synthetic gateway contract and failure-injection tests; no live endpoints."""
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from configurator.common import Rejected
from configurator.core import Core
from configurator.domain import ALARM_TIMINGS
from configurator.editing import unrestricted
from configurator.gateway import GatewayRejected
from support import config, IDENTITY, USER

PIN='1234987609876532'
NEW_PIN='2345987609876501'
OTHER='b'*32


def owner(uid=USER, name='Owner'):
    return {'id':uid,'name':name,'enabled':True,'revision':1,'user_revision':1,
            'grant_enabled':True,'owner':True,'arm':True,'disarm':True,'api_arm_disarm':True,
            'all_keypads':False,'keypads':[],'schedule':None,'remaining_uses':None}


class Model:
    def __init__(self):
        self.identity=IDENTITY
        self.identities={USER:{k:owner()[k] for k in ('id','name','enabled','revision','user_revision')}}
        self.grants={'1':{USER:owner()},'2':{USER:owner()}}
        self.managed={'1':True,'2':True}
        self.pins={USER:PIN}
        self.timings={key:0 for key in ALARM_TIMINGS}
        self.policy={'enabled':True,'threshold':6,'window_seconds':60,'durations_seconds':[60,600,1800],
                     'reset_seconds':3600,'revision':1}
        self.locks=[{'source':'11223344556677','endpoint':1,'remaining_seconds':0,'level':0,'locked_until':0}]
        self.writes=[];self.failure=None;self.mode='accepted';self.race=False
    def factory(self, registration, writable=False):
        model=self
        class Client:
            def verify(self, alarm=None):
                if model.identity!=registration['identity']:raise Rejected('gateway_identity_changed')
                return {'global_users_version':2,'managed':model.managed[str(alarm)],'alarm_timing_version':1,
                        'schedules':True,'schedule_version':1,'keypad_lockout_version':1} if alarm else {'bridgeid':model.identity}
            def request(self,path,method='GET',body=None):
                if method=='GET':return copy.deepcopy(model.read(path))
                if not writable:raise Rejected('candidate_read_only_required')
                model.writes.append((path,method,copy.deepcopy(body)))
                if model.failure=='before':raise Rejected('gateway_result_unknown_no_retry')
                reply=model.change(path,method,body)
                if model.failure=='after':raise Rejected('gateway_result_unknown_no_retry')
                if model.failure=='wrong_reply':return {'id':'f'*32}
                return copy.deepcopy(reply)
            def exchange(self,path,method='GET',body=None):
                if not writable:raise Rejected('candidate_read_only_required')
                model.writes.append((path,method,copy.deepcopy(body)))
                if model.failure:raise Rejected('gateway_result_unknown_no_retry')
                prefix='/'.join(path.split('/')[:-1]);mode=path.rsplit('/',1)[1]
                if model.mode=='accepted':return 200,[{'success':{prefix+'/config/armmode':{'disarm':'disarmed','arm_stay':'armed_stay','arm_away':'armed_away','arm_night':'armed_night'}[mode]}}]
                if model.mode=='rejected':return 400,[{'error':{'type':7,'address':prefix+'/code0','description':'invalid value, [redacted], for parameter, code0'}}]
                return 200,{'unexpected':'response'}
        return Client()
    def read(self,path):
        if path=='/alarmsystems/users':return self.identities
        if path=='/alarmsystems':return {aid:{'name':'Alarm '+aid} for aid in self.grants}
        if path=='/sensors':return {}
        if path.endswith('/capabilities'):return {'global_users_version':2,'managed':self.managed[path.split('/')[2]],
            'alarm_timing_version':1,'schedules':True,'schedule_version':1,'keypad_lockout_version':1}
        if path.endswith('/lockout'):return {'policy':self.policy,'keypads':self.locks}
        if path.endswith('/users'):
            aid=path.split('/')[2]
            return {uid:dict(row,**{k:self.identities[uid][k] for k in ('name','enabled','user_revision')}) for uid,row in self.grants[aid].items()}
        if path.startswith('/alarmsystems/'):
            return {'config':{'armmode':'disarmed',**self.timings},'state':{'armstate':'disarmed','seconds_remaining':0}}
        raise AssertionError(path)
    def change(self,path,method,body):
        if path.endswith('/config'):
            self.timings.update(body);return [{'success':{path+'/'+k:v}} for k,v in body.items()]
        if path.endswith('/lockout'):
            if method=='PUT':self.policy=dict(body,revision=body['revision']+1)
            if method=='DELETE' or not self.policy['enabled']:self.locks=[]
            return {'policy':self.policy,'keypads':self.locks}
        if path.startswith('/alarmsystems/users/'):
            uid=path.split('/')[-1]
            if any(uid in rows and any(other!=uid and self.pins.get(other)==body['pin'] for other in rows) for rows in self.grants.values()):
                raise GatewayRejected('pin_already_assigned',definite=True)
            self.identities[uid].update(name=body['name'],enabled=body['enabled'],revision=body['revision']+1,user_revision=body['user_revision']+1)
            self.pins[uid]=body['pin'];return self.identities[uid]
        aid=path.split('/')[2];uid=path.split('/')[-1] if method!='POST' else OTHER
        if method=='DELETE':del self.grants[aid][uid];return {'deleted':uid}
        existing=self.identities.get(uid)
        attaching=existing is not None and uid not in self.grants[aid]
        if attaching and self.pins[uid]!=body['pin']:raise GatewayRejected('current_pin_required',definite=True)
        if 'pin' in body and any(other!=uid and self.pins.get(other)==body['pin'] for other in self.grants[aid]):
            raise GatewayRejected('pin_already_assigned',definite=True)
        changed=existing is None or existing['name']!=body['name'] or existing['enabled']!=body['enabled']
        self.identities[uid]={'id':uid,'name':body['name'],'enabled':body['enabled'],
            'revision':body['user_revision']+int(changed),'user_revision':body['user_revision']+int(changed)}
        if 'pin' in body and not attaching:self.pins[uid]=body['pin']
        row={k:v for k,v in body.items() if k!='pin'}
        row.update(id=uid,revision=body['revision']+1,user_revision=self.identities[uid]['user_revision'])
        row.setdefault('schedule',None);self.grants[aid][uid]=row;self.managed[aid]=True
        return row


class Participant:
    api_version=1
    def __init__(self, fail=None):self.fail=fail;self.calls=[]
    def invoke(self,name,tx):
        self.calls.append(name)
        if name==self.fail:raise RuntimeError('private details must not escape')
    def preflight(self,tx):self.invoke('preflight',tx)
    def pause(self,tx):self.invoke('pause',tx)
    def verify(self,tx):self.invoke('verify',tx)
    def resume(self,tx):self.invoke('resume',tx)


class EditingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.model=Model();self.backups=self.root/'backups';self.backups.mkdir(mode=0o700)
        registration={'id':'test','name':'Test gateway','identity':IDENTITY,'endpoint':'http://127.0.0.1:1','key':'test-key'}
        self.cfg=config(self.root,[registration]);self.cfg.update(schema=2,access_mode='manage',backup_root=str(self.backups))
        self.core=Core(self.cfg,self.model.factory)
    def tearDown(self):self.temp.cleanup()
    def call(self,op,body=None,alarm=1):
        return self.core.dispatch('gateway_request',{'gateway':'test','alarm':alarm,'operation':op,'body':body or {}})
    def draft(self,uid=USER,alarm=1):
        return dict(self.model.read('/alarmsystems/'+str(alarm)+'/users')[uid],alarm=alarm,backup_acknowledged=True)
    def assert_no_secret(self):
        for path in self.root.rglob('*'):
            if path.is_file():
                for pin in (PIN,NEW_PIN):self.assertNotIn(pin.encode(),path.read_bytes(),str(path))

    def test_transport_only_classifies_exact_validation_errors_as_definite(self):
        from configurator.gateway import Gateway
        client=Gateway(self.cfg['gateways'][0],writable=True)
        path='/alarmsystems/1/users/'+USER
        for reason,address,definite in [('invalid_pin','/alarmsystems/1/users',True),
                                        ('invalid_pin','/alarmsystems/2/users',False),
                                        ('storage_error','/alarmsystems/1/users',False)]:
            client.exchange=lambda *args:(400,[{'error':{'type':7,'address':address,'description':reason}}])
            with self.assertRaises(GatewayRejected) as caught:client.request(path,'PUT',{})
            self.assertEqual(caught.exception.definite,definite)

    def test_readonly_remains_default_and_management_requires_private_backup(self):
        cfg=copy.deepcopy(self.cfg);cfg['access_mode']='observe';self.core=Core(cfg,self.model.factory)
        with self.assertRaisesRegex(Rejected,'read_only'):self.call('save_user',self.draft())
        self.assertEqual(self.model.writes,[])
        self.backups.chmod(0o755)
        with self.assertRaisesRegex(Rejected,'private_directory'):Core(self.cfg,self.model.factory)

    def test_global_name_and_selected_grant_updates_preserve_other_alarm_access(self):
        draft=self.draft();draft['name']='Renamed owner';self.assertTrue(self.call('save_user',draft)['saved'])
        self.assertEqual(self.model.read('/alarmsystems/2/users')[USER]['name'],'Renamed owner')
        self.assertEqual(self.model.grants['2'][USER]['revision'],1)
        self.assertTrue(self.core.discovery_requested['test'].is_set())
        self.assertEqual(self.call('transaction_status')['stage'],'complete')
        receipt=json.loads(next(self.backups.rglob('receipt.json')).read_text())
        self.assertFalse(receipt['credential_backup']);self.assertFalse(receipt['automatic_restore'])
        self.assert_no_secret()

    def test_last_owner_and_global_disable_are_blocked_across_alarms(self):
        self.model.identities[OTHER]={k:owner(OTHER)[k] for k in ('id','name','enabled','revision','user_revision')}
        self.model.grants['1'][OTHER]=owner(OTHER)
        draft=self.draft();draft['enabled']=False
        with self.assertRaisesRegex(Rejected,'last_unrestricted_owner'):self.call('save_user',draft)
        with self.assertRaisesRegex(Rejected,'last_unrestricted_owner'):
            self.call('delete_user',{'id':USER,'alarm':2,'revision':1,'user_revision':1,'backup_acknowledged':True},2)
        self.assertEqual(self.model.writes,[])

    def test_schedules_uses_and_keypads_are_per_alarm_and_stale_revision_rejected(self):
        self.model.identities[OTHER]={k:owner(OTHER)[k] for k in ('id','name','enabled','revision','user_revision')}
        self.model.grants['1'][OTHER]=owner(OTHER)
        draft=self.draft();draft.update(owner=False,remaining_uses=5,keypads=[{'source':'abc','endpoint':1}],
            schedule={'timezone':'UTC','not_before':None,'expires_local':'','weekly':'Mon 09:00-10:00'})
        self.assertTrue(self.call('save_user',draft)['saved'])
        self.assertEqual(self.model.grants['1'][USER]['remaining_uses'],5)
        self.assertIsNone(self.model.grants['2'][USER]['remaining_uses'])
        with self.assertRaisesRegex(Rejected,'revision_conflict'):self.call('save_user',draft)
        self.assertEqual(len(self.model.writes),1)

    def test_enrollment_and_existing_identity_attachment_are_explicit(self):
        self.model.grants['2']={};self.model.managed['2']=False
        draft=dict(owner(),alarm=2,revision=0,pin=PIN,backup_acknowledged=True)
        with self.assertRaisesRegex(Rejected,'explicit_owner_enrollment'):self.call('save_user',draft,2)
        draft['enable_management']=True
        self.assertTrue(self.call('save_user',draft,2)['saved'])
        self.assertEqual(self.model.identities[USER]['user_revision'],1)
        self.assertEqual(self.model.pins[USER],PIN)
        self.assert_no_secret()

    def test_explicit_credential_rejection_finishes_without_ambiguity_or_retry(self):
        self.model.grants['2']={};self.model.managed['2']=False
        draft=dict(owner(),alarm=2,revision=0,pin='9999',backup_acknowledged=True,enable_management=True)
        with self.assertRaisesRegex(Rejected,'current_pin_required'):self.call('save_user',draft,2)
        self.assertEqual(self.call('transaction_status')['stage'],'complete')
        self.assertEqual(len(self.model.writes),1)
        draft['pin']=PIN
        self.assertTrue(self.call('save_user',draft,2)['saved'])
        self.assertEqual(len(self.model.writes),2)

    def test_gateway_pin_collision_is_a_definite_rejection(self):
        draft=dict(owner(None,'Second owner'),alarm=1,revision=0,user_revision=0,pin=PIN,backup_acknowledged=True)
        with self.assertRaisesRegex(Rejected,'pin_already_assigned'):self.call('save_user',draft)
        self.assertEqual(self.call('transaction_status')['outcome'],'rejected')
        self.assertNotIn(OTHER,self.model.identities)
        self.assertEqual(len(self.model.writes),1)
        self.assert_no_secret()

    def test_new_identity_creation_and_removing_one_grant(self):
        draft=dict(owner(None,'Second owner'),alarm=1,revision=0,user_revision=0,pin=NEW_PIN,backup_acknowledged=True)
        self.assertTrue(self.call('save_user',draft)['saved'])
        self.assertIn(OTHER,self.model.grants['1']);self.assertNotIn(OTHER,self.model.grants['2'])
        self.assertTrue(self.call('delete_user',{'id':OTHER,'alarm':1,'revision':1,'user_revision':1,'backup_acknowledged':True})['saved'])
        self.assertIn(OTHER,self.model.identities)
        self.assert_no_secret()

    def test_pin_rotation_is_global_no_alarm_command_and_no_saved_pin(self):
        draft=self.draft();draft['pin']=PIN
        with self.assertRaisesRegex(Rejected,'coordinated_pin'):self.call('save_user',draft)
        result=self.call('rotate_pin',{'id':USER,'revision':1,'user_revision':1,'new_pin':PIN,'repeat_pin':PIN,'backup_acknowledged':True})
        self.assertTrue(result['saved']);self.assertEqual(len(self.model.writes),1)
        self.assertEqual(self.model.writes[0][0],'/alarmsystems/users/'+USER)
        self.assertEqual(self.model.read('/alarmsystems/2/users')[USER]['user_revision'],2)
        self.assert_no_secret()

    def test_uncertain_credential_persists_blocks_retry_and_cannot_use_policy_as_proof(self):
        self.model.failure='after'
        body={'id':USER,'revision':1,'user_revision':1,'new_pin':PIN,'repeat_pin':PIN,'backup_acknowledged':True}
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.call('rotate_pin',body)
        self.core=Core(self.cfg,self.model.factory)
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.call('rotate_pin',body)
        review=self.call('review_recovery');self.assertFalse(review['ready']);self.assertIsNone(review['token'])
        self.assertEqual(len(self.model.writes),1)
        self.assert_no_secret()

    def test_no_retry_after_timeout_before_gateway_received_request(self):
        self.model.failure='before'
        with self.assertRaises(Rejected):self.call('save_user',self.draft())
        self.model.failure=None
        self.assertFalse(self.call('review_recovery')['ready'])
        with self.assertRaises(Rejected):self.call('save_user',self.draft())
        self.assertEqual(len(self.model.writes),1)

    def test_policy_recovery_is_reviewed_scoped_fresh_and_never_replays(self):
        self.model.failure='after';draft=self.draft();draft['name']='Updated'
        with self.assertRaises(Rejected):self.call('save_user',draft)
        self.core=Core(self.cfg,self.model.factory)
        review=self.call('review_recovery');self.assertTrue(review['ready'])
        bad={'transaction_id':'f'*32,'token':review['token'],'reviewed':True}
        with self.assertRaises(Rejected):self.call('recover_transaction',bad)
        review=self.call('review_recovery')
        result=self.call('recover_transaction',{'transaction_id':review['transaction_id'],'token':review['token'],'reviewed':True})
        self.assertFalse(result['gateway_write_replayed']);self.assertEqual(len(self.model.writes),1)

    def test_missing_registered_participant_and_failed_resume_keep_obligations(self):
        participant=Participant('resume');self.core=Core(self.cfg,self.model.factory,participants={'neutral-safety':participant})
        with self.assertRaises(Rejected):self.call('save_user',self.draft())
        self.assertEqual(participant.calls,['preflight','pause','verify','resume'])
        self.core=Core(self.cfg,self.model.factory)
        with self.assertRaisesRegex(Rejected,'participant_unavailable'):self.call('review_recovery')
        with self.assertRaisesRegex(Rejected,'participant_unavailable'):self.call('save_user',self.draft())
        participant.fail=None;self.core=Core(self.cfg,self.model.factory,participants={'neutral-safety':participant})
        review=self.call('review_recovery');self.assertTrue(review['ready'])
        self.call('recover_transaction',{'transaction_id':review['transaction_id'],'token':review['token'],'reviewed':True})
        self.assertEqual(len(self.model.writes),1)

    def test_pause_failure_records_obligation_before_pause_and_prevents_write(self):
        participant=Participant('pause');self.core=Core(self.cfg,self.model.factory,participants={'neutral-safety':participant})
        with self.assertRaises(Rejected):self.call('save_user',self.draft())
        tx=self.core.transactions.load('test');self.assertEqual(tx['paused'],['neutral-safety']);self.assertFalse(tx['write_attempted'])
        self.assertEqual(self.model.writes,[])

    def test_backup_failure_and_concurrent_revision_change_never_issue_write(self):
        class BrokenBackup:
            api_version=1
            def save(self,context,snapshot):raise OSError('synthetic disk full')
        self.core=Core(self.cfg,self.model.factory,backup=BrokenBackup())
        with self.assertRaises(Rejected):self.call('save_user',self.draft())
        self.assertFalse(self.core.transactions.load('test')['write_attempted'])
        review=self.call('review_recovery')
        self.call('recover_transaction',{'transaction_id':review['transaction_id'],'token':review['token'],'reviewed':True})
        normal=Core(self.cfg,self.model.factory).backup;model=self.model
        class RacedBackup:
            api_version=1
            def save(self,context,snapshot):
                receipt=normal.save(context,snapshot)
                model.grants['1'][USER]['revision']+=1
                return receipt
        self.core=Core(self.cfg,self.model.factory,backup=RacedBackup())
        with self.assertRaises(Rejected):self.call('save_user',self.draft())
        self.assertFalse(self.core.transactions.load('test')['write_attempted'])
        self.assertEqual(self.model.writes,[])

    def test_cross_alarm_scope_and_stale_recovery_review(self):
        participant=Participant();participant.context=None
        participant.preflight=lambda context:setattr(participant,'context',context)
        self.core=Core(self.cfg,self.model.factory,participants={'neutral-safety':participant})
        draft=self.draft();draft['name']='Renamed';self.model.failure='after'
        with self.assertRaises(Rejected):self.call('save_user',draft)
        self.assertEqual(participant.context['affected_alarms'],[1,2])
        self.assertTrue(participant.context['gateway_wide_identity_change'])
        review=self.call('review_recovery');self.assertTrue(review['ready'])
        self.model.identities[USER]['user_revision']+=1
        with self.assertRaisesRegex(Rejected,'evidence_changed'):
            self.call('recover_transaction',{'transaction_id':review['transaction_id'],'token':review['token'],'reviewed':True})
        self.assertEqual(self.call('transaction_status')['stage'],'recovery_required')
        self.assertNotIn('resume',participant.calls)

    def test_trusted_external_evidence_is_bound_to_transaction_and_never_retries(self):
        self.model.failure='after'
        with self.assertRaises(Rejected):self.call('rotate_pin',{'id':USER,'revision':1,'user_revision':1,
            'new_pin':PIN,'repeat_pin':PIN,'backup_acknowledged':True})
        expected=self.core.transactions.load('test')['id']
        class Evidence:
            api_version=1
            def verify(self,tx):return tx['id']==expected and tx['identity']==IDENTITY
        self.core=Core(self.cfg,self.model.factory,recovery_evidence=Evidence())
        review=self.call('review_recovery');self.assertTrue(review['ready'])
        self.call('recover_transaction',{'transaction_id':expected,'token':review['token'],'reviewed':True})
        self.assertEqual(len(self.model.writes),1);self.assert_no_secret()

    def test_transaction_lock_prevents_competing_core_instance(self):
        with self.core.transactions.locked('test'):
            other=Core(self.cfg,self.model.factory)
            with self.assertRaisesRegex(Rejected,'transaction_in_progress'):
                other.dispatch('gateway_request',{'gateway':'test','alarm':1,'operation':'save_user','body':self.draft()})
        self.assertEqual(self.model.writes,[])

    def test_schedule_dst_and_malformed_window_fail_before_writing(self):
        from configurator.schedule import policy
        for weekly,expiry in [('Mon 24:00-24:01',''),('','2026-03-08T02:30'),('','2026-11-01T01:30')]:
            with self.assertRaises(Rejected):policy({'timezone':'America/New_York','weekly':weekly,'expires_local':expiry,'not_before':None})
        self.assertEqual(self.model.writes,[])

    def test_timing_lockout_and_explicit_reset(self):
        current=self.call('alarm');timings=dict(current['timings']);timings['armed_away_exit_delay']=30
        self.assertTrue(self.call('save_alarm',{'timings':timings,'revision':current['revision'],'backup_acknowledged':True})['saved'])
        policy=dict(self.model.policy,threshold=8,backup_acknowledged=True)
        self.assertTrue(self.call('save_lockout',policy)['saved'])
        self.assertTrue(self.call('reset_lockout',{'reset':True,'backup_acknowledged':True})['saved'])
        self.assertEqual(len(self.model.writes),3)

    def test_keypad_accept_reject_duplicate_restart_and_history_clear(self):
        request={'code':PIN,'mode':'disarm','request_id':'c'*32}
        self.assertEqual(self.call('keypad_send',request)['result'],'accepted')
        self.core.history('test',1).clear();self.core=Core(self.cfg,self.model.factory)
        self.assertEqual(self.call('keypad_send',request)['result'],'duplicate')
        self.model.mode='rejected';request['request_id']='d'*32
        self.assertEqual(self.call('keypad_send',request)['result'],'rejected')
        self.assertEqual(len(self.model.writes),2)
        self.assert_no_secret()

    def test_keypad_ambiguity_holds_and_never_uses_alarm_state_for_recovery(self):
        self.model.failure='before';request={'code':PIN,'mode':'disarm','request_id':'c'*32}
        result=self.call('keypad_send',request);self.assertTrue(result['uncertain'])
        self.core=Core(self.cfg,self.model.factory)
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.call('keypad_send',request)
        self.assertFalse(self.call('review_recovery')['ready']);self.assertEqual(len(self.model.writes),1)
        self.assert_no_secret()
