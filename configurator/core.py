"""Independent core with read-only defaults and explicit maintenance ports."""
import copy
from pathlib import Path
import re
import threading
from .common import atomic, loads, require
from .configuration import validate
from .domain_methods import DomainMethods
from .gateway import Gateway
from .history import History
from .transactions import Transactions
from .backup import Backups
from .editing import Editor, WRITE_OPS, RECOVERY_OPS


def label(value, fallback):
    return value[:64] if isinstance(value, str) and value else fallback


class Core:
    def __init__(self, config, gateway_factory=Gateway, *, participants=None, recovery_evidence=None, backup=None, homebridge_host=None, extension_transport=None):
        from .setup import Setup, activate
        require(not (Path(config['state'])/'integration-pending.json').exists(),'integration_reconciliation_required')
        base = copy.deepcopy(validate(config))
        config = activate(base)
        self.config = validate(config)
        self.state = Path(config['state'])
        self.factory = gateway_factory
        self.registrations = {r['id']: r for r in config['gateways']}
        self.lock = threading.RLock()
        self.catalog = {}
        self.debug_captures = {}
        self.connected = {}
        self.discovery_requested = {key: threading.Event() for key in self.registrations}
        self.homebridge = None
        participants = dict(participants or {})
        from .extensions import Registry
        self.extensions = Registry(self, extension_transport)
        for key, peer in self.extensions.peers.items():
            require('ext-'+key not in participants,'maintenance_participant_incompatible')
            participants['ext-'+key] = peer
        registration = self.state / 'homebridge-registration.json'
        if registration.exists():
            from .homebridge_local import private_read
            require(loads(private_read(registration)) == config['homebridge'], 'registered_homebridge_changed_review_required')
        self.host_peer=None
        helper_registration=self.state/'host-helper-registration.json'
        if helper_registration.exists() or helper_registration.is_symlink():
            from .setup import private_load
            require(private_load(helper_registration)==config.get('host_helper'),'registered_host_helper_changed_review_required')
        if 'host_helper' in config:
            from .host_client import Peer
            self.host_peer=Peer(self)
            atomic(helper_registration,config['host_helper'])
        if config['homebridge'] is not None:
            from .homebridge import Adapter
            require(config['schema'] == 2, 'homebridge_backup_configuration_required')
            if self.host_peer and homebridge_host is None:
                from .host_client import RemoteAdapter
                self.homebridge=RemoteAdapter(self,self.host_peer)
            else:self.homebridge = Adapter(self, homebridge_host)
            require('homebridge' not in participants, 'maintenance_participant_incompatible')
            participants['homebridge'] = self.homebridge
            atomic(registration, config['homebridge'])
        if recovery_evidence is None and self.host_peer:
            from .host_client import RemoteEvidence
            recovery_evidence=RemoteEvidence(self.host_peer)
        if recovery_evidence is None and config.get('database_backups'):
            from .credential_evidence import Evidence
            recovery_evidence=Evidence(self)
        self.transactions = Transactions(self.state, participants, recovery_evidence)
        self.backup = backup if backup is not None else Backups(config['backup_root'],config['gateways'],config.get('database_backups',[])) if config['schema'] == 2 else None
        if self.host_peer and backup is None:
            from .host_client import RemoteBackup
            self.backup=RemoteBackup(self.host_peer,self.backup)
        # A registration ID cannot silently reuse another gateway's history.
        path = self.state / 'identities.json'
        identities = loads(path.read_bytes()) if path.exists() else {}
        require(isinstance(identities, dict), 'history_identity_invalid')
        for key, row in self.registrations.items():
            require(identities.get(key, row['identity']) == row['identity'], 'history_gateway_identity_changed')
            identities[key] = row['identity']
        atomic(path, identities)
        self.setup = Setup(self, base)

    def request_discovery(self, gateway):
        self.discovery_requested[gateway].set()

    def view(self, gateway, alarm=None, writable=False):
        require(isinstance(gateway, str) and gateway in self.registrations, 'gateway_not_registered')
        require(alarm is None or type(alarm) is int and 1 <= alarm <= 255, 'invalid_alarm')
        client = self.factory(self.registrations[gateway], writable=True) if writable else self.factory(self.registrations[gateway])
        client.verify(alarm)
        return View(self, gateway, alarm, client)

    def history(self, gateway, alarm):
        require(gateway in self.registrations and type(alarm) is int and 1 <= alarm <= 255, 'invalid_history_scope')
        path = self.state / f'activity-{gateway}-alarm-{alarm}.sqlite'
        require(not path.is_symlink(), 'history_path_invalid')
        return History(path)

    def dispatch(self, operation, body, *, authorize=None, audit_actor="Administrator"):
        require(isinstance(body, dict), 'invalid_request')
        if operation == 'public_branding':
            require(not body,'invalid_request')
            with self.lock:return {'home_screen_name':self.setup.values['home_screen_name']}
        if operation == 'authenticated_request':
            from .authorization import dispatch
            with self.lock:return dispatch(self,body)
        if operation in ('web_auth_read', 'web_auth_change'):
            from .web_account import dispatch
            with self.lock: return dispatch(self.state, operation, body)
        if operation == 'installation_settings':
            require(not body, 'invalid_request')
            with self.lock:
                value = self.dispatch('setup', {})
                profile = self.config.get('homebridge')
                value['homebridge_details'] = ({k: profile[k] for k in ('profile', 'storage', 'package')} if profile else None)
                return value
        if operation in ('activity_options', 'history_query', 'history_clear', 'history_retention'):
            from .activity import Activity
            with self.lock: return Activity(self).dispatch(operation, body)
        if operation == 'setup_finish':
            with self.lock: return self.setup.finish(body)
        if operation == 'setup_local_gateways':
            require(not body, 'invalid_request')
            return self.setup.local_gateways()
        if operation in ('setup_probe', 'setup_connect'):
            with self.lock:
                return self.setup.probe(body) if operation == 'setup_probe' else self.setup.connect(body)
        if operation == 'setup':
            require(not body, 'invalid_request')
            return {'schema': self.config['schema'], 'access_mode': self.config['access_mode'], 'homebridge': self.homebridge.status() if self.homebridge else False, 'extensions': self.extensions.public(),
                    'gateway_count': len(self.registrations), 'setup_editing_available': True, **self.setup.public()}
        if operation in ('setup_gateway','setup_application'):
            with self.lock:
                return self.setup.save_gateway(body) if operation=='setup_gateway' else self.setup.save_application(body)
        if operation == 'extension_request':
            with self.lock:return self.extensions.dispatch(body)
        if operation == 'gateways':
            require(not body, 'invalid_request')
            with self.lock:
                return {'gateways': [{'id': key, 'name': row['name'],
                        'connected': self.connected.get(key, False)} for key, row in self.registrations.items()]}
        require(operation == 'gateway_request', 'operation_unavailable')
        require(set(body) == {'gateway', 'alarm', 'operation', 'body'} and isinstance(body['body'], dict), 'invalid_request')
        op = body['operation']
        require(isinstance(op,str) and op in {'inventory','overview','administration','debug_status','debug_control','editor','discover','alarm','lockout','history','keypad_status','keypad_send'} | WRITE_OPS | RECOVERY_OPS, 'candidate_read_only_required')
        if op=='verify_credential':require(self.config['access_mode']=='manage','candidate_read_only_required')
        mutating = op in WRITE_OPS | {'recover_transaction','keypad_send'}
        if mutating: require(not self.setup.public()['restart_required'],'setup_restart_required')
        if mutating: require(self.config['access_mode'] == 'manage' and self.backup is not None, 'candidate_read_only_required')
        if op in ('debug_status','debug_control'):
            from .debug import DebugCapture
            gid, aid = body['gateway'], body['alarm']
            require(isinstance(gid, str) and gid in self.registrations, 'gateway_not_registered')
            require(type(aid) is int and any(a['id'] == aid for a in self.catalog.get(gid, {}).get('alarms', [])), 'explicit_alarm_required')
            with self.lock:
                capture = self.debug_captures.setdefault((gid, aid), DebugCapture())
                if op == 'debug_control': return capture.command(body['body'])
                require(not body['body'], 'invalid_request')
                return capture.status()
        if op in ('transaction_status','history'):
            require(body['body']=={},'invalid_request')
            gateway,alarm=body['gateway'],body['alarm']
            require(isinstance(gateway,str) and gateway in self.registrations,'gateway_not_registered')
            require(type(alarm) is int and 1<=alarm<=255,'explicit_alarm_required')
            # These are identity-bound local records, useful even during an outage.
            # Do not add gateway I/O to each browser status/history poll.
            with self.lock:
                if op=='transaction_status':
                    result=self.transactions.status(gateway)
                    pending=[{'gateway':key,'transaction':tx}
                        for key in self.registrations
                        for tx in [self.transactions.status(key)]
                        if tx.get('homebridge') and tx['stage']!='complete']
                    if pending: result['homebridge_pending']=pending
                    return result
                return {'rows':self.history(gateway,alarm).rows(200),'connected':self.connected.get(gateway,False)}
        if op in WRITE_OPS | RECOVERY_OPS | {'keypad_status','keypad_send'}:
            require(type(body['alarm']) is int and 1 <= body['alarm'] <= 255, 'explicit_alarm_required')
            with self.lock:
                if mutating and op != 'recover_transaction': self.extensions.guard()
                if mutating and op != 'recover_transaction' and self.homebridge: self.homebridge.guard()
                view = self.view(body['gateway'],body['alarm'],writable=mutating)
                if op.startswith('keypad_'):
                    from .virtual_keypad import status, send
                    return send(view,body['body']) if op=='keypad_send' else status(view,body['body'])
                return Editor(view, authorize=authorize, audit_actor=audit_actor).dispatch(op,body['body'])
        require(body['body'] == {}, 'invalid_request')
        view = self.view(body['gateway'], body['alarm'])
        if op in ('inventory','discover'):
            if op=='discover': self.request_discovery(view.gateway_id)
            return view.inventory()
        if op=='administration':
            require(view.alarm_id is not None, 'explicit_alarm_required')
            from .presentation import overview
            return overview(view)
        if op=='editor':
            require(view.alarm_id is not None,'explicit_alarm_required')
            return Editor(view).snapshot()
        require(view.alarm_id is not None, 'explicit_alarm_required')
        if op == 'overview':
            return {'alarm': view.alarm(), 'users': view.users(),
                    'capabilities': {'managed': view.client.verify(view.alarm_id).get('managed') is True}}
        return getattr(view, op)()


class View(DomainMethods):
    def __init__(self, core, gateway, alarm, client):
        self.core, self.gateway_id, self.alarm_id, self.client = core, gateway, alarm, client
        self.names = {}

    def gateway(self, suffix='', method='GET', body=None, alarm=False, target_alarm=None):
        require(method == 'GET' and body is None, 'candidate_read_only_required')
        aid = self.alarm_id if target_alarm is None else target_alarm
        require(type(aid) is int and 1 <= aid <= 255, 'explicit_alarm_required')
        require(suffix in ('', '/capabilities', '/lockout'), 'gateway_route_invalid')
        return self.client.request('/alarmsystems/' + str(aid) + ('' if alarm else '/users') + suffix)

    def inventory(self):
        config = self.client.verify()
        alarms = self.client.request('/alarmsystems')
        sensors = self.client.request('/sensors')
        rows = []
        for aid, row in alarms.items():
            require(isinstance(aid, str) and re.fullmatch('[1-9][0-9]{0,2}', aid) and
                    1 <= int(aid) <= 255 and isinstance(row, dict), 'gateway_response_invalid')
            caps = self.client.verify(int(aid))
            rows.append({'id': int(aid), 'name': label(row.get('name'), 'Alarm ' + aid),
                         'managed': caps.get('managed') is True, 'state': row.get('state', {}).get('armstate', 'unknown')})
        pads = []
        for sid, row in sensors.items():
            if not isinstance(row, dict) or row.get('type') != 'ZHAAncillaryControl': continue
            require(isinstance(sid, str) and sid.isdigit(), 'gateway_response_invalid')
            identity = row.get('uniqueid')
            assigned = [int(aid) for aid, alarm in alarms.items()
                        if isinstance(identity, str) and identity in alarm.get('devices', {})]
            match=re.fullmatch(r'([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){7})-([0-9a-fA-F]{2})(?:-[0-9a-fA-F]{4})?',identity or '')
            address={'source':format(int(match[1].replace(':',''),16),'x'),'endpoint':int(match[2],16)} if match and 1<=int(match[2],16)<=240 else None
            pads.append({'id': sid, 'name': label(row.get('name'), 'Keypad ' + sid), 'alarm_ids': assigned, 'reachable': row.get('config', {}).get('reachable') is True, 'address':address})
        result = {'gateway': {'id': self.gateway_id, 'name': self.core.registrations[self.gateway_id]['name']},
                  'alarms': sorted(rows, key=lambda r: r['id']), 'keypads': pads}
        with self.core.lock: self.core.catalog[self.gateway_id] = copy.deepcopy(result)
        return result
