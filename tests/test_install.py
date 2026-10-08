import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from coordinator_admin.install import prepare
from configurator.common import atomic
from configurator.configuration import read


class InstallationTest(unittest.TestCase):
    def fixture(self, root):
        state=root/'old-state';state.mkdir(mode=0o700)
        old={'schema':1,'state':str(state),'socket':str(root/'old.sock'),'web_uid':os.geteuid(),'web_gid':os.getegid(),
             'node':shutil.which('node'),'gateways':[],'homebridge':None,'extensions':[],'access_mode':'observe'}
        atomic(root/'broker.json',old)
        atomic(state/'web-account.json',{'schema':2,'revision':3,'accounts':[{'id':'a'*32,'username':'owner','role':'admin','enabled':True,'salt':'b'*32,'password_hash':'c'*128},{'id':'d'*32,'username':'member','role':'regular','enabled':True,'salt':'e'*32,'password_hash':'f'*128}]})
        atomic(state/'application.local.json',{'synthetic':'preserve exactly'})
        cert=root/'cert';key=root/'key';cert.write_text('synthetic certificate');key.write_text('synthetic private key');key.chmod(0o600)
        atomic(root/'web.json',{'salt':'a'*32,'password_hash':'b'*128,'cert':str(cert),'key':str(key),'socket':old['socket'],'bind':'127.0.0.1','port':8787,'origin':'https://test:8787'})
        atomic(root/'identity.json',{'schema':1,'instanceId':'00000000-0000-4000-8000-000000000001','token':'c'*64})
        db=state/'activity-test-alarm-1.sqlite'
        with sqlite3.connect(db) as conn:
            conn.execute('CREATE TABLE events (message TEXT)');conn.execute("INSERT INTO events VALUES ('preserved')")
        db.chmod(0o600)
        return state

    def test_isolated_preparation_preserves_accounts_history_and_credentials_without_starting_services(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);state=self.fixture(root);before={p.name:p.read_bytes() for p in state.iterdir()}
            dest=prepare(root/'broker.json',root/'web.json',root/'identity.json',root/'new','https://test:8788',8788,'127.0.0.1',[])
            self.assertEqual((dest/'state/web-account.json').read_bytes(),before['web-account.json'])
            self.assertEqual((dest/'state/application.local.json').read_bytes(),before['application.local.json'])
            with sqlite3.connect(dest/'state/activity-test-alarm-1.sqlite') as conn:self.assertEqual(conn.execute('SELECT message FROM events').fetchone()[0],'preserved')
            new=read(dest/'private/broker.json');self.assertEqual(new['extensions'],[]);self.assertNotEqual(new['state'],str(state))
            self.assertEqual(json.loads((dest/'private/coordinator-token.json').read_text()),{'token':'c'*64})
            self.assertEqual((dest/'private/coordinator-token.json').stat().st_mode&0o777,0o600)
            self.assertTrue((dest/'app/coordinator_admin/static/editor.js').exists())
            self.assertFalse((dest/'run/broker.sock').exists());self.assertIn('configurator.server',(dest/'units/gdoor-admin-web.service').read_text())
            self.assertEqual({name:(state/name).read_bytes() for name in before},before)
            with self.assertRaises(Exception):prepare(root/'broker.json',root/'web.json',root/'identity.json',dest,'https://test:8788',8788,'127.0.0.1',[])

    def test_pending_transaction_prevents_state_transfer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);state=self.fixture(root);atomic(state/'transaction-test.json',{'stage':'recovery_required'})
            with self.assertRaisesRegex(Exception,'finish_existing_recovery'):
                prepare(root/'broker.json',root/'web.json',root/'identity.json',root/'new','https://test:8788',8788,'127.0.0.1',[])
            self.assertFalse((root/'new').exists())
