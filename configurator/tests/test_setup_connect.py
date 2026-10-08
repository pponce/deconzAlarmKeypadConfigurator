"""Explicit API enrollment: private retention, bounded retries and recovery holds."""
import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock
from configurator.common import Rejected
from configurator.core import Core
from configurator.setup import create_api_key, private_load
from support import config, IDENTITY
from test_editing import Model


class ConnectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.cfg = config(Path(self.temp.name)); self.model = Model()
        self.core = Core(self.cfg, self.model.factory)
        self.row = {'id':'local-deconz','name':'Local','identity':IDENTITY,'endpoint':'http://127.0.0.1:8080'}
        self.probe = patch('configurator.setup.gateway_probe', return_value=self.row); self.probe.start();self.addCleanup(self.probe.stop)
        self.receipt = self.core.state / ('api-enrollment-' + IDENTITY + '.json')
    def body(self):
        return {'revision': self.core.setup.public()['revision'], 'gateway': dict(self.row), 'create_key': True}
    def call(self, body=None): return self.core.dispatch('setup_connect', self.body() if body is None else body)
    def test_key_created_once_private_saved_and_duplicate_submission_is_idempotent(self):
        body=self.body()
        with patch('configurator.setup.create_api_key', return_value='private-new-key') as create:
            result=self.call(body);self.call(body)
            self.assertEqual(create.call_count,1)
        self.assertNotIn('private-new-key',json.dumps(result))
        self.assertEqual(self.receipt.stat().st_mode&0o777,0o600)
        self.assertEqual(private_load(self.receipt)['stage'],'complete')
        self.assertTrue(result['restart_required']);self.assertEqual(self.core.registrations,{})
        self.assertEqual(Core(self.cfg,self.model.factory).registrations['local-deconz']['key'],'private-new-key')
        self.assertEqual(self.model.writes,[])
        self.core.transactions.guard('local-deconz')
    def test_unknown_result_is_never_retried_after_restart_or_new_id(self):
        with patch('configurator.setup.create_api_key',side_effect=Rejected('gateway_key_result_unknown')) as create:
            with self.assertRaisesRegex(Rejected,'result_unknown'):self.call()
            self.core=Core(self.cfg,self.model.factory)
            with self.assertRaisesRegex(Rejected,'result_unknown'):self.call()
            self.row['id']='another-id'
            with self.assertRaisesRegex(Rejected,'result_unknown'):self.call()
            self.assertEqual(create.call_count,1)
            with self.assertRaisesRegex(Rejected,'result_unknown'):
                self.core.setup.save_gateway({'revision':self.body()['revision'],'gateway':dict(self.row,key='manual-key')})
        with self.assertRaisesRegex(Rejected,'gateway_key_result_unknown'):self.core.transactions.guard('local-deconz')
    def test_definite_denial_allows_only_explicit_next_click(self):
        with patch('configurator.setup.create_api_key',side_effect=[None,'private-new-key']) as create:
            with self.assertRaisesRegex(Rejected,'authenticate_app'):self.call()
            self.assertEqual(private_load(self.receipt)['stage'],'denied')
            self.assertEqual(create.call_count,1);self.core.transactions.guard('local-deconz')
            self.call();self.assertEqual(create.call_count,2)
    def test_saved_key_survives_capability_failure_without_second_post(self):
        with patch('configurator.setup.create_api_key',return_value='private-new-key') as create:
            with patch.object(self.core,'factory',side_effect=Rejected('enhanced_plugin_required')):
                with self.assertRaisesRegex(Rejected,'enhanced_plugin_required'):self.call()
            self.assertEqual(private_load(self.receipt)['stage'],'key_saved')
            self.call();self.assertEqual(create.call_count,1)
    def test_wrong_identity_and_missing_consent_do_not_create_key(self):
        with patch('configurator.setup.create_api_key') as create:
            body=self.body();body['create_key']=False
            with self.assertRaisesRegex(Rejected,'explicit_key'):self.call(body)
            with patch('configurator.setup.gateway_probe',return_value=dict(self.row,identity='F'*16)):
                with self.assertRaisesRegex(Rejected,'identity_changed'):self.call()
            create.assert_not_called();self.assertFalse(self.receipt.exists())
    def test_interrupted_completion_reconciles_saved_connection_without_key_creation(self):
        from configurator import setup
        original=setup.atomic
        def interrupted(path,value):
            if Path(path)==self.receipt and value.get('stage')=='complete':raise OSError('synthetic interruption')
            return original(path,value)
        with patch('configurator.setup.create_api_key',return_value='private-new-key') as create:
            with patch('configurator.setup.atomic',side_effect=interrupted):
                with self.assertRaises(OSError):self.call()
            self.call();self.assertEqual(create.call_count,1)
            self.assertEqual(private_load(self.receipt)['stage'],'complete')


class TransportTests(unittest.TestCase):
    def test_only_exact_key_success_or_definite_link_denial_is_accepted(self):
        for status,value,result in [(200,[{'success':{'username':'private-test-key'}}],'private-test-key'),
                                    (403,[{'error':{'type':101,'address':'','description':'link button not pressed'}}],None),
                                    (200,[{'success':{'username':'key'}},{'error':{'type':101}}],'unknown'),
                                    (302,{},'unknown'),(500,{},'unknown')]:
            with self.subTest(status=status):
                connection=MagicMock();response=connection.getresponse.return_value
                response.status=status;response.read.return_value=json.dumps(value).encode()
                with patch('configurator.setup.gateway_connection',return_value=connection):
                    if result=='unknown':
                        with self.assertRaisesRegex(Rejected,'result_unknown'):create_api_key('http://127.0.0.1:8080','test-label')
                    else:self.assertEqual(create_api_key('http://127.0.0.1:8080','test-label'),result)
                args=connection.request.call_args
                self.assertEqual(args.args,('POST','/api'))
                self.assertEqual(json.loads(args.kwargs['body']),{'devicetype':'test-label'})
                connection.close.assert_called_once()
