"""Bounded in-memory anonymous event diagnostics, scoped to a gateway/alarm."""
import re
import threading
import time
from datetime import datetime, timezone
from .common import require

class DebugCapture:
    """Bounded, opt-in, memory-only projection; never retain arbitrary event fields."""
    def __init__(self):
        self.lock = threading.RLock()
        self.clear()
    def clear(self):
        self.started = 0; self.until = 0; self.events = []; self.keys = {}; self.deadlines = {}; self.dropped = 0
    def active(self):
        return time.monotonic() < self.until
    def append(self, row):
        if len(self.events) >= 200:
            self.dropped += 1
            return
        self.events.append(dict(elapsed_ms=round((time.monotonic()-self.started)*1000), **row))
    def observe(self, event):
        with self.lock:
            if not self.active(): return
            kind = event.get('type')
            if kind not in ('ready','disconnected','access','invalid'): return
            if len(self.events) >= 200:
                self.dropped += 1
                return
            row = {'kind': kind}
            key = event.get('key')
            if isinstance(key,str) and re.fullmatch('[0-9a-f]{32}',key):
                repeat = key in self.keys
                if not repeat: self.keys[key] = 'event-' + str(len(self.keys)+1)
                row.update(event=self.keys[key], repeated_event_id=repeat)
            stamp = event.get('timestamp')
            if isinstance(stamp,str):
                try: row['event_unix_ms'] = round(datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()*1000)
                except (ValueError,OverflowError): pass
            if kind == 'invalid': row['locked'] = event.get('locked') is True
            level, remaining, deadline = (event.get(k) for k in ('level','remaining_seconds','locked_until'))
            if type(level) is int and 1<=level<=3: row['level'] = level
            if type(remaining) is int and 1<=remaining<=3600: row['remaining_seconds'] = remaining
            if type(deadline) is int and deadline>0:
                if deadline not in self.deadlines: self.deadlines[deadline]='lockout-'+str(len(self.deadlines)+1)
                row['lockout'] = self.deadlines[deadline]
            self.append(row)
    def command(self, body):
        with self.lock:
            action = body.get('action')
            require(set(body)=={'action'} and action in ('start','stop','clear','wrong_attempt','valid_attempt'), 'invalid_debug_action')
            if action=='clear': self.clear()
            elif action=='start':
                self.clear(); self.started=time.monotonic(); self.until=self.started+600
                self.append({'kind':'capture_started'})
            elif action=='stop':
                if self.active(): self.append({'kind':'capture_stopped'})
                self.until=0
            else:
                require(self.active(), 'debug_capture_not_active')
                self.append({'kind':'operator_marker','marker':action})
            return self.status()
    def status(self):
        with self.lock:
            return {'schema':1,'scope':'selected_gateway_alarm','active':self.active(),
                    'seconds_left':max(0,int(self.until-time.monotonic())), 'dropped':self.dropped,
                    'zigbee_sequence_available':False,'events':[dict(x) for x in self.events]}

