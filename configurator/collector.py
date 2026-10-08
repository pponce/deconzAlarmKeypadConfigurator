"""Independent live collection and discovery; browser refresh never controls either."""
import json
from pathlib import Path
import subprocess
import threading
import time
from urllib.parse import urlsplit
from .common import loads, require


class Collector:
    def __init__(self, core, interval=None):
        self.core, self.override_interval = core, interval
        self.stop = threading.Event()
        self.lock = threading.RLock()
        self.processes = {}
        self.generations = {}
        self.threads = []

    @property
    def interval(self):
        return self.override_interval if self.override_interval is not None else self.core.setup.values['discovery_seconds']

    def start(self):
        for key in self.core.registrations:
            thread = threading.Thread(target=self.run, args=(key,), daemon=True)
            self.threads.append(thread)
            thread.start()

    def close(self):
        self.stop.set()
        with self.lock:
            for process in self.processes.values():
                if process.poll() is None: process.terminate()
        for thread in self.threads: thread.join(10)

    def verify_lockouts(self, key, alarms):
        for aid in alarms:
            history = self.core.history(key, int(aid))
            pending = history.due_lockouts()
            if not pending: continue
            try:
                raw = self.core.view(key, int(aid)).gateway('/lockout')
                require(isinstance(raw.get('policy'), dict) and type(raw['policy'].get('enabled')) is bool and
                        isinstance(raw.get('keypads'), list), 'gateway_response_invalid')
                rows = raw['keypads']
                require(all(isinstance(r, dict) and type(r.get('locked_until')) is int and r['locked_until'] >= 0 and
                            type(r.get('remaining_seconds')) is int and r['remaining_seconds'] >= 0 for r in rows),
                        'gateway_response_invalid')
            except Exception:
                for episode, _, _ in pending: history.lockout_verification(episode, False)
                continue
            for episode, deadline, _ in pending:
                matching = [r for r in rows if r['locked_until'] == deadline]
                if matching and any(r['remaining_seconds'] > 0 for r in matching): continue
                history.lockout_verification(episode, all(r['remaining_seconds'] == 0 for r in (matching or rows)))

    def discover(self, key):
        view = self.core.view(key)
        data = view.inventory()
        config = view.client.verify()
        port = config.get('websocketport')
        require(type(port) is int and 1 <= port <= 65535, 'websocket_port_missing')
        endpoint = urlsplit(self.core.registrations[key]['endpoint'])
        host = endpoint.hostname
        if ':' in host: host = '[' + host + ']'
        alarms = {str(a['id']): [p['id'] for p in data['keypads'] if a['id'] in p['alarm_ids']] for a in data['alarms']}
        self.verify_lockouts(key, alarms)
        users = view.client.request('/alarmsystems/users')
        names = {uid: row['name'][:64] for uid, row in users.items()
                 if isinstance(row, dict) and isinstance(row.get('name'), str)}
        return {'url': ('wss' if endpoint.scheme == 'https' else 'ws') + '://' + host + ':' + str(port) + '/',
                'alarms': alarms}, names

    def record(self, key, event, alarms, names):
        kind = event.get('type')
        if kind == 'ready':
            with self.core.lock: self.core.connected[key] = True
            for aid in alarms:
                self.core.history(key, int(aid)).add('System', 'Observer', 'Connected',
                    'Live collection resumed; events during gaps are unavailable')
            return
        aid = event.get('alarm')
        if aid not in alarms: return
        capture = self.core.debug_captures.get((key, int(aid)))
        if capture: capture.observe(event)
        history = self.core.history(key, int(aid))
        stamp, event_key = event.get('timestamp'), event.get('key')
        if kind == 'alarm_state':
            history.add('Alarm', 'deCONZ', event['state'].replace('_', ' '),
                        'Observed state; no person or physical output inferred', stamp=stamp)
        elif kind == 'rest':
            history.add('Unknown' if event['result'] == 'rejected' else names.get(event.get('user'), 'Deleted or unknown user'),
                        'REST/API', event['action'].replace('_', ' '),
                        {'accepted': 'Accepted by deCONZ; actual state reported separately',
                         'rejected': 'Credential rejected; alarm unchanged',
                         'failed': 'Credential accepted; alarm target failed'}[event['result']], key=event_key, stamp=stamp)
        elif kind == 'access':
            history.add(names.get(event.get('user'), 'Deleted or unknown user'), 'Keypad',
                        event['action'].replace('_', ' '), 'Accepted; ' + str(event['uses']) + ' use consumed',
                        key=event_key, stamp=stamp)
        elif kind == 'invalid':
            if event.get('locked') and 'locked_until' in event: history.lockout_event(event)
            else: history.add('Unknown', 'Keypad', 'Code rejected', 'Rejected by deCONZ', key=event_key, stamp=stamp)

    def run(self, key):
        while not self.stop.is_set():
            process = None
            refresh_stop = threading.Event()
            refresher = None
            snapshot_lock = threading.RLock()
            snapshot = {}
            try:
                settings, names = self.discover(key)
                snapshot.update(alarms=settings['alarms'], names=names)
                with self.lock: self.generations[key] = self.generations.get(key, 0) + 1
                process = subprocess.Popen([self.core.config['node'], str(Path(__file__).with_name('observe.cjs'))],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    env={'PATH': '/usr/bin:/bin'}, text=True)
                with self.lock:
                    self.processes[key] = process
                    if self.stop.is_set(): process.terminate()
                process.stdin.write(json.dumps(settings) + '\n'); process.stdin.flush()
                def refresh(proc):
                    requested = self.core.discovery_requested[key]
                    next_refresh = time.monotonic() + self.interval
                    while not refresh_stop.is_set() and not self.stop.is_set():
                        requested.wait(min(self.interval, 0.5))
                        if refresh_stop.is_set() or self.stop.is_set(): return
                        if not requested.is_set() and time.monotonic() < next_refresh: continue
                        requested.clear()
                        next_refresh = time.monotonic() + self.interval
                        try:
                            fresh, names = self.discover(key)
                            # Endpoint changes require a fresh identity-bound connection.
                            require(fresh['url'] == settings['url'], 'event_endpoint_changed')
                            with snapshot_lock:
                                proc.stdin.write(json.dumps({'alarms': fresh['alarms']}) + '\n'); proc.stdin.flush()
                                snapshot.update(alarms=fresh['alarms'], names=names)
                                with self.lock: self.generations[key] = self.generations.get(key, 0) + 1
                        except Exception:
                            # Failed identity/capability checks must not leave a trusted stream active.
                            if proc.poll() is None: proc.terminate()
                            return
                refresher = threading.Thread(target=refresh, args=(process,), daemon=True)
                refresher.start()
                for line in iter(lambda: process.stdout.readline(8193), ''):
                    require(len(line) <= 8192, 'observation_invalid')
                    event = loads(line)
                    require(isinstance(event, dict), 'observation_invalid')
                    with snapshot_lock: self.record(key, event, snapshot['alarms'], snapshot['names'])
            except Exception: pass  # Never emit raw events, URLs or exceptions.
            finally:
                refresh_stop.set()
                if process is not None:
                    if process.poll() is None: process.terminate()
                    try: process.wait(5)
                    except subprocess.TimeoutExpired: process.kill(); process.wait()
                    process.stdin.close(); process.stdout.close()
                if refresher: refresher.join(10)
                with self.lock: self.processes.pop(key, None)
                with self.core.lock:
                    connected = self.core.connected.get(key, False)
                    self.core.connected[key] = False
                if connected:
                    for aid in snapshot.get('alarms', {}):
                        self.core.history(key, int(aid)).add('System', 'Observer', 'Disconnected', 'History gap; no replay')
            self.stop.wait(5)
