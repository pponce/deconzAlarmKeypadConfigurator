"""Named keypad projection and alarm isolation, using the real core boundary."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from configurator.common import Rejected
from configurator.core import Core
from support import config, IDENTITY
from test_editing import Model


class KeypadModel(Model):
    def __init__(self):
        super().__init__()
        self.sensors = {
            '1': {'type': 'ZHAAncillaryControl', 'name': 'Entry keypad', 'uniqueid': '00:11:22:33:44:55:66:aa-01'},
            '2': {'type': 'ZHAAncillaryControl', 'name': 'Side keypad', 'uniqueid': '00:11:22:33:44:55:66:aa-02'},
            '3': {'type': 'ZHAAncillaryControl', 'name': 'Workshop keypad', 'uniqueid': '00:11:22:33:44:55:66:bb-01'}}
        self.alarms = {
            aid: {'name': name, 'devices': {self.sensors[sid]['uniqueid']: {} for sid in ids}}
            for aid, name, ids in [('1', 'Entry alarm', ['1', '2']), ('2', 'Workshop alarm', ['3'])]}
        self.states = {'1': [{'source': '00112233445566AA', 'endpoint': 2, 'remaining_seconds': 120, 'level': 2}],
                       '2': [{'source': '112233445566bb', 'endpoint': 1, 'remaining_seconds': 600, 'level': 3}]}

    def read(self, path):
        if path == '/sensors': return self.sensors
        if path == '/alarmsystems': return self.alarms
        if path.endswith('/lockout'): return {'policy': self.policy, 'keypads': self.states[path.split('/')[2]]}
        return super().read(path)

    def change(self, path, method, body):
        if path.endswith('/lockout') and method == 'DELETE':
            self.states[path.split('/')[2]] = []
            return self.read(path)
        return super().change(path, method, body)


class LockoutStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name); backups = root / 'backups'; backups.mkdir(mode=0o700)
        self.model = KeypadModel()
        registration = {'id': 'test', 'name': 'Example gateway', 'identity': IDENTITY,
                        'endpoint': 'http://127.0.0.1:1', 'key': 'unused'}
        cfg = config(root, [registration]); cfg.update(schema=2, access_mode='manage', backup_root=str(backups))
        self.core = Core(cfg, self.model.factory)

    def call(self, alarm=1, operation='lockout', body=None):
        return self.core.dispatch('gateway_request', {'gateway': 'test', 'alarm': alarm,
                                  'operation': operation, 'body': body or {}})

    def test_identity_and_endpoint_join_includes_keypads_without_stored_state(self):
        result = self.call()
        self.assertEqual(result['keypads'], [
            {'id': '1', 'name': 'Entry keypad', 'known': True, 'level': 0, 'remaining_seconds': 0},
            {'id': '2', 'name': 'Side keypad', 'known': True, 'level': 2, 'remaining_seconds': 120}])
        self.assertEqual(result['unmatched_keypads'], [])
        self.assertEqual([p['name'] for p in self.call(2)['keypads']], ['Workshop keypad'])
        self.model.sensors['2']['name'] = 'Renamed keypad'
        self.assertEqual(self.call()['keypads'][1]['name'], 'Renamed keypad')
        self.assertNotIn('source', json.dumps(result)); self.assertNotIn('endpoint', json.dumps(result))

    def test_unmatched_and_ambiguous_identities_are_not_silently_clear(self):
        self.model.states['1'].append({'source': 'ff', 'endpoint': 1, 'level': 1, 'remaining_seconds': 30})
        self.model.sensors['4'] = dict(self.model.sensors['2'], name='Duplicate identity')
        result = self.call()
        self.assertEqual([r['known'] for r in result['keypads']], [True, False, False])
        self.assertEqual(len(result['unmatched_keypads']), 2)
        self.assertIsNone(result['keypads'][1]['remaining_seconds'])
        self.model.alarms['1']['devices']['invalid'] = {}
        self.model.sensors['5'] = dict(self.model.sensors['1'], uniqueid='invalid')
        self.assertFalse(self.call()['keypads'][-1]['known'])

    def test_invalid_or_duplicate_gateway_state_is_rejected(self):
        valid = copy.deepcopy(self.model.states['1'])
        for bad in ([dict(valid[0], source='not-an-address')], [dict(valid[0], endpoint=True)],
                    [dict(valid[0], remaining_seconds=-1)], valid + valid):
            with self.subTest(bad=bad):
                self.model.states['1'] = bad
                with self.assertRaises(Rejected): self.call()

    def test_alarm_reset_clears_all_its_states_and_preserves_other_alarm_and_policy(self):
        self.model.states['1'].append({'source': '112233445566aa', 'endpoint': 1, 'level': 1, 'remaining_seconds': 60})
        other, policy = copy.deepcopy(self.model.states['2']), copy.deepcopy(self.model.policy)
        self.assertTrue(self.call(operation='reset_lockout', body={'reset': True, 'backup_acknowledged': True})['saved'])
        self.assertTrue(all(p['level'] == p['remaining_seconds'] == 0 for p in self.call()['keypads']))
        self.assertEqual(self.model.states['2'], other); self.assertEqual(self.model.policy, policy)
        self.assertEqual(self.model.writes[-1][0:2], ('/alarmsystems/1/users/lockout', 'DELETE'))


if __name__ == '__main__': unittest.main()
