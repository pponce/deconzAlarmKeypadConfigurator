"""Authenticated setup drafts; connection changes activate only at broker restart."""
import copy
from contextlib import nullcontext
import json
import secrets
from urllib.parse import urlsplit
import http.client
import re
import threading
import time
import os
from pathlib import Path
from .common import atomic, loads, require, Rejected
from .configuration import validate
from .transactions import digest

DEFAULTS = {'discovery_seconds':60, 'display_seconds':5, 'home_screen_name':'Keypad Cntrl'}

LOCAL_PORTS = (80, 8080)


def gateway_connection(endpoint, timeout=1.5):
    from .configuration import validate_gateways
    validate_gateways([{'id':'probe','name':'Probe','identity':'A'*16,'endpoint':endpoint,'key':'probe'}])
    url = urlsplit(endpoint)
    cls = http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection
    return cls(url.hostname, url.port, timeout=timeout)


def gateway_probe(endpoint):
    # Fixed loopback-only GET. Never follows redirects, uses a proxy, creates a
    # key, reads host credentials, or scans arbitrary client-supplied addresses.
    connection = gateway_connection(endpoint)
    try:
        connection.request('GET', '/api/config', headers={'Accept': 'application/json'})
        response = connection.getresponse()
        if response.status != 200: return None
        raw = response.read(16385)
        if len(raw) > 16384: return None
        value = loads(raw)
        if not isinstance(value, dict) or value.get('modelid') != 'deCONZ': return None
        identity = str(value.get('bridgeid', '')).replace(':', '').upper()
        if not re.fullmatch('[0-9A-F]{16}', identity) or identity == '0' * 16: return None
        name = value.get('name')
        if not isinstance(name, str) or not name.strip() or any(ord(c) < 32 for c in name): name = 'Local deCONZ'
        return {'endpoint': endpoint.rstrip('/'), 'identity': identity, 'name': name.strip()[:64]}
    except Exception:
        return None
    finally:
        connection.close()



def local_gateway_probe(port):
    return gateway_probe('http://127.0.0.1:' + str(port))


def create_api_key(endpoint, label):
    connection = gateway_connection(endpoint, timeout=8)
    try:
        connection.request('POST', '/api', body=json.dumps({'devicetype': label}),
                           headers={'Content-Type': 'application/json'})
        response = connection.getresponse(); raw = response.read(16385)
        require(len(raw) <= 16384, 'gateway_key_result_unknown')
        value = loads(raw)
        if response.status == 403 and isinstance(value, list) and len(value) == 1 and \
                isinstance(value[0], dict) and set(value[0]) == {'error'} and \
                value[0]['error'].get('type') == 101:
            return None  # Explicit denial; retry only after another user click.
        require(response.status == 200 and isinstance(value, list) and len(value) == 1 and
                isinstance(value[0], dict) and set(value[0]) == {'success'} and
                isinstance(value[0]['success'], dict) and set(value[0]['success']) == {'username'},
                'gateway_key_result_unknown')
        key = value[0]['success']['username']
        require(isinstance(key, str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', key), 'gateway_key_result_unknown')
        return key
    except Exception:
        raise Rejected('gateway_key_result_unknown') from None
    finally:
        connection.close()


def private_load(path):
    require(not path.is_symlink() and path.is_file() and path.stat().st_uid == os.geteuid()
            and path.stat().st_mode & 0o077 == 0 and path.stat().st_size <= 65536, 'setup_file_invalid')
    return loads(path.read_bytes())


def home_screen_name(value):
    require(isinstance(value,str) and 1 <= len(value) <= 32 and value == value.strip() and
            all(c.isprintable() for c in value), 'home_screen_name_invalid')
    return value


def settings(value):
    require(isinstance(value,dict) and set(value) in (set(DEFAULTS), set(DEFAULTS)-{'home_screen_name'}), 'application_settings_invalid')
    value={**DEFAULTS,**value}
    home_screen_name(value['home_screen_name'])
    require(type(value['discovery_seconds']) is int and 10 <= value['discovery_seconds'] <= 3600 and
            type(value['display_seconds']) is int and 2 <= value['display_seconds'] <= 300, 'application_settings_invalid')
    return value


def activate(config):
    config=copy.deepcopy(config)
    path=Path(config['state'])/'setup.local.json'
    if path.exists() or path.is_symlink():
        saved=private_load(path)
        require(set(saved)=={'schema','base','gateways'} and saved['schema']==1 and
                saved['base']==digest(config), 'setup_base_changed_review_required')
        # The protected installation configuration remains the authority for
        # access mode, integrations, executable paths and backup profiles.
        config['gateways']=saved['gateways']
        validate(config)
    return config


class Setup:
    def __init__(self,core,base):
        self.core=core;self.base=copy.deepcopy(base)
        self.local_cache = None; self.local_checked = 0; self.local_lock = threading.Lock()
        self.path=core.state/'setup.local.json'
        self.settings_path=core.state/'application.local.json'
        self.values=settings(private_load(self.settings_path)) if self.settings_path.exists() or self.settings_path.is_symlink() else dict(DEFAULTS)

    def local_gateways(self):
        with self.local_lock:
            if self.local_cache is None or time.monotonic() - self.local_checked >= 10:
                rows = []
                for port in LOCAL_PORTS:
                    row = local_gateway_probe(port)
                    if row and not any(r['identity'] == row['identity'] for r in rows): rows.append(row)
                self.local_cache = {'gateways': rows, 'api_key_required': True}
                self.local_checked = time.monotonic()
            return copy.deepcopy(self.local_cache)

    def rows(self):
        return private_load(self.path)['gateways'] if self.path.exists() else copy.deepcopy(self.core.config['gateways'])

    def public(self):
        rows=self.rows()
        return {'deployment':self.deployment(), 'onboarding_required':self.onboarding_required(), 'revision':digest(rows),'restart_required':rows!=self.core.config['gateways'],
                'gateways':[{k:v for k,v in row.items() if k!='key'} for row in rows],
                'application':dict(self.values),'application_revision':digest(self.values),
                'connection_activation':'broker_restart', 'integration_registration':'protected_local_configuration',
                'key_enrollments':[{'gateway':v['gateway']['id'],'connection':dict(v['gateway']),'stage':v['stage']} for v in
                    (private_load(p) for p in sorted(self.core.state.glob('api-enrollment-*.json')))],
                'backup':self.core.backup.status() if hasattr(self.core.backup,'status') else []}

    def deployment(self):
        path = self.core.state / 'deployment.json'
        if not os.path.lexists(path): return None
        from .deployment import public
        return public(private_load(path))

    def onboarding_required(self):
        path = self.core.state / 'first-run.json'
        if not os.path.lexists(path): return False
        value = private_load(path)
        require(value in ({'schema': 1, 'complete': False}, {'schema': 1, 'complete': True}), 'onboarding_state_invalid')
        return value['complete'] is False

    def finish(self, body):
        require(set(body) == {'revision'} and body['revision'] == digest(self.rows()), 'settings_changed_refresh')
        require(self.onboarding_required(), 'onboarding_not_required')
        require(bool(self.core.registrations) and not self.public()['restart_required'], 'setup_restart_required')
        # Installed runtime excludes provisioning tools. Check durable obligations
        # directly; never import a privileged installer merely to finish a page.
        for pattern, stages in (('api-enrollment-*.json', ('denied', 'complete')),
                                ('transaction-*.json', ('complete',))):
            for path in self.core.state.glob(pattern):
                require(private_load(path).get('stage') in stages, 'integration_pending_transaction')
        lease = self.core.state / 'homebridge-maintenance.json'
        if os.path.lexists(lease):
            require(private_load(lease).get('complete') is True, 'integration_pending_transaction')
        for participant in self.core.transactions.participants.values():
            if hasattr(participant, 'guard'): participant.guard()
        for row in self.rows():
            client = self.core.factory(row); client.verify()
            alarms = client.request('/alarmsystems')
            require(isinstance(alarms, dict) and bool(alarms), 'enhanced_alarm_required')
            for alarm in alarms: client.verify(int(alarm))
        atomic(self.core.state / 'first-run.json', {'schema': 1, 'complete': True})
        return self.public()

    def save_application(self,body):
        require(set(body)=={'revision','settings'},'application_settings_invalid')
        require(body['revision']==digest(self.values),'settings_changed_refresh')
        raw=body['settings']
        require(isinstance(raw,dict),'application_settings_invalid')
        value=settings({'home_screen_name':self.values['home_screen_name'],**raw})
        changed=value['discovery_seconds']!=self.values['discovery_seconds']
        atomic(self.settings_path,value);self.values=dict(value)
        if changed:
            for key in self.core.registrations:self.core.request_discovery(key)
        return self.public()

    def save_gateway(self,body, *, already_locked=False):
        require(set(body)=={'revision','gateway'},'gateway_registry_invalid')
        rows=self.rows();require(body['revision']==digest(rows),'settings_changed_refresh')
        row=copy.deepcopy(body['gateway']);require(isinstance(row,dict),'gateway_registry_invalid')
        previous=next((r for r in rows if r['id']==row.get('id')),None)
        if previous:
            require(row.get('identity')==previous['identity'],'history_gateway_identity_changed')
            if row.get('key')=='':row['key']=previous['key']
        candidate=copy.deepcopy(self.core.config)
        candidate['gateways']=[r for r in rows if r['id']!=row.get('id')]+[row]
        validate(candidate)
        # Never redirect a connection while any unresolved obligations exist.
        with nullcontext() if already_locked else self.core.transactions.locked(row['id']):
            for key in set(self.core.registrations)|{r['id'] for r in rows}|{row['id']}:
                self.core.transactions.guard(key)
            identities_path=self.core.state/'identities.json'
            identities=private_load(identities_path)
            require(identities.get(row['id'],row['identity'])==row['identity'],'history_gateway_identity_changed')
            client=self.core.factory(row);client.verify()
            alarms=client.request('/alarmsystems')
            require(isinstance(alarms,dict) and bool(alarms),'enhanced_alarm_required')
            for aid in alarms:
                require(isinstance(aid,str) and aid.isdigit() and 1<=int(aid)<=255,'gateway_response_invalid')
                client.verify(int(aid))
            atomic(self.path,{'schema':1,'base':digest(self.base),'gateways':candidate['gateways']})
        return self.public()

    def probe(self, body):
        require(set(body) == {'endpoint'}, 'invalid_request')
        row = gateway_probe(body['endpoint'])
        require(row is not None, 'gateway_not_found_check_address')
        return {'gateway': row}

    def connect(self, body):
        require(set(body) == {'revision', 'gateway', 'create_key'} and body['create_key'] is True,
                'explicit_key_creation_required')
        row = copy.deepcopy(body['gateway'])
        require(isinstance(row, dict) and set(row) == {'id', 'name', 'identity', 'endpoint'}, 'gateway_registry_invalid')
        from .configuration import validate_gateways
        validate_gateways([dict(row, key='validation-only')])
        path = self.core.state / ('api-enrollment-' + row['identity'] + '.json')
        with self.core.transactions.locked(row['id']):
            rows = self.rows()
            for gateway in set(self.core.registrations) | {r['id'] for r in rows} | {row['id']}:
                self.core.transactions.guard(gateway)
            for participant in self.core.transactions.participants.values():
                if hasattr(participant, 'guard'): participant.guard()
            journal = private_load(path) if os.path.lexists(path) else None
            if journal is not None:
                require(journal['schema'] == 1 and journal['gateway'] == row, 'gateway_key_enrollment_changed')
                require(journal['stage'] in ('denied', 'key_saved', 'complete'), 'gateway_key_result_unknown')
                if journal['stage'] == 'complete':
                    require(dict(row, key=journal['key']) in rows, 'gateway_key_enrollment_changed')
                    return self.public()
            if journal is not None and journal['stage'] == 'key_saved' and dict(row, key=journal['key']) in rows:
                journal['stage'] = 'complete'; atomic(path, journal)
                return self.public()
            require(body['revision'] == digest(rows), 'settings_changed_refresh')
            require(not any(r['id'] == row['id'] or r['identity'] == row['identity'] for r in rows),
                    'gateway_already_registered')
            candidate = copy.deepcopy(self.core.config)
            candidate['gateways'] = rows + [dict(row, key='validation-only')]
            validate(candidate)
            identities = private_load(self.core.state / 'identities.json')
            require(identities.get(row['id'], row['identity']) == row['identity'], 'history_gateway_identity_changed')
            observed = gateway_probe(row['endpoint'])
            require(observed is not None and observed['identity'] == row['identity'], 'gateway_identity_changed')
            if journal is None or journal['stage'] == 'denied':
                journal = {'schema': 1, 'stage': 'writing', 'gateway': row,
                           'label': 'alarm-configurator#' + secrets.token_hex(6)}
                atomic(path, journal)  # Persist uncertainty BEFORE the only POST.
                key = create_api_key(row['endpoint'], journal['label'])
                if key is None:
                    journal['stage'] = 'denied'; atomic(path, journal)
                    raise Rejected('gateway_authenticate_app_required')
                journal.update(stage='key_saved', key=key); atomic(path, journal)
            # Subsequent clicks after a verification failure reuse the saved key.
            # Never return that key to the browser or replace another app's key.
            result = self.save_gateway({'revision': body['revision'], 'gateway': dict(row, key=journal['key'])},
                                       already_locked=True)
            journal['stage'] = 'complete'; atomic(path, journal)
            return self.public()
