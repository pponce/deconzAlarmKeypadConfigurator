"""Standalone Virtual Keypad composition. Commands are never recovery probes."""
import os
import sqlite3
import time
from .common import require
from .keypad_core import send as send_core, classify


def status(view, body):
    require(not body, 'invalid_keypad_request')
    caps = view.client.verify(view.alarm_id)
    require(caps.get('managed') is True, 'keypad_managed_alarm_required')
    return {'available':view.core.config['access_mode']=='manage', 'physical_lockout':False}


class Ports:
    def __init__(self, view):self.view = view
    def guard(self):
        require(self.view.core.config['access_mode']=='manage','candidate_read_only_required')
        self.view.core.transactions.guard(self.view.gateway_id)
    def begin(self, started):
        return self.view.core.extensions.begin(self.view, started)
    def prepare(self):
        status(self.view,{})
        return self.view.alarm_id
    def reserve(self, request_id):
        path = self.view.core.state / 'keypad-requests.sqlite'
        require(not path.is_symlink(),'request_ledger_invalid')
        fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);os.close(fd)
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS requests(gateway TEXT, alarm INTEGER, id TEXT, created REAL, PRIMARY KEY(gateway,alarm,id))')
            # Retain IDs independently of activity retention/clearing. Never reuse
            # a request ID merely because its history row has expired.
            return db.execute('INSERT OR IGNORE INTO requests VALUES(?,?,?,?)',
                (self.view.gateway_id,self.view.alarm_id,request_id,time.time())).rowcount==1
    def submit(self, alarm, mode, code):
        view=self.view; result=[]
        context={'gateway':view.gateway_id,'identity':view.core.registrations[view.gateway_id]['identity'],
                 'alarm':alarm,'operation':'keypad_send'}
        intent={'kind':'command','alarm':alarm,'sensitive':True,'mode':mode}
        def write():
            view.client.verify(alarm)
            response=view.client.exchange('/alarmsystems/'+str(alarm)+'/'+mode,'PUT',{'code0':code})
            result.append(response);return response
        def verify(response):return dict(intent,outcome=classify(*response,alarm,mode))
        view.core.transactions.execute(context,None,{},intent,lambda:True,write,verify)
        return result[0]
    def audit(self, action, result, key):
        self.view.core.history(self.view.gateway_id,self.view.alarm_id).add('Browser operator','Browser keypad',action,result,key=key)


def send(view, body):return send_core(Ports(view),body)
