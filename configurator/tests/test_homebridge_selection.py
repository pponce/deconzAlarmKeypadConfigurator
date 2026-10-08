"""Selection uses the credential transaction, including interruption recovery."""
import copy
import json
from configurator.common import Rejected
from support import USER, IDENTITY
from test_editing import OTHER, owner, PIN, NEW_PIN
import unittest
import test_homebridge
from configurator.common import atomic

class SelectionTests(unittest.TestCase):
    tearDown=test_homebridge.HomebridgeTests.tearDown
    restart=test_homebridge.HomebridgeTests.restart
    call=test_homebridge.HomebridgeTests.call
    # Reuse the synthetic host setup, without inheriting the baseline test cases.
    def setUp(self):
        test_homebridge.HomebridgeTests.setUp(self)
        row=owner(OTHER,'Service user')
        self.model.identities[OTHER]={k:row[k] for k in ('id','name','enabled','revision','user_revision')}
        for aid in ('1','2'):self.model.grants[aid][OTHER]=copy.deepcopy(row)
        self.model.pins[OTHER]='45678901'
    def select(self,**changes):
        body={'id':OTHER,'revision':1,'user_revision':1,'new_pin':NEW_PIN,'repeat_pin':NEW_PIN,
              'backup_acknowledged':True,'homebridge_selection':{'expected_user_id':USER,'alarms':[1,2]}}
        body.update(changes)
        return self.call('rotate_pin',body)
    def test_selection_persists_and_preserves_previous_identity(self):
        before=copy.deepcopy(self.model.grants)
        self.assertTrue(self.select()['saved'])
        self.assertEqual(self.model.pins[USER],PIN)
        self.assertEqual(self.model.grants,before)
        self.restart()
        self.assertEqual(self.core.homebridge.status()['bindings'][0]['user'],OTHER)
        self.assertEqual(self.host.calls,['stop','replace','start'])
        self.assertEqual(len(self.model.writes),1)
        saved=(self.core.state/'homebridge-selections.json').read_text()
        for pin in (PIN,NEW_PIN,'45678901'):self.assertNotIn(pin,saved)
    def test_stale_binding_and_removed_alarm_fail_before_effects(self):
        for value in ({'expected_user_id':OTHER,'alarms':[1,2]}, {'expected_user_id':USER,'alarms':[1]}):
            with self.assertRaises(Rejected):self.select(homebridge_selection=value)
        self.assertEqual(self.host.calls,[]);self.assertEqual(self.model.writes,[])
    def test_each_alarm_must_already_have_unrestricted_access(self):
        self.model.grants['2'][OTHER]['remaining_uses']=2
        with self.assertRaises(Rejected):self.select()
        self.assertEqual(self.host.calls,[]);self.assertEqual(self.model.writes,[])
    def test_selection_cache_failure_recovers_once_and_commits_binding(self):
        self.host.fail='replace'
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.select()
        self.assertEqual(self.core.homebridge.status()['bindings'][0]['user'],USER)
        self.host.fail=None;self.restart()
        review=self.call('review_recovery');self.assertTrue(review['ready'])
        self.call('recover_transaction',{'transaction_id':review['transaction_id'],'token':review['token'],'reviewed':True})
        self.assertEqual(self.core.homebridge.status()['bindings'][0]['user'],OTHER)
        self.assertEqual(len(self.model.writes),1);self.assertEqual(self.host.calls.count('start'),1)
    def test_rejected_selection_keeps_previous_binding(self):
        with self.assertRaises(Rejected):self.select(new_pin=PIN,repeat_pin=PIN)
        self.restart()
        self.assertEqual(self.core.homebridge.status()['bindings'][0]['user'],USER)
        self.assertEqual(self.host.calls,['stop','start'])
    def test_additional_explicit_alarm_is_synchronized(self):
        self.model.managed['3']=True
        self.model.grants['3']=copy.deepcopy(self.model.grants['2'])
        rows=json.loads(self.host.path.read_text());third=copy.deepcopy(rows[1]);third['context']['id']='alarm-3';rows.append(third);atomic(self.host.path,rows)
        self.assertTrue(self.select(homebridge_selection={'expected_user_id':USER,'alarms':[1,2,3]})['saved'])
        self.assertEqual(self.core.homebridge.status()['bindings'][0]['alarms'],[1,2,3])

    def test_missing_committed_selection_never_reverts_to_static_binding(self):
        self.select()
        (self.core.state/'homebridge-selections.json').unlink()
        with self.assertRaisesRegex(Rejected,'selection_state_changed'):self.restart()
    def test_service_cli_accepts_named_service_owner_without_chown(self):
        from unittest.mock import patch, MagicMock
        from types import SimpleNamespace
        from configurator.homebridge import LocalHost
        path=MagicMock();path.resolve.return_value=path;path.is_file.return_value=True
        path.stat.return_value=SimpleNamespace(st_uid=123,st_mode=0o100755)
        parent=MagicMock();parent.stat.return_value=SimpleNamespace(st_uid=0,st_mode=0o40755);path.parents=(parent,)
        with patch('configurator.homebridge.Path',return_value=path),patch('configurator.homebridge.pwd.getpwnam',return_value=SimpleNamespace(pw_uid=123)),patch('configurator.homebridge.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=b'homebridge\n')),patch('configurator.homebridge.os.access',return_value=True),patch('configurator.homebridge.run') as run:
            LocalHost(self.cfg['homebridge']).service('stop');run.assert_called_once_with(str(path),'stop')
            path.stat.return_value.st_mode=0o100775
            with self.assertRaises(Rejected):LocalHost(self.cfg['homebridge']).service('start')
            self.assertEqual(run.call_count,1)
