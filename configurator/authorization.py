"""Web-account policy at the broker boundary; unknown regular operations deny by default."""
import copy
from .common import require, Rejected
from .web_account import read

REGULAR_READS = {'inventory','administration','lockout','transaction_status'}
REGULAR_WRITES = {'save_user','delete_user','rotate_pin','reset_lockout'}


def hidden_users(core, gateway):
    hidden = set()
    if core.homebridge:
        hidden.update(r['user'] for r in core.homebridge.status()['bindings'] if r['gateway'] == gateway)
    # A pending selection protects both sides, even before its binding is committed.
    tx = core.transactions.load(gateway)
    selection = (tx or {}).get('homebridge_selection') or {}
    if tx and tx.get('stage') != 'complete':
        for key in ('previous','binding'):
            if selection.get(key): hidden.add(selection[key]['user'])
    return hidden


def owners(snapshot):
    return {uid for grants in snapshot['grants'].values() for uid,row in grants.items() if row['owner']}


def protect(core, gateway, operation, body, snapshot):
    require(operation in REGULAR_WRITES, 'forbidden')
    if operation == 'reset_lockout': return
    require('homebridge_selection' not in body and not body.get('enable_management') and not body.get('owner'), 'forbidden')
    uid = body.get('id')
    require(uid is None or isinstance(uid,str), 'invalid_user')
    require(uid not in hidden_users(core,gateway) and uid not in owners(snapshot), 'protected_identity')


def status(value):
    pending=value.get('stage') not in ('none','complete')
    return {'stage':'held' if pending else 'none','pending':pending,'administrator_required':pending}


def dispatch(core, request):
    require(set(request) == {'account_id','revision','operation','body'}, 'invalid_request')
    record = read(core.state)
    revision = record['revision'] if record else None
    require(request['revision'] == revision and type(request['revision']) is type(revision), 'login_required')
    if record and record['schema'] == 2:
        account = next((r for r in record['accounts'] if r['id'] == request['account_id'] and r['enabled']),None)
        require(account is not None,'login_required')
        admin = account['role'] == 'admin'
    else:
        require(request['account_id'] is None,'login_required');admin=True
    op,body = request['operation'],request['body']
    require(isinstance(op,str) and isinstance(body,dict) and op not in ('authenticated_request','web_auth_read','web_auth_change'), 'forbidden')
    actor='Web account · '+account['username'] if record and record['schema']==2 else 'Administrator'
    if admin:return core.dispatch(op,body,audit_actor=actor)
    if op == 'gateways':return core.dispatch(op,body)
    if op == 'setup':
        require(not body,'invalid_request')
        return {'access_mode':core.config['access_mode'],'extensions':[], 'onboarding_required':False}
    require(op == 'gateway_request' and set(body) == {'gateway','alarm','operation','body'},'forbidden')
    action=body['operation'];gateway=body['gateway']
    require(isinstance(action,str) and action in REGULAR_READS | REGULAR_WRITES,'forbidden')
    def authorize(operation, payload, snapshot):protect(core,gateway,operation,payload,snapshot)
    try:
        value=core.dispatch(op,body,authorize=authorize,audit_actor=actor)
    except Rejected as error:
        if any(word in str(error) for word in ('homebridge','extension','maintenance','recovery','participant','host_helper')):
            raise Rejected('administrator_attention_required') from None
        raise
    if action == 'transaction_status':return status(value)
    if action == 'administration':
        hidden=hidden_users(core,gateway)
        value={key:copy.deepcopy(value[key]) for key in ('identities','alarms','users','keypads','managed','schedules','transaction')}
        protected={r['id'] for alarm in value['alarms'] for r in alarm['users'] if r['owner']}
        for key in ('identities','users'):
            value[key]=[dict(r,read_only=r['id'] in protected) for r in value[key] if r['id'] not in hidden]
        for alarm in value['alarms']:
            alarm['users']=[dict(r,read_only=r['id'] in protected) for r in alarm['users'] if r['id'] not in hidden]
        value['pin_rotation_available']=True
        value['transaction']=status(value['transaction'])
    if action in REGULAR_WRITES:return {'saved':value.get('saved') is True}
    return value
