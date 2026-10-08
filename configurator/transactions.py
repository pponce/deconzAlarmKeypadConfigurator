"""Durable write/maintenance boundary. Recovery never replays a gateway write."""
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import time
from .common import atomic, loads, require, Rejected
from .gateway import GatewayRejected


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


class Transactions:
    def __init__(self, state, participants=None, evidence=None):
        self.state = Path(state)
        self.participants = participants or {}
        self.evidence = evidence
        self.reviews = {}
        for name, participant in self.participants.items():
            import re
            require(re.fullmatch('[a-z][a-z0-9-]{0,31}', name) and participant.api_version == 1,
                    'maintenance_participant_incompatible')

    def path(self, gateway):
        import re
        require(isinstance(gateway, str) and re.fullmatch('[a-z][a-z0-9-]{0,31}', gateway), 'invalid_gateway')
        return self.state / ('transaction-' + gateway + '.json')

    def load(self, gateway):
        path = self.path(gateway)
        require(not path.is_symlink(), 'transaction_file_invalid')
        if not path.exists(): return None
        require(not path.is_symlink() and path.is_file() and path.stat().st_uid == os.geteuid() and
                path.stat().st_mode & 0o077 == 0 and path.stat().st_size <= 4*1024*1024,
                'transaction_file_invalid')
        tx = loads(path.read_bytes())
        require(isinstance(tx, dict) and tx.get('schema') == 1 and tx.get('gateway') == gateway and
                tx.get('stage') in ('preparing','writing','verified','resuming','recovery_required','complete'),
                'transaction_invalid')
        return tx

    def save(self, tx):
        atomic(self.path(tx['gateway']), tx)

    @contextmanager
    def locked(self, gateway):
        path = self.path(gateway).with_suffix('.lock')
        shared = os.open(self.state / 'maintenance.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fd = None
        try:
            try: fcntl.flock(shared, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise Rejected('transaction_in_progress') from None
            fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise Rejected('transaction_in_progress') from None
            yield
        finally:
            if fd is not None: os.close(fd)
            os.close(shared)

    def required(self, tx):
        require(all(self.participants.get(name) is not None and self.participants[name].api_version == version
                    for name, version in tx['participants'].items()), 'registered_maintenance_participant_unavailable')
        return [self.participants[name] for name in tx['participants']]

    def guard(self, gateway):
        for receipt in self.state.glob('api-enrollment-*.json'):
            from .setup import private_load
            require(private_load(receipt).get('stage') in ('denied', 'key_saved', 'complete'),
                    'gateway_key_result_unknown')
        tx = self.load(gateway)
        if tx and tx['stage'] != 'complete':
            self.required(tx)
            raise Rejected('transaction_recovery_required')

    def status(self, gateway):
        tx = self.load(gateway)
        if tx is None: return {'stage': 'none'}
        available = all(name in self.participants and self.participants[name].api_version == version
                        for name, version in tx['participants'].items())
        return {key: copy.deepcopy(tx[key]) for key in ('id','stage','operation','alarm','write_attempted','verified')} | {
            'participants_available': available, 'automatic_retry': False,
            'homebridge': 'homebridge' in tx['participants'],
            'outcome': 'not_sent' if not tx['write_attempted'] else 'rejected' if tx.get('definite_rejection') else
                tx['intent'].get('outcome', 'applied') if tx['verified'] else 'unknown'}

    def execute(self, context, backup, snapshot, intent, validate_again, write, verify, credential=None):
        """Only write receives a closure containing a credential; the journal never does."""
        gateway = context['gateway']
        with self.locked(gateway):
            self.guard(gateway)
            for participant in self.participants.values():
                if hasattr(participant, 'guard'): participant.guard()
            participants = {name: obj for name, obj in self.participants.items()
                            if not hasattr(obj, 'applies') or obj.applies(context)}
            context = dict(context, maintenance_participants=list(participants))
            try:
                for participant in participants.values(): participant.preflight(copy.deepcopy(context))
            except Exception: raise Rejected('maintenance_preflight_failed') from None
            tx = dict(context, schema=1, id=secrets.token_hex(16), stage='preparing',
                      participants={name: obj.api_version for name, obj in participants.items()},
                      intent=copy.deepcopy(intent), paused=[], write_attempted=False, verified=False,
                      snapshot_digest=digest(snapshot), backup=None)
            self.save(tx)  # Must precede even the first participant pause.
            try:
                for name, participant in participants.items():
                    tx['paused'].append(name); self.save(tx)
                    participant.pause(copy.deepcopy(tx))
                if backup is not None:
                    require(backup.api_version == 1, 'backup_adapter_incompatible')
                    tx['backup'] = backup.save(context, snapshot); self.save(tx)
                    require(isinstance(tx['backup'], dict) and tx['backup'].get('schema') == 1 and
                            type(tx['backup'].get('credential_backup')) is bool, 'backup_receipt_invalid')
                require(validate_again(), 'settings_changed_refresh')
                if self.evidence is not None and hasattr(self.evidence,'prepare'):
                    self.evidence.prepare(copy.deepcopy(tx),credential)
                tx['stage'] = 'writing'; tx['write_attempted'] = True; self.save(tx)
                try: result = write()
                except GatewayRejected as error:
                    if not error.definite: raise
                    tx['definite_rejection']=True;tx['rejection']=str(error)
                    tx['verified']=True;tx['stage']='verified';self.save(tx)
                    self.finish(tx)
                    return {'saved':False,'transaction_id':tx['id'],'rejected':str(error)}
                expected = verify(result)
                tx['intent'] = expected
                tx['verified'] = True; tx['stage'] = 'verified'; self.save(tx)
                self.finish(tx)
                return {'saved': True, 'transaction_id': tx['id'], 'verification': 'gateway_response_and_readback'}
            except BaseException:
                tx['stage'] = 'recovery_required'
                self.save(tx)
                raise Rejected('transaction_recovery_required') from None

    def finish(self, tx):
        self.required(tx)
        for name in tx['paused']: self.participants[name].verify(copy.deepcopy(tx))
        tx['stage'] = 'resuming'; self.save(tx)
        # Hooks must be idempotent for the same durable transaction ID.
        for name in reversed(tx['paused']): self.participants[name].resume(copy.deepcopy(tx))
        tx['stage'] = 'complete'; self.save(tx)
        for name in tx['paused']:
            participant = self.participants[name]
            if hasattr(participant, 'complete'): participant.complete(copy.deepcopy(tx))

    def can_resolve(self, tx, inspect):
        participants = self.required(tx)
        if any(hasattr(p, 'recovery_ready') and p.recovery_ready(copy.deepcopy(tx)) is not True for p in participants):
            return False
        if not tx['write_attempted'] or tx.get('definite_rejection') is True: return True
        if tx['verified'] and tx['intent'].get('kind') == 'command': return True
        if inspect(tx['intent']):
            if tx['verified'] or not tx['intent'].get('sensitive', False): return True
        # Policy readback cannot establish a lost credential or command outcome.
        # A future trusted recovery adapter supplies evidence, never a browser bool.
        if self.evidence is not None:
            require(self.evidence.api_version == 1, 'recovery_adapter_incompatible')
            try: return self.evidence.verify(copy.deepcopy(tx)) is True
            except Exception: raise Rejected('recovery_evidence_unavailable') from None
        return False

    def review(self, gateway, identity, inspect):
        with self.locked(gateway):
            tx = self.load(gateway)
            require(tx and tx['stage'] != 'complete' and tx['identity'] == identity, 'no_matching_transaction')
            ready = self.can_resolve(tx, inspect)
            token = secrets.token_hex(24) if ready else None
            self.reviews = {key:value for key,value in self.reviews.items() if value[0] != gateway and time.monotonic() < value[3]}
            if ready: self.reviews[token] = (gateway, tx['id'], digest(tx), time.monotonic()+120)
            return {'transaction_id': tx['id'], 'ready': ready, 'token': token,
                    'reason': 'review_required' if ready else 'external_verification_required', 'automatic_retry': False}

    def recover(self, gateway, identity, body, inspect):
        require(set(body) == {'transaction_id','token','reviewed'} and body['reviewed'] is True,
                'recovery_confirmation_required')
        with self.locked(gateway):
            tx = self.load(gateway)
            token = body['token']; require(isinstance(token, str), 'recovery_review_expired')
            review = self.reviews.pop(token, None)
            require(tx and review and review[:3] == (gateway, body['transaction_id'], digest(tx)) and
                    tx['id'] == body['transaction_id'] and tx['identity'] == identity and
                    time.monotonic() < review[3], 'recovery_review_expired')
            require(self.can_resolve(tx, inspect), 'recovery_evidence_changed')
            tx['verified'] = True
            try: self.finish(tx)
            except Exception:
                tx['stage'] = 'recovery_required'; self.save(tx)
                raise Rejected('transaction_recovery_required') from None
            return {'recovered': True, 'transaction_id': tx['id'], 'gateway_write_replayed': False}
