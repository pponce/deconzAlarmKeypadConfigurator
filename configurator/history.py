"""Gateway/alarm scoped activity storage. No action routing."""
from contextlib import contextmanager
from datetime import datetime, timezone
import sqlite3
import threading
import time
from .common import loads, require

class History:
    maintenance_lock = threading.RLock()
    last_activity = None

    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY, event_key TEXT UNIQUE, time TEXT, user TEXT, source TEXT, action TEXT, result TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS lockout_request_groups (seq INTEGER PRIMARY KEY, episode TEXT, count INTEGER, last_stamp TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS lockout_pending (episode TEXT PRIMARY KEY, deadline INTEGER, source TEXT, unavailable INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0)')
    @contextmanager
    def connect(self):
        # Serialize collection and deletion across every history in this process.
        with self.maintenance_lock:
            db = sqlite3.connect(self.path, timeout=5)
            try:
                with db:
                    yield db
            finally:
                db.close()

    def retention_days(self):
        path = self.path.parent / 'activity-retention.local.json'
        days = loads(path.read_bytes())['days'] if path.exists() else 90
        require(type(days) is int and days in (1, 3, 7, 30, 90), 'invalid_history_retention')
        return days

    def prune(self, db):
        db.execute("DELETE FROM activity WHERE julianday(time) < julianday('now', ?)",
                   (f'-{self.retention_days()} days',))
        db.execute("DELETE FROM lockout_pending WHERE deadline < CAST(strftime('%s','now', ?) AS INTEGER) * 1000", (f'-{self.retention_days()} days',))
        db.execute('DELETE FROM activity WHERE seq NOT IN (SELECT seq FROM activity ORDER BY seq DESC LIMIT 5000)')
        db.execute('DELETE FROM lockout_request_groups WHERE seq NOT IN (SELECT seq FROM activity)')

    def cleared_before(self, db):
        db.execute('CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY, value TEXT)')
        row = db.execute("SELECT value FROM history_meta WHERE key='cleared_before'").fetchone()
        return row[0] if row else '1970-01-01T00:00:00Z'

    def after_clear(self, db, stamp):
        return bool(db.execute('SELECT julianday(?) > julianday(?)', (stamp, self.cleared_before(db))).fetchone()[0])

    def clear(self):
        with self.connect() as db:
            self.cleared_before(db)
            db.execute('DELETE FROM activity')
            db.execute('DELETE FROM lockout_pending')
            db.execute('DELETE FROM lockout_request_groups')
            History.last_activity=None
            db.execute("INSERT OR REPLACE INTO history_meta VALUES('cleared_before', ?)",
                       (datetime.now(timezone.utc).isoformat(),))

    def expire(self):
        with self.connect() as db:
            self.prune(db)
    def add(self, user, source, action, result, key=None, stamp=None):
        stamp = stamp or datetime.now(timezone.utc).isoformat()
        with self.connect() as db:
            if not self.after_clear(db, stamp): return
            inserted=db.execute('INSERT OR IGNORE INTO activity(event_key,time,user,source,action,result) VALUES(?,?,?,?,?,?)',
                       (key, stamp, user[:64], source[:32], action[:64], result[:160]))
            if inserted.rowcount:History.last_activity=(str(self.path),inserted.lastrowid)
            self.prune(db)
    def lockout_event(self, event):
        # One observer covers one selected keypad/alarm in this database.
        # A deadline identifies the observed lockout episode, even across reconnects.
        group = 'lockout:' + str(event.get('sensor','unknown')) + ':' + str(event['locked_until'])
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if not self.after_clear(db, event['timestamp']): return
            db.execute('CREATE TABLE IF NOT EXISTS lockout_receipts (event_key TEXT PRIMARY KEY, episode TEXT, stamp TEXT)')
            inserted = db.execute('INSERT OR IGNORE INTO lockout_receipts VALUES(?,?,?)',
                (event['key'],group,event['timestamp'])).rowcount
            if not inserted: return
            count = db.execute('SELECT count(*) FROM lockout_receipts WHERE episode=? AND julianday(stamp)>julianday(?)',
                               (group,self.cleared_before(db))).fetchone()[0]
            remaining = event['remaining_seconds']; minutes, seconds = divmod(remaining,60)
            duration = f'{minutes}m {seconds}s' if minutes else f'{seconds}s'
            expiry = datetime.fromtimestamp(event['locked_until']/1000,timezone.utc).isoformat(timespec='seconds')
            result = f"Level {event['level']} of 3; {duration} remaining when first observed; expires {expiry}."
            detected=db.execute('INSERT OR IGNORE INTO activity(event_key,time,user,source,action,result) VALUES(?,?,?,?,?,?)',
                (group,event['timestamp'],'Unknown',event.get('keypad_label','Keypad'),'Lockout detected',result[:160]))
            if detected.rowcount:History.last_activity=(str(self.path),detected.lastrowid)
            db.execute('INSERT OR IGNORE INTO lockout_pending(episode,deadline,source) VALUES(?,?,?)',
                       (group,event['locked_until'],event.get('keypad_label','Keypad')[:32]))
            if count > 1:
                # Extend only the last activity across all histories in this process.
                # Any intervening entry (even on another alarm), or restart, splits it.
                latest=db.execute('SELECT g.seq,g.count,g.last_stamp FROM lockout_request_groups g JOIN activity a ON a.seq=g.seq WHERE g.episode=? ORDER BY g.seq DESC LIMIT 1',(group,)).fetchone()
                extend=latest and History.last_activity==(str(self.path),latest[0]) and datetime.fromisoformat(event['timestamp'].replace('Z','+00:00'))>=datetime.fromisoformat(latest[2].replace('Z','+00:00'))
                requests=latest[1]+1 if extend else 1
                detail=f"{requests} keypad request(s) blocked; last request {event['timestamp']}. Not a PIN-attempt count."
                if extend:
                    seq=latest[0]
                    db.execute('UPDATE activity SET result=? WHERE seq=?',(detail[:160],seq))
                    db.execute('UPDATE lockout_request_groups SET count=?,last_stamp=? WHERE seq=?',(requests,event['timestamp'],seq))
                else:
                    record=db.execute('INSERT INTO activity(event_key,time,user,source,action,result) VALUES(?,?,?,?,?,?)',
                        (group+':requests:'+event['key'],event['timestamp'],'Unknown',event.get('keypad_label','Keypad'),'Requests blocked during lockout',detail[:160]))
                    seq=record.lastrowid
                    db.execute('INSERT INTO lockout_request_groups VALUES(?,?,?,?)',(seq,group,1,event['timestamp']))
                History.last_activity=(str(self.path),seq)
            db.execute("DELETE FROM lockout_receipts WHERE stamp < strftime('%Y-%m-%dT%H:%M:%S','now','-90 days')")
            db.execute('DELETE FROM lockout_receipts WHERE rowid NOT IN (SELECT rowid FROM lockout_receipts ORDER BY rowid DESC LIMIT 10000)')
            self.prune(db)

    def due_lockouts(self):
        with self.connect() as db:
            self.prune(db)
            return db.execute("SELECT episode,deadline,source FROM lockout_pending WHERE finished=0 AND deadline <= ?",
                              (int(time.time()*1000),)).fetchall()

    def lockout_verification(self, episode, expired):
        with self.connect() as db:
            row=db.execute('SELECT source,unavailable FROM lockout_pending WHERE episode=? AND finished=0',(episode,)).fetchone()
            if row is None:return  # Reset/clear may have closed it while the query ran.
            if expired:
                action='Lockout expired'
                result='Recorded deadline passed; fresh deCONZ status confirms this lockout is no longer active'
            else:
                if row[1]:return
                action='Lockout status unavailable'
                result='Recorded deadline passed; unable to confirm this lockout ended. Status checks will continue'
            inserted=db.execute('INSERT OR IGNORE INTO activity(event_key,time,user,source,action,result) VALUES(?,?,?,?,?,?)',
                       (episode+(':expired' if expired else ':unavailable'),datetime.now(timezone.utc).isoformat(),
                        'System',row[0],action,result))
            if inserted.rowcount:History.last_activity=(str(self.path),inserted.lastrowid)
            if expired:db.execute('UPDATE lockout_pending SET finished=1 WHERE episode=?',(episode,))
            else:db.execute('UPDATE lockout_pending SET unavailable=1 WHERE episode=?',(episode,))
            self.prune(db)

    def close_lockouts(self):
        with self.connect() as db:db.execute('UPDATE lockout_pending SET finished=1')

    def rows(self, limit=100):
        with self.connect() as db:
            self.prune(db)
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute('SELECT seq,time,user,source,action,result FROM activity ORDER BY seq DESC LIMIT ?', (limit,))]
