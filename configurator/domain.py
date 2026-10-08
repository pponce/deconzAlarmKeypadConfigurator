"""Existing user/grant and alarm policy validation, independent of integrations."""
import copy
import re
from .common import require
from .schedule import policy

USER_FIELDS = {'id', 'name', 'enabled', 'user_revision', 'remaining_uses', 'revision',
               'api_arm_disarm', 'grant_enabled', 'owner', 'arm', 'disarm', 'all_keypads', 'keypads'}

SAFE_GATEWAY_ERRORS = {'invalid_pin', 'invalid_name', 'invalid_remaining_uses', 'revision_required',
    'invalid_schedule', 'revision_conflict', 'pin_required', 'pin_already_assigned', 'current_pin_required',
    'update_failed_or_revision_conflict', 'delete_failed_or_revision_conflict',
    'owner_must_be_unrestricted', 'last_unrestricted_owner_required', 'invalid_keypads', 'user_limit',
    'invalid_lockout_policy', 'managed_users_required', 'invalid_user', 'user_not_found', 'storage_error', 'invalid_body', 'unknown_field'}

def user_payload(body, deleting=False):
    require(isinstance(body, dict), 'invalid_user')
    allowed = {'id', 'alarm', 'revision', 'user_revision'} if deleting else {
        'id', 'alarm', 'revision', 'user_revision', 'name', 'pin', 'enabled', 'remaining_uses',
        'api_arm_disarm', 'enable_management', 'schedule', 'grant_enabled', 'owner', 'arm', 'disarm', 'all_keypads', 'keypads'}
    require(not set(body) - allowed, 'unknown_field')
    uid, alarm = body.get('id'), body.get('alarm')
    require(uid is None and not deleting or isinstance(uid, str) and re.fullmatch('[0-9a-f]{32}', uid), 'invalid_user')
    require(type(alarm) is int and 1 <= alarm <= 255, 'invalid_alarm')
    require(all(type(body.get(k)) is int and 0 <= body[k] <= 9007199254740991 for k in ('revision', 'user_revision')), 'revision_required')
    payload = {k: v for k, v in body.items() if k not in {'id', 'alarm', 'enable_management'}}
    if not deleting:
        require(isinstance(body.get('name'), str) and 0 < len(body['name'].strip().encode()) <= 64 and
                not any(ord(x) < 32 or ord(x) == 127 for x in body['name']), 'invalid_name')
        require(all(type(body.get(k)) is bool for k in ('enabled', 'api_arm_disarm', 'grant_enabled', 'owner', 'arm', 'disarm', 'all_keypads')), 'invalid_user')
        uses = body.get('remaining_uses')
        require('remaining_uses' in body and (uses is None or type(uses) is int and 0 <= uses <= 1000000), 'invalid_remaining_uses')
        if 'pin' in body:
            require(isinstance(body['pin'], str) and re.fullmatch('[0-9]{4,16}', body['pin']), 'invalid_pin')
        pads = body.get('keypads')
        require(isinstance(pads, list) and len(pads) <= 256 and not (body['all_keypads'] and pads), 'invalid_keypads')
        for pad in pads:
            require(isinstance(pad, dict) and set(pad) == {'source', 'endpoint'} and
                    isinstance(pad['source'], str) and re.fullmatch('[0-9a-f]{1,16}', pad['source']) and
                    type(pad['endpoint']) is int and 1 <= pad['endpoint'] <= 240, 'invalid_keypads')
    if 'schedule' in payload:
        payload['schedule'] = policy(payload['schedule'])
    return uid, alarm, payload

def lockout_payload(body):
    require(isinstance(body, dict) and set(body) == {'enabled', 'threshold', 'window_seconds',
            'durations_seconds', 'reset_seconds', 'revision'}, 'invalid_lockout_policy')
    require(type(body['enabled']) is bool, 'invalid_lockout_policy')
    for key, low, high in (('threshold', 1, 100), ('window_seconds', 1, 3600),
                           ('reset_seconds', 3600, 604800), ('revision', 0, 9007199254740991)):
        require(type(body[key]) is int and low <= body[key] <= high, 'invalid_lockout_policy')
    durations = body['durations_seconds']
    require(isinstance(durations, list) and len(durations) == 3 and
            all(type(x) is int and 1 <= x <= 3600 for x in durations) and durations == sorted(durations),
            'invalid_lockout_policy')
    return copy.deepcopy(body)

ALARM_MODES = ('disarmed', 'armed_stay', 'armed_night', 'armed_away')

ALARM_STATES = ALARM_MODES + ('exit_delay', 'entry_delay', 'not_ready', 'in_alarm',
                            'arming_stay', 'arming_night', 'arming_away')

ALARM_TIMINGS = tuple(mode + '_' + field for mode in ALARM_MODES[1:]
                      for field in ('entry_delay', 'exit_delay', 'trigger_duration'))

def alarm_timings(value):
    require(isinstance(value, dict) and set(value) == set(ALARM_TIMINGS) and
            all(type(v) is int and 0 <= v <= 255 for v in value.values()), 'invalid_alarm_timings')
    return dict(value)
