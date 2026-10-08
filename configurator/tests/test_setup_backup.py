"""Setup, local SQLite backup and draft preservation with synthetic data only."""
import copy
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from configurator.common import Rejected
from configurator.core import Core
from configurator.collector import Collector
from configurator.editing import Editor
from support import config, IDENTITY, USER
from test_editing import Model, owner, OTHER


class SetupBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.model=Model();self.backups=self.root/'backups';self.backups.mkdir(mode=0o700)
        self.row={'id':'test','name':'Test','identity':IDENTITY,'endpoint':'http://127.0.0.1:1','key':'synthetic-key'}
        self.cfg=config(self.root,[self.row]);self.cfg.update(schema=2,access_mode='manage',backup_root=str(self.backups))
        self.core=Core(self.cfg,self.model.factory)
    def tearDown(self):self.temp.cleanup()
    def call(self,op,body=None):return self.core.dispatch('gateway_request',{'gateway':'test','alarm':1,'operation':op,'body':body or {}})
    def draft(self):return dict(owner(),alarm=1,backup_acknowledged=True)
    def save_connection(self,**changes):
        setup=self.core.dispatch('setup',{})
        return self.core.dispatch('setup_gateway',{'revision':setup['revision'],'gateway':dict(self.row,**changes)})
    def database(self):
        path=self.root/'gateway.sqlite';path.touch(mode=0o600)
        db=sqlite3.connect(path)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE gateway_users_v2(uid TEXT PRIMARY KEY,revision INTEGER,hash TEXT)')
        db.execute('CREATE TABLE alarm_user_grants_v2(alarm INTEGER,uid TEXT,revision INTEGER)')
        db.execute('INSERT INTO gateway_users_v2 VALUES(?,?,?)',(USER,1,'synthetic-credential-verifier'))
        db.executemany('INSERT INTO alarm_user_grants_v2 VALUES(?,?,?)',[(1,USER,1),(2,USER,1)])
        db.commit()
        self.cfg['database_backups']=[{'gateway':'test','identity':IDENTITY,'path':str(path)}]
        self.core=Core(self.cfg,self.model.factory)
        return db,path

    def test_connection_save_is_private_staged_and_no_gateway_write(self):
        result=self.save_connection(name='Renamed',endpoint='http://127.0.0.1:2',key='')
        self.assertTrue(result['restart_required']);self.assertNotIn('synthetic-key',json.dumps(result))
        self.assertEqual(self.core.registrations['test']['endpoint'],self.row['endpoint'])
        with self.assertRaisesRegex(Rejected,'setup_restart_required'):self.call('save_user',self.draft())
        self.core=Core(self.cfg,self.model.factory)
        self.assertEqual(self.core.registrations['test']['endpoint'],'http://127.0.0.1:2')
        self.assertEqual(self.core.registrations['test']['key'],'synthetic-key')
        self.assertFalse(self.core.dispatch('setup',{})['restart_required'])
        self.assertEqual((self.core.state/'setup.local.json').stat().st_mode&0o777,0o600)
        self.assertEqual(self.model.writes,[])

    def test_connection_identity_capabilities_and_stale_draft_fail_closed(self):
        revision=self.core.dispatch('setup',{})['revision']
        with self.assertRaisesRegex(Rejected,'history_gateway_identity'):self.save_connection(identity='F'*16)
        self.model.identity='F'*16
        with self.assertRaisesRegex(Rejected,'gateway_identity_changed'):self.save_connection()
        self.model.identity=IDENTITY;self.save_connection(name='New name')
        with self.assertRaisesRegex(Rejected,'settings_changed_refresh'):
            self.core.dispatch('setup_gateway',{'revision':revision,'gateway':self.row})
        changed=copy.deepcopy(self.cfg);changed['access_mode']='observe'
        with self.assertRaisesRegex(Rejected,'setup_base_changed'):Core(changed,self.model.factory)
        self.assertEqual(self.model.writes,[])

    def test_connection_save_cannot_hide_unresolved_transaction(self):
        self.model.failure='after'
        with self.assertRaises(Rejected):self.call('save_user',self.draft())
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.save_connection(name='Redirect')
        self.assertFalse((self.core.state/'setup.local.json').exists())

    def test_application_intervals_persist_without_live_stream_replacement(self):
        collector=Collector(self.core);self.assertEqual(collector.interval,60)
        setup=self.core.dispatch('setup',{})
        body={'revision':setup['application_revision'],'settings':{'discovery_seconds':30,'display_seconds':8}}
        self.core.dispatch('setup_application',body)
        self.assertEqual(collector.interval,30);self.assertTrue(self.core.discovery_requested['test'].is_set())
        with self.assertRaisesRegex(Rejected,'settings_changed_refresh'):self.core.dispatch('setup_application',body)
        self.core=Core(self.cfg,self.model.factory)
        self.assertEqual(self.core.dispatch('setup',{})['application']['display_seconds'],8)
        self.assertEqual(self.model.writes,[])

    def test_setup_cannot_enable_manage_shell_or_extension_registration(self):
        for key,value in [('access_mode','manage'),('extensions',[]),('shell','anything')]:
            body={'revision':self.core.dispatch('setup',{})['application_revision'],'settings':{'discovery_seconds':60,'display_seconds':5,key:value}}
            with self.assertRaises(Rejected):self.core.dispatch('setup_application',body)
        with self.assertRaises(Rejected):self.save_connection(path='/arbitrary/module')

    def test_home_screen_name_persists_without_discovery_and_old_preferences_preserve_it(self):
        from unittest.mock import patch
        current=self.core.dispatch('setup',{})
        self.assertEqual(current['application']['home_screen_name'],'Keypad Cntrl')
        with patch.object(self.core,'request_discovery') as discovery:
            saved=self.core.dispatch('setup_application',{'revision':current['application_revision'],
                'settings':dict(current['application'],home_screen_name='Workshop Admin')})
            discovery.assert_not_called()
        self.assertEqual(self.core.dispatch('public_branding',{}),{'home_screen_name':'Workshop Admin'})
        restarted=Core(self.cfg,self.model.factory)
        self.assertEqual(restarted.setup.values['home_screen_name'],'Workshop Admin')
        saved=self.core.dispatch('setup_application',{'revision':saved['application_revision'],
            'settings':{'discovery_seconds':60,'display_seconds':9}})
        self.assertEqual(saved['application']['home_screen_name'],'Workshop Admin')
        for name in ('','x'*33,' hidden','line\nbreak',False):
            with self.assertRaisesRegex(Rejected,'home_screen_name_invalid'):
                self.core.dispatch('setup_application',{'revision':saved['application_revision'],
                    'settings':dict(saved['application'],home_screen_name=name)})
        with self.assertRaisesRegex(Rejected,'settings_changed_refresh'):
            self.core.dispatch('setup_application',{'revision':current['application_revision'],'settings':current['application']})

    def test_old_saved_preferences_load_with_default_home_screen_name(self):
        from configurator.common import atomic
        atomic(self.core.state/'application.local.json',{'discovery_seconds':80,'display_seconds':7})
        restarted=Core(self.cfg,self.model.factory)
        self.assertEqual(restarted.setup.values,{'discovery_seconds':80,'display_seconds':7,'home_screen_name':'Keypad Cntrl'})

    def test_sqlite_backup_captures_wal_before_write_and_is_not_recovery_evidence(self):
        db,path=self.database()
        try:
            self.model.failure='after'
            with self.assertRaisesRegex(Rejected,'recovery_required'):self.call('save_user',self.draft())
            receipt=json.loads(next(self.backups.rglob('receipt.json')).read_text())
            self.assertTrue(receipt['credential_backup']);self.assertFalse(receipt['automatic_restore'])
            saved=next(self.backups.rglob('gateway.sqlite'))
            with sqlite3.connect(saved) as conn:self.assertEqual(conn.execute('SELECT count(*) FROM gateway_users_v2').fetchone()[0],1)
            self.assertEqual(saved.stat().st_mode&0o777,0o600)
            self.assertNotIn('synthetic-credential-verifier',json.dumps(self.core.dispatch('setup',{})))
            self.assertEqual(self.model.writes[0][0],'/alarmsystems/1/users/'+USER)
            self.assertFalse(self.core.transactions.evidence.verify(self.core.transactions.load('test')))
        finally:db.close()

    def test_backup_schema_revision_permissions_and_source_path_fail_before_write(self):
        db,path=self.database()
        try:
            db.execute('UPDATE gateway_users_v2 SET revision=2');db.commit()
            with self.assertRaisesRegex(Rejected,'recovery_required'):self.call('save_user',self.draft())
            self.assertEqual(self.model.writes,[])
            self.assertFalse(self.core.transactions.load('test')['write_attempted'])
            # Direct backup checks do not clear that pending transaction.
            snapshot=Editor(self.core.view('test',1)).snapshot()
            context={'gateway':'test','identity':IDENTITY}
            path.chmod(0o666)
            with self.assertRaisesRegex(Rejected,'permissions'):self.core.backup.save(context,snapshot)
            path.chmod(0o600);replacement=path.with_name('replacement.sqlite');path.rename(replacement);path.symlink_to(replacement)
            with self.assertRaisesRegex(Rejected,'path_invalid'):self.core.backup.save(context,snapshot)
        finally:db.close()

    def test_retention_keeps_failed_edit_backup_and_pending_transaction_blocks_further_backups(self):
        context={'gateway':'test','identity':IDENTITY}
        snapshot=Editor(self.core.view('test',1)).snapshot()
        earlier=[self.core.backup.save(context,snapshot) for _ in range(20)]
        self.model.failure='after'
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.call('save_user',self.draft())
        tx=self.core.transactions.load('test')
        self.assertEqual(tx['stage'],'recovery_required')
        self.assertTrue((self.backups/tx['backup']['snapshot']/'policy.json').is_file())
        self.assertFalse((self.backups/earlier[0]['snapshot']).exists())
        before=set(self.backups.glob('configurator-policy-*'))
        self.assertEqual(len(before),20)
        with self.assertRaisesRegex(Rejected,'recovery_required'):self.call('save_user',self.draft())
        self.assertEqual(set(self.backups.glob('configurator-policy-*')),before)

    def test_unchanged_schedule_preserves_all_fields_and_revision_guards(self):
        self.model.identities[OTHER]={k:owner(OTHER)[k] for k in ('id','name','enabled','revision','user_revision')}
        self.model.grants['1'][OTHER]=owner(OTHER)
        schedule={'timezone':'UTC','not_before':1900000000123,'expires_at':1900000900456,'windows':[]}
        self.model.grants['1'][USER].update(owner=False,schedule=schedule)
        draft=self.draft();draft.pop('schedule');draft.update(owner=False,preserve_schedule=True,name='Renamed')
        self.call('save_user',draft)
        self.assertEqual(self.model.grants['1'][USER]['schedule'],schedule)
        with self.assertRaisesRegex(Rejected,'revision_conflict'):self.call('save_user',draft)
        self.assertEqual(len(self.model.writes),1)

    def test_editor_read_is_generic_and_does_not_enroll_or_write(self):
        data=self.call('editor');self.assertEqual(set(data['grants']),{'1','2'})
        self.assertEqual(data['identities'][USER]['user_revision'],1)
        self.assertEqual(self.model.writes,[])

    def test_local_history_and_transaction_status_survive_gateway_outage(self):
        self.core.history('test',1).add('System','Test','Observed','Synthetic')
        self.model.identity='F'*16  # All gateway verification now fails.
        self.assertEqual(self.call('transaction_status'),{'stage':'none'})
        self.assertEqual(len(self.call('history')['rows']),1)
        with self.assertRaises(Rejected):self.call('overview')
        with self.assertRaises(Rejected):self.core.dispatch('gateway_request',{'gateway':'missing','alarm':1,'operation':'history','body':{}})
