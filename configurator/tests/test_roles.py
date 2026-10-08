"""Account lifecycle and least-privilege policy through the real broker and editor."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch
from configurator.common import Rejected, atomic
from configurator.server import Security
from configurator import web_account
from test_editing import EditingTests, owner, USER, OTHER, PIN, NEW_PIN, Participant

ADMIN='a'*32
REGULAR='b'*32
HB='c'*32

class RolesTests(unittest.TestCase):
    tearDown=EditingTests.tearDown
    call=EditingTests.call
    draft=EditingTests.draft
    def setUp(self):
        EditingTests.setUp(self)
        salt='00'*16
        digest=hashlib.scrypt(b'initial-password',salt=bytes(16),n=16384,r=8,p=1).hex()
        self.web={'salt':salt,'password_hash':digest}
        self.security=Security(self.web,lambda op,body:self.core.dispatch(op,body))
        rows=[{'id':uid,'username':name,'role':role,'enabled':True,'salt':salt,'password_hash':digest}
              for uid,name,role in ((ADMIN,'Owner','admin'),(REGULAR,'Helper','regular'))]
        self.core.dispatch('web_auth_change',{'expected_revision':None,'accounts':rows})
        self.token=self.security.login('initial-password','Helper')
        guest=owner(OTHER,'Visitor');guest.update(owner=False)
        self.model.identities[OTHER]={k:guest[k] for k in ('id','name','enabled','revision','user_revision')}
        self.model.grants['1'][OTHER]=guest
    def request(self,op,body=None):
        return self.core.dispatch('authenticated_request',{'account_id':REGULAR,'revision':1,'operation':op,'body':body or {}})
    def regular(self,op,body=None,alarm=1):
        return self.request('gateway_request',{'gateway':'test','alarm':alarm,'operation':op,'body':body or {}})
    def test_default_deny_all_privileged_routes_and_nested_envelopes(self):
        for op in ('installation_settings','setup_gateway','setup_application','setup_finish','setup_connect',
                   'extension_request','history_query','web_auth_read','web_auth_change','authenticated_request'):
            with self.subTest(op=op),self.assertRaisesRegex(Rejected,'forbidden'):self.request(op)
        for op in ('editor','overview','save_alarm','save_lockout','keypad_send','keypad_status','discover','debug_status',
                   'debug_control','history','recover_transaction','review_recovery','verify_credential'):
            with self.subTest(op=op),self.assertRaisesRegex(Rejected,'forbidden'):self.regular(op)
        self.assertEqual(self.model.writes,[])
    def test_owner_is_readonly_across_alarms_even_with_replacement_owner(self):
        self.model.grants['1'][OTHER]['owner']=True
        for op,body in [('save_user',self.draft()),('delete_user',{'id':USER,'alarm':1,'revision':1,'user_revision':1,'backup_acknowledged':True}),
                        ('rotate_pin',{'id':USER,'revision':1,'user_revision':1,'new_pin':NEW_PIN,'repeat_pin':NEW_PIN,'backup_acknowledged':True})]:
            with self.subTest(op=op),self.assertRaisesRegex(Rejected,'forbidden|protected_identity'):self.regular(op,body)
        self.assertEqual(self.model.writes,[])
    def test_cannot_promote_or_enroll_or_select_integration(self):
        for extra in ({'owner':True},{'enable_management':True},{'homebridge_selection':{}}):
            with self.assertRaisesRegex(Rejected,'forbidden'):self.regular('save_user',dict(self.draft(OTHER),**extra))
        self.assertEqual(self.model.writes,[])
    def test_ordinary_user_save_schedule_disable_and_remove_grant(self):
        draft=self.draft(OTHER);draft.update(name='Renamed visitor',remaining_uses=4,
             schedule={'timezone':'UTC','not_before':None,'expires_local':'','weekly':'Mon 09:00-10:00'})
        self.assertTrue(self.regular('save_user',draft)['saved'])
        self.assertIn('Web account · Helper',json.dumps(self.core.history('test',1).rows(20),ensure_ascii=False))
        draft=self.draft(OTHER);draft.pop('schedule');draft['preserve_schedule']=True;draft['enabled']=False
        self.assertTrue(self.regular('save_user',draft)['saved'])
        draft=self.draft(OTHER)
        self.assertTrue(self.regular('delete_user',{k:draft[k] for k in ('id','alarm','revision','user_revision','backup_acknowledged')})['saved'])
        self.assertNotIn(OTHER,self.model.grants['1'])
    def test_regular_reset_uses_transaction_and_backup(self):
        self.assertTrue(self.regular('reset_lockout',{'reset':True,'backup_acknowledged':True})['saved'])
        self.assertEqual(self.call('transaction_status')['stage'],'complete')
        self.assertTrue(list(self.backups.rglob('receipt.json')))
    def test_homebridge_hidden_from_all_grants_and_direct_writes_rejected(self):
        class Integration:
            def status(self):return {'bindings':[{'gateway':'test','user':OTHER,'alarms':[1]}]}
            def guard(self):pass
        self.core.homebridge=Integration()
        result=self.regular('administration')
        self.assertNotIn(OTHER,json.dumps(result));self.assertNotIn('Visitor',json.dumps(result))
        self.assertFalse(any(k.startswith('homebridge') for k in result))
        self.assertTrue(next(r for r in result['identities'] if r['id']==USER)['read_only'])
        for op,body in [('save_user',self.draft(OTHER)),('rotate_pin',{'id':OTHER,'revision':1,'user_revision':1,
                         'new_pin':NEW_PIN,'repeat_pin':NEW_PIN,'backup_acknowledged':True})]:
            with self.assertRaisesRegex(Rejected,'protected_identity'):self.regular(op,body)
        self.assertEqual(self.model.writes,[])
    def test_mandatory_participant_failure_is_not_bypassed_or_leaked(self):
        peer=Participant('pause');self.core.transactions.participants={'extension':peer}
        with self.assertRaises(Rejected):self.regular('save_user',dict(self.draft(OTHER),name='Changed'))
        self.assertEqual(self.model.writes,[])
        result=self.regular('transaction_status')
        self.assertTrue(result['administrator_required']);self.assertNotIn('participants',result)
    def test_account_migration_retains_password_and_disables_password_only(self):
        path=self.core.state/'web-account.json';path.unlink() # synthetic fixture only
        sec=Security(self.web,lambda op,body:self.core.dispatch(op,body));token=sec.login('initial-password')
        sec.manage_account(token,{'action':'claim','expected_revision':None,'username':'NewAdmin','current_password':'initial-password'})
        with self.assertRaisesRegex(Rejected,'login_required'):sec.session(token)
        with self.assertRaisesRegex(Rejected,'login_failed'):sec.login('initial-password')
        sec.login('initial-password','newadmin')
        record=web_account.read(self.core.state)
        self.assertEqual(record['accounts'][0]['password_hash'],self.web['password_hash'])
        self.assertNotIn('initial-password',path.read_text())
        with self.assertRaisesRegex(Rejected,'downgrade'):self.core.dispatch('web_auth_change',{'expected_revision':1,**self.web})
    def test_regular_cannot_manage_accounts_but_can_change_own_password(self):
        with self.assertRaisesRegex(Rejected,'forbidden'):self.security.manage_account(self.token,{})
        self.assertNotIn('accounts',self.security.accounts(self.token))
        self.security.change_password(self.token,{'current_password':'initial-password','new_password':'new-password','repeat_password':'new-password'})
        self.security.login('new-password','Helper');self.security.login('initial-password','Owner')
        with self.assertRaisesRegex(Rejected,'login_required'):self.regular('inventory')
    def test_last_admin_duplicate_username_and_session_revocation(self):
        token=self.security.login('initial-password','Owner')
        base={'action':'save','expected_revision':1,'current_password':'initial-password','id':ADMIN,
              'username':'Owner','role':'admin','enabled':True,'password':'','repeat_password':''}
        for delta,error in [({'role':'regular'},'last_admin'),({'enabled':False},'last_admin'),({'username':'helper'},'username_in_use')]:
            with self.assertRaisesRegex(Rejected,error):self.security.manage_account(token,dict(base,**delta))
        self.security.attempts=[]
        self.security.manage_account(token,dict(base,id=REGULAR,username='Helper',enabled=False,role='regular'))
        with self.assertRaisesRegex(Rejected,'login_required'):self.security.session(self.token)
        with self.assertRaisesRegex(Rejected,'login_failed'):self.security.login('initial-password','Helper')
    def test_regular_create_attach_and_rotate_ordinary_user(self):
        self.model.grants['1'].pop(OTHER);self.model.identities.pop(OTHER)
        draft=dict(owner(None,'New visitor'),alarm=1,revision=0,user_revision=0,pin=NEW_PIN,
                   owner=False,backup_acknowledged=True)
        self.assertTrue(self.regular('save_user',draft)['saved'])
        row=self.model.read('/alarmsystems/1/users')[OTHER]
        attach=dict(row,alarm=2,revision=0,pin=NEW_PIN,backup_acknowledged=True)
        self.assertTrue(self.regular('save_user',attach,2)['saved'])
        rev=self.model.identities[OTHER]['user_revision']
        self.assertTrue(self.regular('rotate_pin',{'id':OTHER,'revision':rev,'user_revision':rev,
            'new_pin':'864209','repeat_pin':'864209','backup_acknowledged':True})['saved'])
    def test_http_regular_permissions_csrf_and_no_account_verifiers(self):
        from http.client import HTTPConnection
        from http.server import ThreadingHTTPServer
        import threading
        from configurator import server
        from pathlib import Path
        self.web.update(origin='https://fixture.invalid',socket='fixture',port=9443,bind='127.0.0.1')
        with patch.object(server,'rpc',side_effect=lambda socket,op,body:self.core.dispatch(op,body)):
            http=ThreadingHTTPServer(('127.0.0.1',0),server.handler(self.web,self.security,Path(__file__).parents[1]/'static'))
            worker=threading.Thread(target=http.serve_forever,daemon=True);worker.start()
            def request(path,body=None,extra=None):
                conn=HTTPConnection('127.0.0.1',http.server_port)
                headers={'Host':'fixture.invalid','Origin':'https://fixture.invalid','Content-Type':'application/json',
                    'Cookie':'__Host-configurator='+self.token,'X-CSRF-Token':self.security.sessions[self.token]['csrf']}
                headers.update(extra or {})
                conn.request('GET' if body is None else 'POST',path,None if body is None else json.dumps(body),headers)
                reply=conn.getresponse();value=reply.read();code=reply.status;conn.close();return code,json.loads(value)
            try:
                for path in ('/api/settings','/api/activity-options','/api/extensions/fixture/settings','/extensions/fixture/index.html'):
                    self.assertEqual(request(path)[0],403,path)
                for path in ('/api/session','/api/accounts','/api/setup'):
                    code,value=request(path);self.assertEqual(code,200)
                    self.assertNotIn('password_hash',json.dumps(value));self.assertNotIn('salt',json.dumps(value))
                    self.assertNotIn('homebridge',json.dumps(value))
                self.assertEqual(request('/api/accounts',{})[0],403)
                self.assertEqual(request('/api/account/password',{}, {'X-CSRF-Token':'wrong'})[1]['error'],'csrf_rejected')
                self.assertEqual(request('/api/account/password',{}, {'Origin':'https://foreign.invalid'})[1]['error'],'origin_rejected')
                self.assertEqual(request('/api/users/save',self.draft(),{'X-Configurator-Gateway':'test','X-Configurator-Alarm':'1'})[0],403)
            finally:http.shutdown();http.server_close();worker.join()
    def test_named_account_uncertain_write_revokes_without_replay(self):
        token=self.security.login('initial-password','Owner');calls=[]
        def lost(op,body):
            value=self.core.dispatch(op,body)
            if op=='web_auth_change':calls.append(op);raise OSError('lost reply')
            return value
        self.security.account_store=lost
        with self.assertRaises(OSError):self.security.manage_account(token,{'action':'delete','id':REGULAR,
            'expected_revision':1,'current_password':'initial-password'})
        self.assertEqual(calls,['web_auth_change']);self.assertEqual(self.security.sessions,{})
        with self.assertRaisesRegex(Rejected,'login_failed'):self.security.login('initial-password','Helper')
        self.security.login('initial-password','Owner')
        self.assertEqual(web_account.read(self.core.state)['revision'],2)
    def test_account_admin_creation_and_rename_are_private_and_revision_checked(self):
        token=self.security.login('initial-password','Owner')
        body={'action':'save','id':None,'username':'Second','role':'admin','enabled':True,'password':'second-password',
              'repeat_password':'second-password','expected_revision':1,'current_password':'initial-password'}
        self.security.manage_account(token,body)
        token=self.security.login('second-password','Second')
        rows=self.security.accounts(token)
        self.assertEqual(len(rows['accounts']),3);self.assertNotIn('password_hash',json.dumps(rows))
        self.security.attempts=[]
        body.update(id=next(r['id'] for r in rows['accounts'] if r['username']=='Second'),username='Renamed',
                    password='',repeat_password='',current_password='second-password')
        with self.assertRaisesRegex(Rejected,'changed'):self.security.manage_account(token,body)
        body['expected_revision']=2;self.security.manage_account(token,body)
        self.security.login('second-password','Renamed')
        with self.assertRaisesRegex(Rejected,'login_failed'):self.security.login('second-password','Second')
    def test_unchanged_sessions_survive_creation_with_current_revision_and_csrf(self):
        admin=self.security.login('initial-password','Owner')
        before=self.security.session(admin)
        body={'action':'save','id':None,'username':'NewHelper','role':'regular','enabled':True,
              'password':'new-password','repeat_password':'new-password','expected_revision':1,'current_password':'initial-password'}
        self.assertFalse(self.security.manage_account(admin,body)['sign_in_required'])
        for token in (admin,self.token):
            session=self.security.session(token)
            self.assertEqual(session['revision'],2)
            self.core.dispatch('authenticated_request',{'account_id':session['account_id'],
                'revision':session['revision'],'operation':'gateways','body':{}})
        after=self.security.session(admin)
        self.assertEqual(before['csrf'],after['csrf']);self.assertEqual(before['expires'],after['expires'])
        self.assertNotIn('new-password',json.dumps(self.security.sessions))

    def test_changed_account_sessions_revoked_but_unrelated_admin_survives(self):
        for delta in ({'username':'Renamed'}, {'role':'admin'}, {'enabled':False},
                      {'password':'replacement','repeat_password':'replacement'}, {'action':'delete'}):
            with self.subTest(delta=delta):
                self.security.attempts=[]
                admin=self.security.login('initial-password','Owner')
                old=web_account.read(self.core.state)
                # Reset only the synthetic helper for the next case; never production state.
                rows=old['accounts'];rows[:]=[r for r in rows if r['id']!=REGULAR]
                rows.append(dict(rows[0],id=REGULAR,username='Helper',role='regular'))
                self.core.dispatch('web_auth_change',{'expected_revision':old['revision'],'accounts':rows})
                first=self.security.login('initial-password','Helper');second=self.security.login('initial-password','Helper')
                body={'action':'save','id':REGULAR,'username':'Helper','role':'regular','enabled':True,
                      'password':'','repeat_password':'','expected_revision':self.security.version,'current_password':'initial-password'}
                body.update(delta)
                if body['action']=='delete':body={k:body[k] for k in ('action','id','expected_revision','current_password')}
                self.assertFalse(self.security.manage_account(admin,body)['sign_in_required'])
                self.security.session(admin)
                for token in (first,second):
                    with self.assertRaisesRegex(Rejected,'login_required'):self.security.session(token)

    def test_racing_unrelated_account_revision_does_not_sign_out_or_replay(self):
        from http.client import HTTPConnection
        from http.server import ThreadingHTTPServer
        from pathlib import Path
        import threading
        from configurator import server
        self.web.update(origin='https://fixture.invalid',socket='fixture')
        calls=[]
        def raced(socket,op,body):
            calls.append(op)
            old=web_account.read(self.core.state)
            rows=old['accounts'];rows.append(dict(rows[0],id='d'*32,username='Added'))
            self.core.dispatch('web_auth_change',{'expected_revision':old['revision'],'accounts':rows})
            return self.core.dispatch(op,body)
        http=ThreadingHTTPServer(('127.0.0.1',0),server.handler(self.web,self.security,Path(__file__).parents[1]/'static'))
        worker=threading.Thread(target=http.serve_forever,daemon=True);worker.start()
        try:
            with patch.object(server,'rpc',side_effect=raced):
                conn=HTTPConnection('127.0.0.1',http.server_port)
                conn.request('GET','/api/gateways',headers={'Host':'fixture.invalid','Cookie':'__Host-configurator='+self.token})
                reply=conn.getresponse();self.assertEqual(reply.status,400)
                self.assertEqual(json.loads(reply.read())['error'],'account_revision_changed');conn.close()
            self.assertEqual(calls,['authenticated_request'])
            self.assertEqual(self.security.session(self.token)['revision'],2)
        finally:http.shutdown();http.server_close();worker.join()

    def test_self_password_change_preserves_other_accounts(self):
        admin=self.security.login('initial-password','Owner')
        self.security.change_password(self.token,{'current_password':'initial-password','new_password':'replacement','repeat_password':'replacement'})
        self.assertEqual(self.security.session(admin)['revision'],2)
        with self.assertRaisesRegex(Rejected,'login_required'):self.security.session(self.token)

    def test_regular_recheck_after_backup_prevents_new_owner_write(self):
        original=self.core.backup.save
        def changed(context,snapshot):
            result=original(context,snapshot)
            self.model.grants['2'][OTHER]=dict(self.model.grants['1'][OTHER],owner=True)
            return result
        self.core.backup.save=changed
        with self.assertRaises(Rejected):self.regular('save_user',dict(self.draft(OTHER),name='Attempted change'))
        self.assertEqual(self.model.writes,[])
        self.assertTrue(self.regular('transaction_status')['administrator_required'])
    def test_pending_binding_redacts_both_old_and_new_identity(self):
        pending={'stage':'recovery_required','homebridge_selection':{'previous':{'user':OTHER},'binding':{'user':USER}}}
        with patch.object(self.core.transactions,'load',return_value=pending),patch.object(self.core.transactions,'status',return_value={'stage':'recovery_required'}):
            result=self.regular('administration')
            self.assertEqual(result['identities'],[])
            self.assertTrue(all(not alarm['users'] for alarm in result['alarms']))
            self.assertTrue(result['transaction']['administrator_required'])
