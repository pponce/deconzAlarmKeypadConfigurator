"""Real verifier persistence, session revocation, credential isolation and HTTP guards."""
import hashlib
import http.client
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from configurator import server, web_account
from configurator.common import Rejected
from configurator.core import Core
from support import config


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.core=Core(config(self.root))
        self.cfg={'salt':'00'*16,'password_hash':hashlib.scrypt(b'initial-password',salt=bytes(16),n=16384,r=8,p=1).hex(),
                  'origin':'https://example.invalid','port':9443,'bind':'127.0.0.1','socket':'synthetic'}
        self.store=lambda op,body:self.core.dispatch(op,body)
        self.security=server.Security(self.cfg,self.store)
        self.token=self.security.login('initial-password')
        self.body={'current_password':'initial-password','new_password':'changed-password','repeat_password':'changed-password'}
    def tearDown(self):self.temp.cleanup()

    def test_change_persists_across_core_and_web_restart_and_revokes_all_sessions(self):
        second=self.security.login('initial-password');original=dict(self.cfg)
        self.assertTrue(self.security.change_password(self.token,self.body)['changed'])
        for token in (self.token,second):
            with self.assertRaisesRegex(Rejected,'login_required'):self.security.session(token)
        self.core=Core(config(self.root));security=server.Security(self.cfg,self.store)
        with self.assertRaisesRegex(Rejected,'login_failed'):security.login('initial-password')
        self.assertTrue(security.login('changed-password'))
        path=self.core.state/'web-account.json'
        self.assertEqual(path.stat().st_mode&0o777,0o600)
        self.assertNotIn('changed-password',path.read_text());self.assertNotIn('initial-password',path.read_text())
        self.assertEqual(self.cfg,original)
        self.assertNotIn('password_hash',json.dumps(self.core.dispatch('installation_settings',{})))

    def test_wrong_current_mismatch_short_unchanged_and_stale_session_cannot_write(self):
        for delta,error in [({'current_password':'wrong'},'current_password'),({'repeat_password':'different'},'do_not_match'),
                            ({'new_password':'short'},'length'),({'new_password':'initial-password','repeat_password':'initial-password'},'unchanged')]:
            with self.assertRaisesRegex(Rejected,error):self.security.change_password(self.token,dict(self.body,**delta))
        self.assertIsNone(web_account.read(self.core.state))
        self.security.sessions[self.token]['expires']=0
        with self.assertRaisesRegex(Rejected,'login_required'):self.security.change_password(self.token,self.body)

    def test_rate_limit_covers_current_password_guesses(self):
        for _ in range(5):
            with self.assertRaisesRegex(Rejected,'current_password'):self.security.change_password(self.token,dict(self.body,current_password='wrong'))
        with self.assertRaisesRegex(Rejected,'rate_limited'):self.security.change_password(self.token,self.body)

    def test_partial_write_is_retained_and_authentication_holds(self):
        with patch.object(web_account.os,'replace',side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):self.security.change_password(self.token,self.body)
        self.assertTrue((self.core.state/'web-account.json.new').exists())
        with self.assertRaisesRegex(Rejected,'pending_review'):self.security.login('initial-password')
        self.assertEqual(self.security.sessions,{})

    def test_ambiguous_response_does_not_replay_and_new_password_is_accepted(self):
        def lost(op,body):
            value=self.store(op,body)
            if op=='web_auth_change':raise OSError('lost response')
            return value
        self.security.account_store=lost
        with self.assertRaises(OSError):self.security.change_password(self.token,self.body)
        self.assertEqual(web_account.read(self.core.state)['revision'],1)
        self.assertTrue(self.security.login('changed-password'))
        with self.assertRaisesRegex(Rejected,'web_account_changed'):
            self.store('web_auth_change',{'expected_revision':None,'salt':'00'*16,'password_hash':'11'*64})
        self.assertEqual(web_account.read(self.core.state)['revision'],1)

    def test_corrupt_or_symlink_credentials_fail_closed(self):
        path=self.core.state/'web-account.json';path.write_text('{}');path.chmod(0o600)
        with self.assertRaisesRegex(Rejected,'invalid'):self.security.login('initial-password')
        path.unlink();target=self.root/'target';target.write_text('{}');path.symlink_to(target)
        with self.assertRaisesRegex(Rejected,'invalid'):self.security.login('initial-password')

    def test_password_endpoint_requires_session_csrf_and_origin_and_never_projects_hashes(self):
        with patch.object(server,'rpc',side_effect=lambda socket,op,body:self.store(op,body)):
            http_server=ThreadingHTTPServer(('127.0.0.1',0),server.handler(self.cfg,self.security,Path(__file__).parents[1]/'static'))
            worker=threading.Thread(target=http_server.serve_forever,daemon=True);worker.start()
            def request(path,body=None,headers=None):
                connection=http.client.HTTPConnection('127.0.0.1',http_server.server_port)
                default={'Host':'example.invalid','Origin':self.cfg['origin'],'Content-Type':'application/json',
                         'Cookie':'__Host-configurator='+self.token,'X-CSRF-Token':self.security.sessions.get(self.token,{}).get('csrf','')}
                default.update(headers or {})
                connection.request('GET' if body is None else 'POST',path,body=None if body is None else json.dumps(body),headers=default)
                response=connection.getresponse();raw=response.read();connection.close();return response.status,json.loads(raw)
            try:
                self.assertEqual(request('/api/account/password',self.body,{'Cookie':''})[0],401)
                self.assertEqual(request('/api/account/password',self.body,{'X-CSRF-Token':'wrong'})[1]['error'],'csrf_rejected')
                self.assertEqual(request('/api/account/password',self.body,{'Origin':'https://elsewhere.invalid'})[1]['error'],'origin_rejected')
                self.assertIsNone(web_account.read(self.core.state))
                code,value=request('/api/settings');self.assertEqual(code,200);self.assertEqual(value['web']['port'],9443)
                self.assertNotIn('password_hash',json.dumps(value));self.assertNotIn('salt',json.dumps(value))
                self.assertEqual(request('/api/web_auth_read')[0],400)
                self.assertEqual(request('/api/account/password',self.body)[0],200)
                self.assertEqual(request('/api/session')[0],401)
            finally:http_server.shutdown();http_server.server_close();worker.join()

if __name__=='__main__':unittest.main()
