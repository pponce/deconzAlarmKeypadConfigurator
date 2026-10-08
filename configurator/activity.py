"""Offline history presentation and scoped maintenance; no gateway discovery."""
from datetime import datetime
import re
from .common import atomic, loads, require
from .history import History

CATEGORIES = ('keypad', 'deconz', 'administration')


def category(row):
    if row['action'] in ('Lockout detected', 'Lockout expired', 'Lockout status unavailable'):
        return 'deconz'
    if row['source'] in ('Keypad', 'Browser keypad') or row['source'].startswith('Keypad · '):
        return 'keypad'
    if row['user'] == 'Administrator' or row['source'] == 'Configuration':
        return 'administration'
    return 'deconz'


class Activity:
    def __init__(self, core):
        self.core = core

    def files(self):
        result = []
        for path in self.core.state.glob('activity-*-alarm-*.sqlite'):
            match = re.fullmatch(r'activity-([a-z][a-z0-9-]{0,31})-alarm-([1-9][0-9]{0,2})\.sqlite', path.name)
            if not match or match[1] not in self.core.registrations or not 1 <= int(match[2]) <= 255:
                continue
            require(path.is_file() and not path.is_symlink(), 'history_path_invalid')
            result.append((match[1], int(match[2]), path))
        return result

    def days(self):
        path = self.core.state / 'activity-retention.local.json'
        require(not path.is_symlink(), 'history_path_invalid')
        days = loads(path.read_bytes())['days'] if path.exists() else 90
        require(type(days) is int and days in (1, 3, 7, 30, 90), 'invalid_history_retention')
        return days

    def options(self):
        files = self.files()
        rows = []
        for gid, registration in self.core.registrations.items():
            alarms = {a['id']: {'id': a['id'], 'name': a['name'], 'observed': True}
                      for a in self.core.catalog.get(gid, {}).get('alarms', [])}
            for gateway, aid, _ in files:
                if gateway == gid and aid not in alarms:
                    alarms[aid] = {'id': aid, 'name': 'Alarm ' + str(aid), 'observed': False}
            rows.append({'id': gid, 'name': registration['name'],
                         'connected': self.core.connected.get(gid, False),
                         'alarms': sorted(alarms.values(), key=lambda a: a['id'])})
        return {'gateways': rows}

    def scope(self, body):
        gid, aid = body['gateway'], body['alarm']
        require(gid is None or isinstance(gid, str) and gid in self.core.registrations, 'gateway_not_registered')
        require(aid is None or type(aid) is int and 1 <= aid <= 255, 'invalid_history_filter')
        require(aid is None or gid is not None, 'history_alarm_requires_gateway')
        if aid is not None:
            rows = next(g['alarms'] for g in self.options()['gateways'] if g['id'] == gid)
            require(any(a['id'] == aid for a in rows), 'alarm_not_found')
        return [(g, a, p) for g, a, p in self.files()
                if (gid is None or gid == g) and (aid is None or aid == a)]

    def query(self, body):
        require(set(body) == {'gateway', 'alarm', 'categories'}, 'invalid_history_filter')
        categories = body['categories']
        require(isinstance(categories, list) and len(categories) <= 3 and
                all(isinstance(c, str) and c in CATEGORIES for c in categories) and
                len(set(categories)) == len(categories), 'invalid_history_filter')
        options = {g['id']: g for g in self.options()['gateways']}
        rows = []
        for gid, aid, path in self.scope(body):
            gateway = options[gid]
            alarm = next(a for a in gateway['alarms'] if a['id'] == aid)
            for row in History(path).rows(5000):
                kind = category(row)
                if kind in categories:
                    rows.append(dict(row, category=kind, gateway_id=gid, gateway_name=gateway['name'],
                                     alarm_id=aid, alarm_name=alarm['name']))
        def stamp(row):
            try: return datetime.fromisoformat(row['time'].replace('Z', '+00:00')).timestamp()
            except (ValueError, TypeError): return 0
        rows.sort(key=lambda r: (stamp(r), r['seq']), reverse=True)
        sources = [g for g in options.values() if body['gateway'] is None or body['gateway'] == g['id']]
        return {'rows': rows[:200], 'retention_days': self.days(), 'limit': 200,
                'connected': bool(sources) and all(g['connected'] for g in sources)}

    def dispatch(self, operation, body):
        with History.maintenance_lock:
            if operation == 'activity_options':
                require(not body, 'invalid_request')
                return self.options()
            if operation == 'history_query': return self.query(body)
            require(self.core.config['access_mode'] == 'manage', 'candidate_read_only_required')
            if operation == 'history_clear':
                require(set(body) == {'gateway', 'alarm', 'confirmed'} and body['confirmed'] is True,
                        'history_confirmation_required')
                for _, _, path in self.scope(body): History(path).clear()
                return {'cleared': True}
            require(operation == 'history_retention' and set(body) == {'days', 'expected_days', 'confirmed'},
                    'invalid_history_retention')
            days = body['days']
            require(type(days) is int and days in (1, 3, 7, 30) and
                    type(body['expected_days']) is int and type(body['confirmed']) is bool, 'invalid_history_retention')
            current = self.days()
            require(body['expected_days'] == current, 'history_retention_changed_reload')
            require(days >= current or body['confirmed'], 'history_confirmation_required')
            atomic(self.core.state / 'activity-retention.local.json', {'days': days})
            for _, _, path in self.files(): History(path).expire()
            return {'retention_days': days}
