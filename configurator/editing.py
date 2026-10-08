"""Generic identity/grant, timing and protection writes with explicit host ports."""
import copy
import re
from .common import require, Rejected
from .domain import USER_FIELDS, user_payload, alarm_timings, lockout_payload
from .transactions import digest

IDENTITY_FIELDS = {'id','name','enabled','revision','user_revision'}
GRANT_FIELDS = USER_FIELDS | {'schedule'}
WRITE_OPS = {'save_user','delete_user','rotate_pin','save_alarm','save_lockout','reset_lockout'}
RECOVERY_OPS = {'transaction_status','review_recovery','recover_transaction','verify_credential'}


def projected(raw, fields):
    require(isinstance(raw, dict) and fields <= set(raw), 'gateway_response_invalid')
    result = {key: copy.deepcopy(raw[key]) for key in fields}
    if 'keypads' in fields:
        require(isinstance(result['keypads'],list), 'gateway_response_invalid')
        result['keypads'] = sorted(result['keypads'],key=lambda p:(p['source'],p['endpoint']))
    return result


def unrestricted(row):
    return all(row.get(key) is True for key in ('enabled','grant_enabled','owner','arm','disarm','api_arm_disarm')) and \
        row.get('remaining_uses') is None and row.get('schedule') is None


class Editor:
    def __init__(self, view, *, authorize=None, audit_actor="Administrator"):
        self.audit_actor = audit_actor
        self.authorize = authorize
        self.view, self.core, self.client = view, view.core, view.client
        self.aid = view.alarm_id
        self.prefix = '/alarmsystems/' + str(self.aid)
        self.identity = self.core.registrations[view.gateway_id]['identity']

    def snapshot(self):
        self.client.verify(self.aid)
        global_raw = self.client.request('/alarmsystems/users')
        identities = {uid: projected(row, IDENTITY_FIELDS) for uid, row in global_raw.items()}
        require(all(re.fullmatch('[0-9a-f]{32}', uid) and row['id'] == uid for uid,row in identities.items()),
                'gateway_response_invalid')
        alarms = self.client.request('/alarmsystems')
        grants, capabilities = {}, {}
        require(str(self.aid) in alarms, 'alarm_not_found')
        for alarm in alarms:
            require(re.fullmatch('[1-9][0-9]{0,2}', alarm) and 1 <= int(alarm) <= 255, 'gateway_response_invalid')
            caps = self.client.verify(int(alarm))
            capabilities[alarm] = {k: caps.get(k) for k in ('managed','schedules','schedule_version','keypad_lockout_version')}
            raw = self.client.request('/alarmsystems/' + alarm + '/users')
            grants[alarm] = {uid: projected(row, GRANT_FIELDS) for uid,row in raw.items()}
            require(all(uid in identities and row['id'] == uid for uid,row in grants[alarm].items()), 'gateway_response_invalid')
        return {'identities': identities, 'grants': grants, 'capabilities': capabilities,
                'alarm': self.view.alarm()}

    def protect_owners(self, snapshot, uid, payload, deleting):
        for alarm, grants in snapshot['grants'].items():
            rows = copy.deepcopy(grants)
            if alarm == str(self.aid):
                if deleting: rows.pop(uid, None)
                else: rows[uid or 'new'] = dict(payload)
            if not deleting:
                for key,row in rows.items():
                    if key == uid:
                        row['enabled'] = payload['enabled']
            managed = snapshot['capabilities'][alarm]['managed'] is True or alarm == str(self.aid) and not deleting
            require(not managed or any(unrestricted(row) for row in rows.values()), 'last_unrestricted_owner_required')

    def plan(self, op, body, snapshot):
        if self.authorize:self.authorize(op,body,snapshot)
        caps = snapshot['capabilities'][str(self.aid)]
        plan = {'operation': op, 'alarm': self.aid, 'sensitive': False}
        if op in ('save_user','delete_user'):
            deleting = op == 'delete_user'
            preserve = body.get('preserve_schedule') is True
            if 'preserve_schedule' in body:
                require(preserve and not deleting and 'schedule' not in body,'invalid_schedule')
                body={k:v for k,v in body.items() if k!='preserve_schedule'}
            uid, alarm, payload = user_payload(body, deleting)
            require(alarm == self.aid, 'alarm_context_changed')
            if not deleting:
                pairs=[(pad['source'],pad['endpoint']) for pad in payload['keypads']]
                require(len(set(pairs))==len(pairs) and all(len(source)==1 or not source.startswith('0') for source,_ in pairs), 'invalid_keypads')
                payload['keypads']=sorted(payload['keypads'],key=lambda p:(p['source'],p['endpoint']))
            current = snapshot['grants'][str(alarm)].get(uid)
            identity = snapshot['identities'].get(uid)
            if preserve:
                require(current is not None,'invalid_schedule')
                payload['schedule']=copy.deepcopy(current['schedule'])
            if uid is None:
                require(not deleting and payload['revision'] == payload['user_revision'] == 0 and 'pin' in payload, 'new_user_requires_pin')
            else:
                require(identity is not None and identity['user_revision'] == payload['user_revision'], 'revision_conflict')
                require(payload['revision'] == (current['revision'] if current else 0), 'revision_conflict')
                if deleting: require(current is not None, 'user_not_found')
                elif current is None:
                    require('pin' in payload, 'current_pin_required')
                    require(payload['name'] == identity['name'] and payload['enabled'] == identity['enabled'], 'attach_identity_fields_changed')
                else: require('pin' not in payload, 'use_coordinated_pin_change')
            if caps['managed'] is not True:
                require(not deleting and body.get('enable_management') is True and unrestricted(payload), 'explicit_owner_enrollment_required')
            if not deleting and payload.get('schedule') is not None:
                require(caps['schedules'] is True and caps['schedule_version'] == 1, 'schedule_plugin_required')
            self.protect_owners(snapshot, uid, payload, deleting)
            plan.update(kind='grant', uid=uid, path=self.prefix+'/users'+('/'+uid if uid else ''),
                        method='DELETE' if deleting else 'PUT' if uid else 'POST', deleting=deleting,
                        sensitive=not deleting and 'pin' in payload)
            if deleting: expected = None
            else:
                expected = {k: copy.deepcopy(v) for k,v in payload.items() if k in GRANT_FIELDS}
                expected['schedule'] = payload.get('schedule')
                expected['revision'] = payload['revision'] + 1
                changed = uid is None or payload['name'] != identity['name'] or payload['enabled'] != identity['enabled']
                expected['user_revision'] = payload['user_revision'] + int(changed)
                expected['id'] = uid
            plan['expected'] = expected
            return plan, payload
        if op == 'rotate_pin':
            require(set(body) in ({'id','user_revision','revision','new_pin','repeat_pin'}, {'id','user_revision','revision','new_pin','repeat_pin','homebridge_selection'}), 'invalid_credential_request')
            uid = body['id']; identity = snapshot['identities'].get(uid) if isinstance(uid,str) else None
            require(identity is not None and all(type(body[k]) is int and body[k] == identity['user_revision'] for k in ('revision','user_revision')), 'revision_conflict')
            require(isinstance(body['new_pin'], str) and re.fullmatch('[0-9]{4,16}',body['new_pin']) and body['new_pin'] == body['repeat_pin'], 'pins_do_not_match')
            expected = dict(identity, revision=identity['revision']+1, user_revision=identity['user_revision']+1)
            plan.update(kind='identity',uid=uid,path='/alarmsystems/users/'+uid,method='PUT',expected=expected,sensitive=True)
            if 'homebridge_selection' in body:
                require(self.core.homebridge is not None,'homebridge_not_configured')
                plan['homebridge_selection']=self.core.homebridge.selection_plan(self.view.gateway_id,uid,body['homebridge_selection'],snapshot)
            return plan, {k:identity[k] for k in ('name','enabled','revision','user_revision')} | {'pin':body['new_pin']}
        if op == 'save_alarm':
            require(set(body) == {'timings','revision'}, 'invalid_alarm_timings')
            expected = alarm_timings(body['timings']); current = snapshot['alarm']
            require(current['timing_supported'], 'alarm_plugin_update_required')
            require(current['state'] == current['target'] == 'disarmed', 'disarm_before_timing_changes')
            require(body['revision'] == current['revision'], 'settings_changed_refresh')
            plan.update(kind='timings',path=self.prefix+'/config',method='PUT',expected=expected)
            return plan, expected
        require(op in ('save_lockout','reset_lockout'), 'operation_unavailable')
        current = self.view.lockout()
        if op == 'save_lockout':
            payload = lockout_payload(body)
            require(payload['revision'] == current['policy']['revision'], 'revision_conflict')
            plan.update(kind='lockout',path=self.prefix+'/users/lockout',method='PUT',
                        expected=dict(payload, revision=payload['revision']+1))
        else:
            require(set(body) == {'reset'} and body['reset'] is True, 'explicit_reset_required')
            payload = {'reset':True}
            plan.update(kind='reset',path=self.prefix+'/users/lockout',method='DELETE',expected=current['policy'])
        return plan, payload

    def inspect(self, plan):
        """Fresh projection only; never test a credential by issuing an alarm command."""
        try:
            self.client.verify(plan['alarm'])
            prefix = '/alarmsystems/' + str(plan['alarm'])
            if plan['kind'] == 'grant':
                uid = plan['uid']
                if uid is None:return False  # Never infer a created identity from its name.
                rows = self.client.request(prefix+'/users')
                if plan['deleting']:return uid not in rows
                return uid in rows and projected(rows[uid],GRANT_FIELDS) == plan['expected']
            if plan['kind'] == 'identity':
                rows = self.client.request('/alarmsystems/users')
                return plan['uid'] in rows and projected(rows[plan['uid']],IDENTITY_FIELDS) == plan['expected']
            if plan['kind'] == 'timings':
                raw = self.client.request(prefix)
                return {k:raw.get('config',{}).get(k) for k in plan['expected']} == plan['expected']
            raw = self.client.request(prefix+'/users/lockout')
            if plan['kind'] == 'lockout':return raw.get('policy') == plan['expected']
            if plan['kind'] == 'reset':
                return raw.get('policy') == plan['expected'] and isinstance(raw.get('keypads'),list) and all(
                    row.get('remaining_seconds') == 0 and row.get('level') == 0 for row in raw['keypads'])
            return False
        except Exception:return False

    def dispatch(self, op, body):
        tx = self.core.transactions; gateway = self.view.gateway_id
        if op == 'verify_credential':
            require(set(body)=={'transaction_id','pin'},'invalid_credential_request')
            with tx.locked(gateway):
                record=tx.load(gateway)
                require(record and record['id']==body['transaction_id'] and record['identity']==self.identity,'no_matching_transaction')
                tx.required(record)
                require(tx.evidence is not None and hasattr(tx.evidence,'submit'),'local_credential_evidence_required')
                try:return tx.evidence.submit(record,body['pin'])
                finally:body.pop('pin',None)
        if op == 'transaction_status':
            require(not body,'invalid_request');return tx.status(gateway)
        if op == 'review_recovery':
            require(not body,'invalid_request');return tx.review(gateway,self.identity,self.inspect)
        if op == 'recover_transaction':
            result=tx.recover(gateway,self.identity,body,self.inspect)
            self.core.request_discovery(gateway)
            return result
        require(op in WRITE_OPS, 'operation_unavailable')
        tx.guard(gateway)
        require(body.get('backup_acknowledged') is True, 'policy_backup_acknowledgment_required')
        body = {k:copy.deepcopy(v) for k,v in body.items() if k != 'backup_acknowledged'}
        snapshot = self.snapshot()
        plan,payload = self.plan(op,body,snapshot)
        if self.core.homebridge:
            self.core.homebridge.protect(gateway,self.aid,plan,payload,snapshot)
        if op in ('save_lockout','reset_lockout'):snapshot['lockout']=self.view.lockout()
        uid = plan.get('uid')
        identity_changed = op == 'rotate_pin' or (op == 'save_user' and uid in snapshot['identities'] and
            any(payload.get(key) != snapshot['identities'][uid][key] for key in ('name','enabled')))
        affected = sorted({self.aid} | ({int(alarm) for alarm,rows in snapshot['grants'].items() if uid in rows} if identity_changed else set()))
        context = {'gateway':gateway,'identity':self.identity,'alarm':self.aid,'operation':op,
                   'affected_alarms':affected,'identity_id':uid,'gateway_wide_identity_change':identity_changed}
        if plan.get('homebridge_selection'):context['homebridge_selection']=copy.deepcopy(plan['homebridge_selection'])
        def validate_again():
            fresh = self.snapshot()
            if op in ('save_lockout','reset_lockout'):fresh['lockout']=self.view.lockout()
            return digest(fresh) == digest(snapshot) and self.plan(op,body,fresh)[0] == plan
        def write():
            self.client.verify(self.aid)
            return self.client.request(plan['path'],plan['method'],payload)
        def verify(reply):
            expected = copy.deepcopy(plan)
            if plan['kind'] == 'grant':
                if plan['deleting']: require(reply == {'deleted':plan['uid']}, 'gateway_write_unverified')
                else:
                    require(isinstance(reply,dict) and isinstance(reply.get('id'),str) and re.fullmatch('[0-9a-f]{32}',reply['id']), 'gateway_write_unverified')
                    if plan['uid'] is None:
                        require(reply['id'] not in snapshot['identities'], 'gateway_write_unverified')
                        expected['uid'] = reply['id']; expected['expected']['id'] = reply['id']
                    require(projected(reply, GRANT_FIELDS) == expected['expected'], 'gateway_write_unverified')
            elif plan['kind'] == 'identity':require(projected(reply,IDENTITY_FIELDS) == plan['expected'], 'gateway_write_unverified')
            elif plan['kind'] == 'timings':
                required = [{'success':{plan['path']+'/'+key:value}} for key,value in plan['expected'].items()]
                require(isinstance(reply,list) and len(reply)==len(required) and all(row in reply for row in required), 'gateway_write_unverified')
            else: require(isinstance(reply,dict) and reply.get('policy') == plan['expected'], 'gateway_write_unverified')
            require(self.inspect(expected),'gateway_readback_unverified')
            return expected
        if self.core.homebridge: self.core.homebridge.pin = payload.get('pin')
        try:
            result = tx.execute(context,self.core.backup,snapshot,plan,validate_again,write,verify,credential=payload.get('pin'))
            if not result['saved']: raise Rejected(result['rejected'])
            history=self.core.history(gateway,self.aid)
            if op=='reset_lockout' or op=='save_lockout' and payload['enabled'] is False: history.close_lockouts()
            history.add(self.audit_actor,'Configuration',op.replace('_',' '),'Verified by gateway response and readback')
            self.core.request_discovery(gateway)
            return result
        finally:
            if self.core.homebridge:
                self.core.homebridge.pin = None
                self.core.homebridge.prepared = None
            payload.pop('pin',None);body.pop('pin',None);body.pop('new_pin',None);body.pop('repeat_pin',None)
