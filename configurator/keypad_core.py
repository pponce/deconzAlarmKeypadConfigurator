"""Controller-free Virtual Keypad request flow with explicit host ports.

The host supplies guard, begin, prepare, reserve, submit and audit methods.
Only submit receives the entered credential. A request-scoped optional hook sees
the classified outcome and mode; never credentials, gateway replies or secrets.
The host must serialize requests and supply durable duplicate suppression.
"""
import re
import time
from .common import Rejected, require

MODES = {'disarm': 'disarmed', 'arm_stay': 'armed_stay',
         'arm_away': 'armed_away', 'arm_night': 'armed_night'}


def classify(http, value, alarm, mode):
    prefix = '/alarmsystems/' + str(alarm)
    if http == 200 and value == [{'success': {prefix + '/config/armmode': MODES[mode]}}]:
        return 'accepted'
    if (http in (200, 400) and isinstance(value, list) and len(value) == 1 and
            isinstance(value[0], dict) and set(value[0]) == {'error'} and
            isinstance(value[0]['error'], dict) and value[0]['error'].get('type') == 7 and
            value[0]['error'].get('address') == prefix + '/code0' and
            value[0]['error'].get('description') == 'invalid value, [redacted], for parameter, code0'):
        return 'rejected'
    raise Rejected('keypad_result_unknown_no_retry')


def send(ports, body):
    require(isinstance(body, dict) and set(body) == {'code', 'mode', 'request_id'}, 'invalid_keypad_request')
    code, mode, request_id = body['code'], body['mode'], body['request_id']
    require(isinstance(code, str) and re.fullmatch(r'[0-9]{1,16}', code) is not None and
            isinstance(mode, str) and mode in MODES and isinstance(request_id, str) and
            re.fullmatch(r'[a-f0-9]{32}', request_id) is not None, 'invalid_keypad_request')
    ports.guard()
    # A missing REQUIRED hook must raise here, before any authorization write.
    hook = ports.begin(time.monotonic())
    require(hook is None or getattr(hook, 'api_version', None) == 1,
            'keypad_extension_api_incompatible')
    alarm = ports.prepare()
    require(type(alarm) is int and 1 <= alarm <= 255, 'invalid_alarm')
    if not ports.reserve(request_id):
        return {'result': 'duplicate', 'extension': 'Duplicate request ignored; no retry', 'mode': mode}
    ports.audit('Request submitted',
                mode.replace('_', ' ') + '; ' + str(len(code)) + ' digit(s); credential omitted',
                'browser-submit:' + request_id)
    outcome = 'unknown'
    try:
        http, value = ports.submit(alarm, mode, code)
        outcome = classify(http, value, alarm, mode)
        if hook is not None:
            hook.after(outcome, mode)
    except Exception:
        if hook is not None:
            hook.failed(outcome)
        note = hook.note if hook is not None else None
        ports.audit('Request result unavailable', 'No automatic retry.' + (' ' + note if note else ''),
                    'browser-result:' + request_id)
        return {'result': outcome, 'extension': note, 'mode': mode, 'uncertain': True}
    finally:
        code = ''
    note = hook.note if hook is not None else None
    ports.audit('Code accepted' if outcome == 'accepted' else 'Code rejected',
                mode.replace('_', ' ') + ('; ' + note if note else ''), 'browser-result:' + request_id)
    return {'result': outcome, 'extension': note, 'mode': mode}
