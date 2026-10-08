"""Optional same-host adapter. No dynamic imports or browser-provided commands."""
import copy
import os
import pwd
import subprocess
from pathlib import Path
import re
import stat
import time
from .common import atomic, loads, require, Rejected
from .configuration import directory
from .homebridge_local import (eligible, private_read, cache_path, gateway_port,
    pin_context, edited_cache, replace_cache, listener_owner, run, stopped,
    Request, build_opener, ProxyHandler, HTTPRedirectHandler)
from .homebridge_probe import inspect
from .homebridge_sources import EXPECTED


def validate(config, gateways):
    require(isinstance(config,dict) and set(config)=={'schema','profile','storage','package','bindings'} and
            type(config['schema']) is int and config['schema']==1 and config['profile']=='local-hb-service',
            'homebridge_profile_unsupported')
    for key in ('storage','package'):
        value=config[key]
        require(isinstance(value,str) and Path(value).is_absolute() and Path(value).resolve()==Path(value),
                'homebridge_path_invalid')
    bindings=config['bindings']; require(isinstance(bindings,list) and 1<=len(bindings)<=16,'homebridge_bindings_invalid')
    seen=set(); registered={r['id']:r['identity'] for r in gateways}
    for row in bindings:
        require(isinstance(row,dict) and set(row)=={'gateway','identity','user','alarms'},'homebridge_bindings_invalid')
        require(isinstance(row['gateway'],str) and row['gateway'] not in seen and
                registered.get(row['gateway'])==row['identity'],'homebridge_gateway_invalid')
        require(isinstance(row['user'],str) and re.fullmatch('[0-9a-f]{32}',row['user']),'homebridge_user_invalid')
        alarms=row['alarms']
        require(isinstance(alarms,list) and 1<=len(alarms)<=255 and
                all(type(a) is int and 1<=a<=255 for a in alarms) and len(set(alarms))==len(alarms),
                'homebridge_alarms_invalid')
        seen.add(row['gateway'])
    return config


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): raise Rejected('homebridge_redirect_forbidden')


class LocalHost:
    """Finite Linux hb-service profile. Installer must provide narrowly scoped access."""
    def __init__(self,config):self.config=config
    def sources(self):
        value=inspect(Path(self.config['package']))
        require({key:value[key] for key in ('plugin','library')}==EXPECTED,'homebridge_source_changed_review_required')
    def files(self):
        self.sources()
        root=Path(self.config['storage']); config=private_read(root/'config.json')
        path=cache_path(loads(config),root)
        return path,private_read(path),config
    def resolve(self,raw,binding):
        rows=loads(raw);gid=binding['identity'];port=gateway_port(rows,gid);pid=listener_owner(port)
        request=Request('http://127.0.0.1:'+str(port)+'/gateways/'+gid+'/accessories',method='GET')
        with build_opener(ProxyHandler({}),NoRedirect()).open(request,timeout=5) as response:
            data=response.read(1024*1024+1)
        require(len(data)<=1024*1024 and listener_owner(port)==pid,'homebridge_listener_unverified')
        values=loads(data);require(isinstance(values,dict),'homebridge_response_invalid')
        mapping={}
        for alarm in binding['alarms']:
            matches=[key for key,row in values.items() if isinstance(row,dict) and row.get('type')=='alarmsystems'
                     and row.get('resources')==['/alarmsystems/'+str(alarm)]]
            require(len(matches)==1,'one_homebridge_alarm_required')
            pin_context(rows,gid,matches[0]);mapping[str(alarm)]=matches[0]
        require(len(set(mapping.values()))==len(mapping),'homebridge_accessory_identity_changed')
        return mapping,pid
    def service_executable(self):
        candidates=[Path(p) for p in ('/usr/bin/hb-service','/usr/local/bin/hb-service','/opt/homebridge/bin/hb-service') if Path(p).is_file()]
        targets={p.resolve() for p in candidates}
        require(len(targets)==1,'one_homebridge_service_executable_required')
        path=next(iter(targets))
        owner=path.stat().st_uid
        if owner!=0:
            try:
                account=pwd.getpwnam('homebridge')
                result=subprocess.run(['systemctl','show','homebridge.service','--property=User','--value'],capture_output=True,timeout=5)
                user=result.stdout.decode().strip() or 'root'
                require(result.returncode==0 and pwd.getpwnam(user).pw_uid==account.pw_uid==owner and owner>0,
                        'homebridge_service_executable_untrusted')
            except (KeyError,UnicodeError):raise Rejected('homebridge_service_executable_untrusted') from None
        for item in (path,*path.parents):
            metadata=item.stat()
            require(metadata.st_uid in (0,owner) and not metadata.st_mode & 0o022,'homebridge_service_executable_untrusted')
        require(stat.S_ISREG(path.stat().st_mode) and os.access(path,os.X_OK),'homebridge_service_executable_untrusted')
        return path
    def service(self, action):
        require(action in ('stop','start'),'homebridge_service_operation_invalid')
        run(str(self.service_executable()),action)
    def stop(self,pid):self.service('stop');stopped(pid)
    def assert_stopped(self,pid):stopped(pid,timeout=0)
    def start(self):self.service('start')
    def replace(self,path,old,new):replace_cache(path,old,new)
    def wait_ready(self,check):
        deadline=time.monotonic()+30
        while True:
            try:return check()
            except Exception:
                require(time.monotonic()<deadline,'homebridge_restart_unverified')
                time.sleep(0.5)


class Adapter:
    api_version=1
    def __init__(self,core,host=None):
        self.core=core;self.config=core.config['homebridge'];self.host=host or LocalHost(self.config)
        self.bindings={r['gateway']:r for r in self.config['bindings']}
        self.lease=core.state/'homebridge-maintenance.json'
        self.pin=None;self.prepared=None
        self.selection_path=core.state/'homebridge-selections.json'
        if type(self) is Adapter: self.refresh_bindings()
    def refresh_bindings(self):
        from .transactions import digest
        self.bindings={r['gateway']:copy.deepcopy(r) for r in self.config['bindings']}
        if self.selection_path.exists() or self.selection_path.is_symlink():
            saved=loads(private_read(self.selection_path))
            require(isinstance(saved,dict) and set(saved)=={'schema','base','bindings'} and saved['schema']==1 and
                    saved['base']==digest(self.config),'homebridge_selection_registration_changed')
            validate(dict(self.config,bindings=saved['bindings']),self.core.config['gateways'])
            self.bindings={r['gateway']:r for r in saved['bindings']}
        record=self.record()
        if record and record.get('complete') and record.get('selection_digest'):
            require(self.selection_path.exists() and digest(self.bindings)==record['selection_digest'],'homebridge_selection_state_changed')
    def selection_plan(self,gateway,uid,value,snapshot):
        self.refresh_bindings()
        require(isinstance(value,dict) and set(value)=={'expected_user_id','alarms'},'invalid_homebridge_selection')
        previous=copy.deepcopy(self.bindings.get(gateway))
        require(value['expected_user_id']==(previous['user'] if previous else None),'homebridge_binding_changed')
        candidate={'gateway':gateway,'identity':self.core.registrations[gateway]['identity'],'user':uid,'alarms':value['alarms']}
        validate(dict(self.config,bindings=[candidate]),self.core.config['gateways'])
        candidate['alarms']=sorted(candidate['alarms'])
        require(not previous or set(previous['alarms'])<=set(candidate['alarms']),'homebridge_alarm_removal_requires_review')
        for aid in candidate['alarms']:
            require(snapshot['capabilities'].get(str(aid),{}).get('managed') is True and
                    eligible(snapshot['grants'].get(str(aid),{}).get(uid,{})),'homebridge_user_must_remain_unrestricted')
        return {'previous':previous,'binding':candidate}
    def selected_binding(self,tx):
        selection=tx.get('homebridge_selection')
        return selection['binding'] if selection else self.bindings[tx['gateway']]
    def save_selection(self,tx):
        if not tx.get('homebridge_selection') or not tx['write_attempted'] or tx.get('definite_rejection'): return
        from .transactions import digest
        self.refresh_bindings()
        selection=tx['homebridge_selection'];current=self.bindings.get(tx['gateway'])
        require(current in (selection['previous'],selection['binding']),'homebridge_binding_changed')
        self.bindings[tx['gateway']]=copy.deepcopy(selection['binding'])
        atomic(self.selection_path,{'schema':1,'base':digest(self.config),
                                   'bindings':[self.bindings[g] for g in sorted(self.bindings)]})
    def record(self):
        if not self.lease.exists():return None
        return loads(private_read(self.lease))
    def guard(self):
        self.refresh_bindings()
        # An earlier participant may fail before Homebridge.pause runs. The core
        # journal already owns the service obligation even without a lease file.
        for path in self.core.state.glob('transaction-*.json'):
            gateway=path.name[len('transaction-'):-len('.json')]
            tx=self.core.transactions.load(gateway)
            if tx and tx['stage']!='complete' and 'homebridge' in tx['participants']:
                self.core.transactions.required(tx)
                raise Rejected('homebridge_shared_service_recovery_required')
        record=self.record()
        if record and record.get('complete') is not True:
            tx=self.core.transactions.load(record['gateway'])
            if tx and tx['id']==record['id'] and tx['stage']=='complete':
                self.complete(tx)
                return
        require(record is None or record.get('complete') is True,'homebridge_shared_service_recovery_required')
    def status(self):
        self.refresh_bindings()
        record=self.record()
        pending=bool(record and not record.get('complete'))
        for path in self.core.state.glob('transaction-*.json'):
            tx=self.core.transactions.load(path.name[len('transaction-'):-len('.json')])
            pending=pending or bool(tx and tx['stage']!='complete' and 'homebridge' in tx['participants'])
        return {'configured':True,'profile':'local-hb-service','pending':pending,
                'bindings':[{'gateway':r['gateway'],'user':r['user'],'alarms':r['alarms']} for r in self.bindings.values()]}
    def protect(self,gateway,alarm,plan,payload,snapshot):
        self.guard();binding=self.bindings.get(gateway)
        if plan.get('homebridge_selection'): return True
        if not binding or plan.get('uid')!=binding['user']:return False
        if plan['operation']=='rotate_pin':
            for aid in binding['alarms']:
                require(eligible(snapshot['grants'].get(str(aid),{}).get(binding['user'],{})),
                        'homebridge_user_must_remain_unrestricted')
            return True
        if plan['operation']=='save_user':
            require(payload.get('enabled') is True,'homebridge_user_must_remain_unrestricted')
        if alarm in binding['alarms'] and plan['operation'] in ('save_user','delete_user'):
            require(not plan.get('deleting') and eligible(payload),'homebridge_user_must_remain_unrestricted')
        return False
    def applies(self,context):
        binding=self.bindings.get(context['gateway'])
        return bool(context['operation']=='rotate_pin' and (context.get('homebridge_selection') or binding and context.get('identity_id')==binding['user']))
    def preflight(self,context):
        self.guard();binding=self.selected_binding(context)
        if context.get('homebridge_selection'):
            from .editing import Editor
            selection=context['homebridge_selection'];previous=selection['previous']
            value={'expected_user_id':previous['user'] if previous else None,'alarms':binding['alarms']}
            verified=self.selection_plan(context['gateway'],context['identity_id'],value,Editor(self.core.view(context['gateway'],context['alarm'])).snapshot())
            require(verified==selection,'homebridge_binding_changed')
        path,raw,config=self.host.files();mapping,pid=self.host.resolve(raw,binding)
        require(self.pin is not None,'homebridge_credential_context_required')
        self.prepared=(path,config,mapping,pid)
    def folder(self,tx):
        require(re.fullmatch('[0-9a-f]{32}',tx['id']),'homebridge_transaction_invalid')
        root=directory(self.core.config['backup_root'])
        folder=root/('homebridge-'+tx['id'])
        require(not folder.is_symlink(),'homebridge_backup_path_invalid')
        if folder.exists():directory(str(folder))
        return folder
    def pause(self,tx):
        path,config,mapping,pid=self.prepared
        record={'schema':1,'id':tx['id'],'gateway':tx['gateway'],'complete':False}
        previous=self.record()
        if previous and previous.get('selection_digest'):record['selection_digest']=previous['selection_digest']
        atomic(self.lease,record) # durable shared-service obligation before stop
        folder=self.folder(tx);folder.mkdir(mode=0o700)
        atomic(folder/'metadata.json',{'path':str(path),'pid':pid,'mapping':mapping,'binding':self.selected_binding(tx)})
        atomic(folder/'config.json',loads(config))
        self.host.stop(pid)
        fresh,raw,afterconfig=self.host.files()
        require(fresh==path and loads(config)==loads(afterconfig),'homebridge_configuration_changed')
        edited=raw
        for accessory in mapping.values():edited=edited_cache(edited,self.selected_binding(tx)['identity'],accessory,self.pin)
        atomic(folder/'before.json',loads(raw));atomic(folder/'after.json',loads(edited))
        # Backup bytes are exact for compare-and-replace. JSON serializer whitespace
        # is not part of the cache identity, so retain the original separately.
        fd=os.open(folder/'before.raw',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
        fd=os.open(folder,os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    def assets(self,tx):
        record=self.record()
        require(record and record['id']==tx['id'] and record['gateway']==tx['gateway'],'homebridge_transaction_changed')
        folder=self.folder(tx);meta=loads(private_read(folder/'metadata.json'))
        require(meta['binding']==self.selected_binding(tx),'homebridge_binding_changed')
        path,raw,config=self.host.files()
        require(str(path)==meta['path'] and loads(config)==loads(private_read(folder/'config.json')),'homebridge_configuration_changed')
        return folder,meta,path,raw
    def verify_gateway(self,tx):
        binding=self.selected_binding(tx)
        client=self.core.view(tx['gateway'],tx['alarm']).client
        expected=dict(tx['intent']['expected'])
        if not tx['write_attempted'] or tx.get('definite_rejection'):
            expected['revision']-=1;expected['user_revision']-=1
        actual=client.request('/alarmsystems/users').get(binding['user'],{})
        require({key:actual.get(key) for key in expected}==expected,'homebridge_gateway_revision_changed')
        for alarm in binding['alarms']:
            client.verify(alarm)
            row=client.request('/alarmsystems/'+str(alarm)+'/users').get(binding['user'],{})
            require(eligible(row),'homebridge_user_must_remain_unrestricted')
    def recovery_ready(self,tx):
        try:
            folder,meta,path,raw=self.assets(tx)
            self.verify_gateway(tx)
            if self.record().get('restart_requested'):
                self.verify_running(tx,folder,meta)
            else:
                self.host.assert_stopped(meta['pid'])
                require(raw in (private_read(folder/'before.raw'),private_read(folder/'after.json')),'homebridge_cache_changed')
            return True
        except Exception:return False
    def verify(self,tx):
        self.verify_gateway(tx)
        folder,meta,path,raw=self.assets(tx)
        if self.record().get('restart_requested'):
            self.verify_running(tx,folder,meta)
            return
        self.host.assert_stopped(meta['pid'])
        if not tx['write_attempted'] or tx.get('definite_rejection'):
            require(raw==private_read(folder/'before.raw'),'homebridge_cache_changed')
            return
        require(tx['verified'],'homebridge_gateway_write_unverified')
        desired=private_read(folder/'after.json')
        if raw!=desired:self.host.replace(path,private_read(folder/'before.raw'),desired)
        require(private_read(path)==desired,'homebridge_cache_write_unverified')
    def verify_running(self,tx,folder,meta):
        self.verify_gateway(tx)
        path,raw,config=self.host.files();mapping,pid=self.host.resolve(raw,meta['binding'])
        require(str(path)==meta['path'] and loads(config)==loads(private_read(folder/'config.json')),'homebridge_configuration_changed')
        require(mapping==meta['mapping'] and pid!=meta['pid'],'homebridge_restart_unverified')
        expected=loads(private_read(folder/('before.raw' if not tx['write_attempted'] or tx.get('definite_rejection') else 'after.json')))
        for accessory in mapping.values():
            require(pin_context(loads(raw),meta['binding']['identity'],accessory)['pin']==
                    pin_context(expected,meta['binding']['identity'],accessory)['pin'],'homebridge_saved_pin_unverified')
    def resume(self,tx):
        folder,meta,path,raw=self.assets(tx)
        record=self.record()
        if not record.get('restart_requested'):
            record['restart_requested']=True;atomic(self.lease,record)
            self.host.start()
        # Never repeat an uncertain service start. Read-only startup polling is bounded.
        if hasattr(self.host,'wait_ready'):
            self.host.wait_ready(lambda:self.verify_running(tx,folder,meta))
        else:self.verify_running(tx,folder,meta)
    def complete(self,tx):
        record=self.record()
        require(record and record['id']==tx['id'],'homebridge_transaction_changed')
        self.save_selection(tx)
        from .transactions import digest
        if self.selection_path.exists():record['selection_digest']=digest(self.bindings)
        record['complete']=True;atomic(self.lease,record)
