"""Translate the editor to deCONZ policy v1; enforcement stays in deCONZ."""
from datetime import datetime, timezone
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from .common import require, Rejected

def policy(value):
    if value is None:
        return None
    require(isinstance(value, dict) and set(value) == {'timezone', 'weekly', 'expires_local', 'not_before'}, 'invalid_schedule')
    require(all(isinstance(value[k], str) for k in ('timezone', 'weekly', 'expires_local')), 'invalid_schedule')
    require(len(value['timezone']) <= 128 and len(value['weekly']) <= 4096, 'invalid_schedule')
    try:
        zone = ZoneInfo(value['timezone'])
    except (ValueError, ZoneInfoNotFoundError):
        raise Rejected('invalid_timezone') from None
    windows = []
    for line in value['weekly'].splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([0-2][0-9]):([0-5][0-9])-([0-2][0-9]):([0-5][0-9])', line.strip())
        require(match is not None, 'invalid_weekly_window')
        day, sh, sm, eh, em = match.groups()
        start, end = int(sh)*60+int(sm), int(eh)*60+int(em)
        require(0 <= start < end <= 1440 and start <= 1439, 'invalid_weekly_window')
        windows.append({'day': ('Mon','Tue','Wed','Thu','Fri','Sat','Sun').index(day)+1, 'start': start, 'end': end})
    require(len(windows) <= 28, 'too_many_weekly_windows')
    expires = None
    if value['expires_local']:
        require(re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d', value['expires_local']) is not None, 'invalid_expiry')
        try:
            naive = datetime.fromisoformat(value['expires_local'])
        except ValueError:
            raise Rejected('invalid_expiry') from None
        candidates = set()
        for fold in (0, 1):
            aware = naive.replace(tzinfo=zone, fold=fold)
            stamp = aware.timestamp()
            if datetime.fromtimestamp(stamp, zone).replace(tzinfo=None) == naive:
                candidates.add(int(stamp*1000))
        require(candidates, 'nonexistent_expiry')
        require(len(candidates) == 1, 'ambiguous_expiry_choose_utc')
        expires = candidates.pop()
    start = value['not_before']
    require(start is None or type(start) is int and 1577836800000 <= start <= 4102444800000, 'invalid_not_before')
    require(expires is None or 1577836800000 <= expires <= 4102444800000, 'invalid_expiry')
    require(start is None or expires is None or start < expires, 'invalid_expiry')
    return {'timezone': value['timezone'], 'not_before': start, 'expires_at': expires, 'windows': windows}
