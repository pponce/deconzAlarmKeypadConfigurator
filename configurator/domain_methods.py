"""Existing alarm/user readback behavior with injected gateway and backup ports."""
import hashlib
import json
import re
from .common import require
from .domain import ALARM_MODES, ALARM_STATES, ALARM_TIMINGS, USER_FIELDS, alarm_timings, lockout_payload

class DomainMethods:
    def alarm(self):
        caps = self.gateway('/capabilities')
        raw = self.gateway(alarm=True)
        config, state = raw.get('config'), raw.get('state')
        require(isinstance(config, dict) and isinstance(state, dict), 'gateway_response_invalid')
        timings = alarm_timings({k: config.get(k) for k in ALARM_TIMINGS})
        require(config.get('armmode') in ALARM_MODES and state.get('armstate') in ALARM_STATES and
                type(state.get('seconds_remaining')) is int and 0 <= state['seconds_remaining'] <= 255,
                'gateway_response_invalid')
        revision = hashlib.sha256(json.dumps(timings, sort_keys=True).encode()).hexdigest()
        return {'state': state['armstate'], 'target': config['armmode'], 'seconds_remaining': state['seconds_remaining'],
                'timings': timings, 'revision': revision, 'timing_supported': caps.get('alarm_timing_version') == 1,
                'rest_activity': caps.get('rest_command_events') is True and caps.get('managed') is True}

    def lockout(self):
        caps = self.gateway('/capabilities')
        require(caps.get('keypad_lockout_version') == 1, 'lockout_plugin_update_required')
        raw = self.gateway('/lockout')
        require(isinstance(raw.get('policy'), dict) and isinstance(raw.get('keypads'), list), 'gateway_response_invalid')
        policy = lockout_payload(raw['policy'])
        # Join by radio identity on the server, never by name or response order.
        # The gateway stores rows only after attempts, so missing state is zero.
        states = {}
        for row in raw['keypads']:
            require(isinstance(row, dict) and type(row.get('level')) is int and 0 <= row['level'] <= 3 and
                    type(row.get('remaining_seconds')) is int and row['remaining_seconds'] >= 0, 'gateway_response_invalid')
            source, endpoint = row.get('source'), row.get('endpoint')
            require(isinstance(source, str) and re.fullmatch('[0-9a-fA-F]{1,16}', source) and
                    type(endpoint) is int and 1 <= endpoint <= 240, 'gateway_response_invalid')
            key = (format(int(source, 16), 'x'), endpoint)
            require(key not in states, 'gateway_response_invalid')
            states[key] = {'level': row['level'], 'remaining_seconds': row['remaining_seconds']}
        inventory = self.inventory()
        pads = [p for p in inventory['keypads'] if self.alarm_id in p['alarm_ids']]
        addresses = [(p['address']['source'], p['address']['endpoint']) if p['address'] else None for p in pads]
        rows, matched = [], set()
        for pad, key in zip(pads, addresses):
            known = key is not None and addresses.count(key) == 1
            state = states.get(key, {'level': 0, 'remaining_seconds': 0}) if known else {'level': None, 'remaining_seconds': None}
            rows.append({'id': pad['id'], 'name': pad['name'], 'known': known, **state})
            if known: matched.add(key)
        # Retain unmatched historical states without claiming they belong to a
        # currently assigned keypad, or exposing their radio identities.
        return {'policy': policy, 'keypads': rows, 'managed': caps.get('managed') is True,
                'unmatched_keypads': [state for key, state in states.items() if key not in matched]}

    def users(self, target_alarm=None):
        raw = self.gateway(target_alarm=target_alarm)
        result = []
        for key, row in raw.items():
            require(re.fullmatch('[0-9a-f]{32}', key) and isinstance(row, dict) and USER_FIELDS <= set(row) and row['id'] == key,
                    'gateway_response_invalid')
            result.append({k: row[k] for k in USER_FIELDS})
            result[-1]['schedule'] = row.get('schedule')
        if target_alarm is None:
            self.names = {row['id']: row['name'] for row in result}
        return sorted(result, key=lambda row: (not row['owner'], row['name'], row['id']))
