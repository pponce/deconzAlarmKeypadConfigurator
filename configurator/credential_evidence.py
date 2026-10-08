"""Transaction-bound, read-only PIN recovery. No alarm command is a probe."""
import base64
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import sqlite3
from .common import atomic, loads, require
from .configuration import directory
from .transactions import digest


def verify_hash(pin, encoded):
    require(isinstance(pin,str) and re.fullmatch('[0-9]{4,16}',pin),'invalid_pin')
    require(isinstance(encoded,str),'credential_format_unsupported')
    match=re.fullmatch(r'\$scrypt\$N=([0-9]+)\$r=([0-9]+)\$p=([0-9]+)\$([A-Za-z0-9_-]{1,128})\$([A-Za-z0-9_-]{86})',encoded)
    require(match is not None,'credential_format_unsupported')
    n,r,p=map(int,match.group(1,2,3))
    require((2<=n<=32768 and n&(n-1)==0 and 1<=r<=8 and 1<=p<=4) or (n,r,p)==(1024,8,16),'credential_format_unsupported')
    value=hashlib.scrypt(pin.encode(),salt=match[4].encode(),n=n,r=r,p=p,dklen=64,maxmem=64*1024*1024)
    return hmac.compare_digest(base64.urlsafe_b64encode(value).decode().rstrip('='),match[5])


def commitment(pin,salt):
    require(isinstance(pin,str) and re.fullmatch('[0-9]{4,16}',pin),'invalid_pin')
    return hashlib.scrypt(pin.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()


class Evidence:
    api_version=1
    def __init__(self,core):self.core=core
    def profile(self,tx):
        return next((r for r in self.core.config.get('database_backups',[]) if r['gateway']==tx['gateway'] and r['identity']==tx['identity']),None)
    def binding(self,tx):
        require(tx['operation']=='rotate_pin' and tx['intent']['kind']=='identity' and tx['intent']['sensitive'] is True,'credential_recovery_unsupported')
        require(re.fullmatch('[0-9a-f]{32}',tx['id']) and tx['intent']['uid']==tx['identity_id'],'credential_transaction_invalid')
        return digest({k:tx[k] for k in ('id','gateway','identity','alarm','operation','identity_id','intent','snapshot_digest')})
    def path(self,tx):
        self.binding(tx)
        return directory(self.core.config['backup_root'])/('credential-intent-'+tx['id']+'.json')
    def read(self,tx):
        path=self.path(tx)
        require(path.resolve()==path and path.is_file() and path.stat().st_uid==os.geteuid() and
                path.stat().st_mode&0o077==0 and path.stat().st_size<=65536,'credential_evidence_unavailable')
        row=loads(path.read_bytes())
        require(row['binding']==self.binding(tx),'credential_evidence_changed')
        return row
    def prepare(self,tx,pin):
        if tx['operation']!='rotate_pin' or self.profile(tx) is None:return
        path=self.path(tx);require(not path.exists() and not path.is_symlink(),'credential_intent_exists')
        salt=secrets.token_hex(16)
        atomic(path,{'schema':1,'binding':self.binding(tx),'salt':salt,'commitment':commitment(pin,salt),'proof':None})
    def current(self,tx):
        profile=self.profile(tx);require(profile is not None,'local_credential_evidence_required')
        path=Path(profile['path'])
        require(path.resolve()==path and path.is_file() and not path.is_symlink(),'credential_database_invalid')
        require(path.stat().st_mode&0o022==0,'credential_database_invalid')
        for parent in path.parents:
            st=parent.stat();require(st.st_mode&0o022==0 or st.st_uid==0 and st.st_mode&0o1000,'credential_database_invalid')
        before=(path.stat().st_dev,path.stat().st_ino)
        expected=tx['intent']['expected'];uid=tx['identity_id']
        client=self.core.view(tx['gateway'],tx['alarm']).client
        rows=client.request('/alarmsystems/users')
        require(rows.get(uid)==expected,'credential_gateway_revision_changed')
        with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2) as db:
            db.execute('PRAGMA query_only=ON')
            row=db.execute('SELECT revision,hash FROM gateway_users_v2 WHERE uid=?',(uid,)).fetchone()
        require(before==(path.stat().st_dev,path.stat().st_ino) and path.resolve()==path,'credential_database_changed')
        require(row is not None and row[0]==expected['user_revision'],'credential_database_revision_changed')
        client.verify(tx['alarm'])
        require(client.request('/alarmsystems/users').get(uid)==expected,'credential_gateway_revision_changed')
        return row[1]
    def submit(self,tx,pin):
        require(tx['stage']=='recovery_required' and tx['write_attempted'] and not tx['verified'],'credential_recovery_unsupported')
        row=self.read(tx)
        require(hmac.compare_digest(commitment(pin,row['salt']),row['commitment']),'credential_does_not_match_intent')
        encoded=self.current(tx)
        require(verify_hash(pin,encoded),'credential_not_verified')
        row['proof']=hashlib.sha256(encoded.encode()).hexdigest()
        atomic(self.path(tx),row)
        return {'credential_verified':True,'gateway_write_replayed':False}
    def verify(self,tx):
        if tx['operation']!='rotate_pin' or self.profile(tx) is None:return False
        try:
            row=self.read(tx)
            return isinstance(row['proof'],str) and hmac.compare_digest(row['proof'],hashlib.sha256(self.current(tx).encode()).hexdigest())
        except Exception:return False
