'use strict';
const $=id=>document.getElementById(id);
let csrf='',busy=false,writing=false,loading=false,setup=null,inventory=null,draft=null,draftScope=null,recovery=null,epoch=0,lastDisplay=0;
let activeGateways=[];
let localSearch=0,localSearching=false,localRows=[];
const flags={grant_enabled:'Grant enabled for this alarm',owner:'Unrestricted owner',arm:'May arm',disarm:'May disarm',api_arm_disarm:'Allow REST/API arm and disarm'};
const scope=()=>({gateway:$('gateway').value,alarm:Number($('alarm').value)});
const same=(a,b)=>a&&b&&a.gateway===b.gateway&&a.alarm===b.alarm;
async function api(path,body,selected){
  const headers={};
  if(body!==undefined){headers['Content-Type']='application/json';headers['X-CSRF-Token']=csrf;}
  if(selected){headers['X-Configurator-Gateway']=selected.gateway;if(selected.alarm)headers['X-Configurator-Alarm']=String(selected.alarm);}
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok){if(response.status===401)clearSession();throw Error(result.error||'Request unavailable');}
  return result;
}
function message(value){$('message').textContent=value instanceof Error?value.message:value||'';}
function options(id,rows){$(id).replaceChildren(...rows.map(row=>{const option=document.createElement('option');option.value=row.id;option.textContent=row.name;return option;}));}
function secretsClear(){for(const id of ['password','connection-key','user-pin','new-pin','repeat-pin','keypad-code','recovery-pin'])$(id).value='';}
function invalidate(){for(const id of ['overview','access-summary','history','transaction','keypads','schedule-summary','timings','lockout-fields'])$(id).textContent='';$('user-form').reset();options('user-select',[]);epoch++;draft=null;draftScope=null;recovery=null;$('editor').disabled=true;$('confirm-recovery').disabled=true;$('recovery-ack').checked=false;$('keypad-confirm').checked=false;$('backup-ack').checked=false;secretsClear();}
function clearSession(){localSearch++;localSearching=false;localRows=[];$('local-discovery-status').textContent='';$('local-choice-label').hidden=true;invalidate();csrf='';setup=null;inventory=null;$('application').hidden=true;$('login').hidden=false;for(const id of ['overview','access-summary','history','transaction','keypads','schedule-summary'])$(id).textContent='';$('user-form').reset();$('gateway-settings').reset();options('user-select',[]);options('connection-select',[]);options('gateway',[]);options('alarm',[]);}
function numberField(container,id,title,value,min,max){const label=document.createElement('label');label.textContent=title;const input=document.createElement('input');Object.assign(input,{id,type:'number',value,min,max,required:true});label.append(input);$(container).append(label);}
for(const [key,title] of Object.entries(flags)){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.id=key;label.append(input,document.createTextNode(title));$('grant-flags').append(label);}
async function refresh(){
  if(busy||writing||!$('gateway').value||!$('alarm').value)return;
  busy=true;const selected=scope(),generation=epoch;
  try{
    const results=await Promise.allSettled([api('/api/overview',undefined,selected),api('/api/history',undefined,selected),api('/api/transaction',undefined,selected)]);
    const [overview,history,transaction]=results.map(r=>r.status==='fulfilled'?r.value:null);
    if(generation!==epoch)return;
    if(overview)$('overview').textContent=`${overview.alarm.state} · target ${overview.alarm.target} · ${overview.users.length} user grant(s) · ${overview.capabilities.managed?'managed':'not enrolled'}`;
    else $('overview').textContent='Gateway status unavailable.';
    if(overview)$('access-summary').replaceChildren(...overview.users.map(row=>{const p=document.createElement('p');p.textContent=`${row.name} · ${row.owner?'owner':'user'} · identity ${row.enabled?'enabled':'disabled'} · grant ${row.grant_enabled?'enabled':'disabled'} · arm ${row.arm?'yes':'no'} · disarm ${row.disarm?'yes':'no'} · API ${row.api_arm_disarm?'yes':'no'} · uses ${row.remaining_uses??'unlimited'} · physical keypads ${row.all_keypads?'all':row.keypads?.length||0}${row.schedule?' · schedule '+JSON.stringify(row.schedule):' · no schedule restriction'}`;return p;}));
    if(history)$('history').textContent=history.rows.map(row=>`${row.time} · ${row.user} · ${row.source}\n${row.action}: ${row.result}`).join('\n\n')||'No collected events.';
    $('connection').textContent=history?.connected?'Live collection connected':'Collection disconnected; gaps cannot be replayed';
    $('transaction').textContent=transaction?JSON.stringify(transaction,null,2):'Transaction status unavailable.';
    if(recovery&&transaction?.id!==recovery.transaction_id){recovery=null;$('confirm-recovery').disabled=true;}
  }catch(error){if(generation===epoch)message(error);}finally{busy=false;}
}
async function discover(requested=false){
  invalidate();const selected=scope(),generation=epoch;
  $('overview').textContent='';$('access-summary').textContent='';$('history').textContent='';$('transaction').textContent='';
  if(!selected.gateway){options('alarm',[{id:'',name:'Activate a gateway first'}]);workspaceState();return;}
  options('alarm',[{id:'',name:'Loading alarms…'}]);workspaceState('loading');
  try{const data=await api(requested?'/api/discover':'/api/inventory',requested?{}:undefined,{gateway:selected.gateway});if(generation!==epoch)return;inventory=data;options('alarm',data.alarms.length?data.alarms:[{id:'',name:'No alarms available'}]);if(data.alarms.some(r=>String(r.id)===String(selected.alarm)))$('alarm').value=String(selected.alarm);workspaceState();await refresh();backupDescription();}catch(error){if(generation===epoch){options('alarm',[{id:'',name:'Unable to load alarms'}]);workspaceState('error');message(error);}}
}
function backupDescription(){const row=setup?.backup?.find(r=>r.gateway===$('gateway').value);$('backup-description').textContent=row?.credential_backup?'A configured local SQLite backup must pass policy and integrity checks before each edit. It is not an automatic rollback or proof of a later uncertain write.':'Only gateway policy is exported before editing. PIN credentials are NOT backed up. Remote gateway database backup requires its host administrator.';}
function renderSetup(value,preferred){
  const selected=preferred??$('connection-select').value;
  setup={...setup,...value};
  $('setup').textContent=`${setup.access_mode==='observe'?'Read-only':'Management enabled'} · Homebridge ${setup.homebridge?'configured':'disabled'} · ${setup.extensions?.length||0} extension(s)${setup.restart_required?' · Connection changes await broker restart; writes blocked':''}`;
  $('discovery-seconds').value=setup.application.discovery_seconds;$('display-seconds').value=setup.application.display_seconds;
  options('connection-select',[...setup.gateways,{id:'',name:'Add another gateway…'}]);$('connection-select').value=setup.gateways.some(r=>r.id===selected)?selected:(setup.gateways.length===1?setup.gateways[0].id:'');$('saved-connection-label').hidden=!setup.gateways.length;connectionDraft();backupDescription();$('connect-gateway').disabled=!!setup.key_enrollments?.some(r=>r.stage==='writing');const pending=setup.key_enrollments?.find(r=>r.stage==='key_saved');if(pending){useLocalGateway(pending.connection);$('connection-id').value=pending.connection.id;$('local-discovery-status').textContent='An API key is already saved privately. Press Connect to retry verification without creating another key.';}
}
function connectionDraft(){localSearch++;$('local-choice-label').hidden=true;$('local-discovery-status').textContent='';const row=setup.gateways.find(r=>r.id===$('connection-select').value);for(const key of ['id','name','identity','endpoint'])$('connection-'+key).value=row?.[key]||'';$('connection-id').readOnly=!!row;$('connection-identity').readOnly=!!row;$('connection-key').value='';$('connection-manual').open=false;$('connect-gateway').hidden=!!row;$('key-creation-help').hidden=!!row;connectionCard(row);workspaceState();}
function connectionCard(row){
  $('connection-summary').hidden=!row;
  if(!row)return;
  $('connection-title').textContent=row.name;
  $('connection-detail').textContent=row.endpoint;
  const saved=setup.gateways.some(r=>r.id===row.id&&r.identity===row.identity);
  $('connection-state').textContent=saved?(setup.restart_required?'Saved · activation pending':activeGateways.some(g=>g.id===row.id)?'Active':'Saved connection'):'Gateway found · ready to connect';
}
function workspaceState(state){
  const active=!!$('gateway').value,alarm=!!$('alarm').value;
  $('activation-notice').hidden=!setup?.restart_required;
  $('scope-controls').hidden=!active;
  $('refresh-settings').hidden=!active;
  $('alarm-content').hidden=!active||!alarm;
  $('alarm').disabled=!alarm;$('refresh').disabled=!alarm;
  $('workspace-empty').hidden=active&&alarm;
  $('workspace-empty-title').textContent=state==='error'?'Gateway unavailable':state==='loading'?'Loading alarms…':active?'No alarms available':setup?.restart_required?'Your gateway is saved':'Connect a gateway to get started';
  $('workspace-empty-detail').textContent=state==='error'?'Check the gateway connection, then refresh devices.':state==='loading'?'Reading the gateway’s alarm list.':active?'No alarms were returned by this gateway. Refresh devices after configuring an alarm.':setup?.restart_required?'Alarms will appear here after the saved connection is activated.':'Find your local gateway above, or enter its address in Connection options.';
}
function connectionSnapshot(){return JSON.stringify(['id','name','identity','endpoint','key'].map(k=>$('connection-'+k).value));}
function useLocalGateway(row){
  if(!row||$('connection-select').value)return;
  if(!$('connection-id').value){let id='local-deconz',n=2;while(setup.gateways.some(r=>r.id===id))id='local-deconz-'+n++;$('connection-id').value=id;}
  for(const key of ['name','identity','endpoint'])$('connection-'+key).value=row[key];connectionCard({...row,id:$('connection-id').value});
  $('local-discovery-status').textContent='Local gateway details filled in. Press Connect to create and privately save this application’s API key.';
}
async function findLocal(){
  if(localSearching||!setup)return;
  localSearching=true;$('find-local').disabled=true;
  const generation=++localSearch,before=connectionSnapshot();
  $('local-discovery-status').textContent='Checking for deCONZ on this Linux server…';
  try{
    const data=await api('/api/setup/local-gateways');
    if(generation!==localSearch||!setup)return;
    localRows=data.gateways||[];
    if($('connection-select').value||before!==connectionSnapshot()){
      $('local-discovery-status').textContent='Search finished. Your current connection fields were kept.';return;
    }
    if(!localRows.length){$('connection-manual').open=true;$('local-discovery-status').textContent='No local deCONZ gateway found on ports 80 or 8080. Enter its custom or remote URL manually.';return;}
    if(localRows.length===1){useLocalGateway(localRows[0]);return;}
    options('local-choice',[{id:'',name:'Choose a gateway'},...localRows.map((r,i)=>({id:String(i),name:r.name+' — '+r.endpoint}))]);
    $('local-choice-label').hidden=false;$('local-discovery-status').textContent='More than one local gateway was found. Choose the intended gateway.';
  }catch(error){if(generation===localSearch&&setup){$('connection-manual').open=true;$('local-discovery-status').textContent='Local discovery unavailable. Enter the gateway URL and check its address.';};}
  finally{localSearching=false;$('find-local').disabled=false;}
}
async function probeAddress(){
  const before=connectionSnapshot(),generation=localSearch;
  const data=await api('/api/setup/probe',{endpoint:$('connection-endpoint').value});
  if(generation!==localSearch||before!==connectionSnapshot())throw Error('Connection changed during lookup. Check the address again.');
  useLocalGateway(data.gateway);
}
$('probe-address').onclick=async()=>{try{await probeAddress();}catch(error){message(error);}};
$('connect-gateway').onclick=async()=>{
  const button=$('connect-gateway');button.disabled=true;
  try{
    if($('connection-select').value)throw Error('This connection is already saved. Use its existing key.');
    if(!$('connection-identity').value)await probeAddress();
    const gateway=Object.fromEntries(['id','name','identity','endpoint'].map(k=>[k,$('connection-'+k).value]));
    const result=await api('/api/setup/connect',{revision:setup.revision,gateway,create_key:true});
    renderSetup(result,gateway.id);invalidate();workspaceState();message('Connection saved. Activate it below to load your alarms.');
  }catch(error){
    const guidance={enhanced_plugin_required:'This gateway requires the enhanced pponce/deconz-rest-plugin alarm-users-v1 build. See Connection and Homebridge help.',enhanced_alarm_required:'No enhanced alarms found. Check the required fork build and configure an alarm on the gateway first.',gateway_authenticate_app_required:'In Phoscon, open Settings → Gateway → Advanced → Authenticate app, then press Connect again within 60 seconds.',gateway_key_result_unknown:'The key-creation result is uncertain. Automatic retry is blocked; retain the local receipt for recovery.',gateway_not_found_check_address:'Gateway not found. Enter the correct address and port in Connection options.'};
    message(guidance[error.message]||error);$('connection-manual').open=true;
  }finally{button.disabled=!!setup?.key_enrollments?.some(r=>r.stage==='writing')||$('message').textContent.includes('key-creation result is uncertain');}
};
$('check-activation').onclick=async()=>{try{await start();message(setup.restart_required?'Still waiting for activation. Restart the candidate broker first.':'Connection active. Alarm list refreshed.');}catch(error){message(error);}};
$('find-local').onclick=findLocal;
$('local-choice').onchange=()=>{if($('local-choice').value!=='')useLocalGateway(localRows[Number($('local-choice').value)]);};
$('gateway-settings').addEventListener('input',event=>{if(event.target.id==='local-choice')return;localSearch++;$('local-choice-label').hidden=true;if(localSearching)$('local-discovery-status').textContent='Your edits were kept. Search again when ready.';});
$('application-setup').addEventListener('toggle',()=>{if($('application-setup').open&&setup&&!setup.gateways.length&&!$('connection-endpoint').value&&!$('connection-identity').value)findLocal();});
async function start(){const session=await api('/api/session');if(session.role==='regular'){location.assign('/');return;}
  const [value,data]=await Promise.all([api('/api/setup'),api('/api/gateways')]);renderSetup(value);
  $('access-mode').textContent=value.access_mode==='observe'?'Observation mode · alarm and keypad commands are disabled.':'Management enabled · edits require explicit submission.';
  $('management').hidden=value.access_mode!=='manage';$('credential-recovery').hidden=value.access_mode!=='manage';$('review-recovery').disabled=value.access_mode!=='manage';
  $('extensions').replaceChildren(...value.extensions.filter(e=>e.page).map(e=>{const a=document.createElement('a');a.href=e.page;a.textContent=e.name;return a;}));
  activeGateways=data.gateways;const previous=$('gateway').value;options('gateway',data.gateways.length?data.gateways:[{id:'',name:'No active gateway'}]);if(data.gateways.some(r=>r.id===previous))$('gateway').value=previous;$('application').hidden=false;$('login').hidden=true;await discover();connectionCard(setup.gateways.find(r=>r.id===$('connection-select').value));if(!setup.gateways.length){$('application-setup').open=true;if(!$('connection-endpoint').value&&!$('connection-identity').value)findLocal();}
}
async function loadDraft(){
  if(writing||loading||!scope().alarm)return;
  loading=true;
  const selected=scope(),generation=epoch;
  try{
    const data=await api('/api/editor',undefined,selected);
    let protection=null;try{protection=await api('/api/lockout',undefined,selected);}catch(error){message(error);}
    if(generation!==epoch)return;
    draft={...data,protection};draftScope=selected;
    options('user-select',[{id:'',name:'Create a new gateway identity'},...Object.values(data.identities).map(r=>({id:r.id,name:`${r.name}${data.grants[String(selected.alarm)][r.id]?'':' — no grant on this alarm'}`}))]);
    $('editor').disabled=false;userDraft();$('timings').replaceChildren();
    for(const [key,value] of Object.entries(data.alarm.timings))numberField('timings','timing-'+key,key.replaceAll('_',' '),value,0,255);
    $('lockout-fields').replaceChildren();$('lockout-form').hidden=!protection;
    if(protection){const p=protection.policy;$('lockout-enabled').checked=p.enabled;for(const [key,min,max] of [['threshold',1,100],['window_seconds',1,3600],['reset_seconds',3600,604800]])numberField('lockout-fields','lockout-'+key,key.replaceAll('_',' '),p[key],min,max);p.durations_seconds.forEach((v,i)=>numberField('lockout-fields','duration-'+i,`Level ${i+1} duration`,v,1,3600));}
    message('Fresh draft loaded. Background display refresh will preserve it.');
  }catch(error){message(error);}finally{loading=false;}
}
function userDraft(){
  secretsClear();$('user-form').reset();$('replace-schedule').checked=false;$('schedule-fields').disabled=true;
  const uid=$('user-select').value,identity=draft.identities[uid],grant=draft.grants[String(draftScope.alarm)][uid];
  $('user-name').value=identity?.name||'';$('user-name').readOnly=!!identity&&!grant;$('user-enabled').checked=identity?.enabled??true;$('user-enabled').disabled=!!identity&&!grant;
  for(const key of Object.keys(flags))$(key).checked=grant?.[key]??(key!=='owner');
  $('remaining-uses').value=grant?.remaining_uses??'';$('all-keypads').checked=grant?.all_keypads??false;
  const pads=new Map();for(const pad of inventory?.keypads||[])if(pad.address&&pad.alarm_ids.includes(draftScope.alarm))pads.set(JSON.stringify(pad.address),{address:pad.address,name:pad.name});
  for(const address of grant?.keypads||[])if(!pads.has(JSON.stringify(address)))pads.set(JSON.stringify(address),{address,name:'Previously allowed keypad (not currently discovered)'});
  $('keypads').replaceChildren(...Array.from(pads.values()).map(pad=>{const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.address=JSON.stringify(pad.address);input.checked=!!grant?.keypads.some(p=>p.source===pad.address.source&&p.endpoint===pad.address.endpoint);label.append(input,document.createTextNode(pad.name));return label;}));
  const schedule=grant?.schedule;$('schedule-enabled').checked=!!schedule;$('timezone').value=schedule?.timezone||'UTC';
  const clock=minutes=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
  $('weekly').value=(schedule?.windows||[]).map(w=>`${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][w.day-1]} ${clock(w.start)}-${clock(w.end)}`).join('\n');
  $('not-before').value=schedule?.not_before?new Date(schedule.not_before).toISOString().slice(0,-1):'';
  $('expires-local').value='';
  if(schedule?.expires_at){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(schedule.expires_at)).map(p=>[p.type,p.value]));$('expires-local').value=`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;}
  $('schedule-summary').textContent=grant?.schedule?'Existing schedule will be preserved exactly: '+JSON.stringify(grant.schedule):'No schedule restriction.';
  $('enrollment-label').hidden=draft.capabilities[String(draftScope.alarm)].managed;
  $('user-pin').disabled=!!grant;$('user-pin').required=!grant;$('delete-user').disabled=!grant;$('pin-form').hidden=!identity;
  $('all-keypads').onchange();
}
function checkDraft(){if(!draft||!same(draftScope,scope()))throw Error('Load a fresh draft for the selected alarm.');}
async function write(path,body,selected=scope(),backup=true){
  if(writing)throw Error('A request is already in progress.');
  if(backup&&!$('backup-ack').checked)throw Error('Acknowledge backup coverage before editing.');
  writing=true;epoch++;$('gateway').disabled=$('alarm').disabled=true;
  try{const result=await api(path,backup?{...body,backup_acknowledged:true}:body,selected);message('Request completed and verified. Load a fresh draft before another edit.');return result;}
  finally{secretsClear();writing=false;$('gateway').disabled=$('alarm').disabled=false;draft=null;draftScope=null;$('editor').disabled=true;$('backup-ack').checked=false;await refresh();}
}
$('user-form').onsubmit=async event=>{event.preventDefault();try{checkDraft();const uid=$('user-select').value,identity=draft.identities[uid],grant=draft.grants[String(draftScope.alarm)][uid];const body={id:uid||null,alarm:draftScope.alarm,revision:grant?.revision||0,user_revision:identity?.user_revision||0,name:$('user-name').value,enabled:$('user-enabled').checked,remaining_uses:$('remaining-uses').value===''?null:Number($('remaining-uses').value),all_keypads:$('all-keypads').checked,keypads:$('all-keypads').checked?[]:Array.from($('keypads').querySelectorAll('input:checked')).map(i=>JSON.parse(i.dataset.address)),enable_management:$('enrollment').checked};for(const key of Object.keys(flags))body[key]=$(key).checked;
  if(grant&&!$('replace-schedule').checked)body.preserve_schedule=true;else body.schedule=$('replace-schedule').checked&&$('schedule-enabled').checked?{timezone:$('timezone').value,weekly:$('weekly').value,expires_local:$('expires-local').value,not_before:$('not-before').value?Date.parse($('not-before').value+'Z'):null}:null;
  if(!grant)body.pin=$('user-pin').value;await write('/api/users/save',body,draftScope);
}catch(error){secretsClear();message(error);}};
$('delete-user').onclick=async()=>{try{checkDraft();const row=draft.grants[String(draftScope.alarm)][$('user-select').value];if(!row)throw Error('Select an existing grant.');if(!confirm('Remove access to this alarm? The gateway identity remains.'))return;await write('/api/users/delete',{id:row.id,alarm:draftScope.alarm,revision:row.revision,user_revision:row.user_revision},draftScope);}catch(error){message(error);}};
$('pin-form').onsubmit=async event=>{event.preventDefault();try{checkDraft();const row=draft.identities[$('user-select').value];if(!row)throw Error('Select an existing identity.');await write('/api/users/rotate-pin',{id:row.id,revision:row.user_revision,user_revision:row.user_revision,new_pin:$('new-pin').value,repeat_pin:$('repeat-pin').value},draftScope);}catch(error){secretsClear();message(error);}};
$('timing-form').onsubmit=async event=>{event.preventDefault();try{checkDraft();const timings=Object.fromEntries(Object.keys(draft.alarm.timings).map(key=>[key,Number($('timing-'+key).value)]));await write('/api/alarm/save',{timings,revision:draft.alarm.revision},draftScope);}catch(error){message(error);}};
$('lockout-form').onsubmit=async event=>{event.preventDefault();try{checkDraft();const body={revision:draft.protection.policy.revision,enabled:$('lockout-enabled').checked,durations_seconds:[0,1,2].map(i=>Number($('duration-'+i).value))};for(const key of ['threshold','window_seconds','reset_seconds'])body[key]=Number($('lockout-'+key).value);await write('/api/lockout/save',body,draftScope);}catch(error){message(error);}};
$('reset-lockout').onclick=async()=>{try{checkDraft();if(confirm('Reset physical keypad lockouts for this alarm?'))await write('/api/lockout/reset',{reset:true},draftScope);}catch(error){message(error);}};
$('keypad-form').onsubmit=async event=>{event.preventDefault();if(writing)return;const body={mode:$('keypad-mode').value,code:$('keypad-code').value,request_id:crypto.randomUUID().replaceAll('-','')};$('keypad-code').value='';$('keypad-confirm').checked=false;try{const result=await write('/api/keypad/send',body,scope(),false);$('keypad-result').textContent=`${result.result}${result.uncertain?' · uncertain; no retry':''}${result.extension?' · '+result.extension:''}`;}catch(error){$('keypad-result').textContent='Result unavailable. Do not resend to test; inspect transaction recovery.';message(error);}finally{body.code='';}};
$('review-recovery').onclick=async()=>{const selected=scope(),generation=epoch;try{const result=await api('/api/recovery/review',{},selected);if(generation!==epoch)return;recovery={...result,scope:selected};$('recovery-ack').checked=false;$('confirm-recovery').disabled=!result.ready;message(result.ready?'Evidence review ready. Confirm only after reviewing the required maintenance steps.':'Independent verification is still required; transaction remains held.');}catch(error){recovery=null;$('confirm-recovery').disabled=true;message(error);}};
$('confirm-recovery').onclick=async()=>{try{if(!recovery?.ready||!same(recovery.scope,scope())||!$('recovery-ack').checked)throw Error('Review and acknowledge recovery first.');const review=recovery;recovery=null;$('confirm-recovery').disabled=true;await write('/api/recovery/confirm',{transaction_id:review.transaction_id,token:review.token,reviewed:true},review.scope,false);}catch(error){message(error);}};
$('application-settings').onsubmit=async event=>{event.preventDefault();try{setup={...setup,...await api('/api/setup/application',{revision:setup.application_revision,settings:{discovery_seconds:Number($('discovery-seconds').value),display_seconds:Number($('display-seconds').value)}})};message('Intervals saved; background collection remains active.');}catch(error){message(error);}};
$('gateway-settings').onsubmit=async event=>{event.preventDefault();try{const gateway=Object.fromEntries(['id','name','identity','endpoint','key'].map(k=>[k,$('connection-'+k).value]));$('connection-key').value='';renderSetup(await api('/api/setup/gateway',{revision:setup.revision,gateway}),gateway.id);invalidate();workspaceState();message('Connection verified and saved. Broker restart is required to activate it.');}catch(error){message(error);}finally{$('connection-key').value='';}};
$('connection-select').onchange=connectionDraft;$('load-editor').onclick=loadDraft;$('user-select').onchange=userDraft;
$('replace-schedule').onchange=()=>{$('schedule-fields').disabled=!$('replace-schedule').checked;};
$('all-keypads').onchange=()=>{for(const input of $('keypads').querySelectorAll('input'))input.disabled=$('all-keypads').checked;};
$('login').onsubmit=async event=>{event.preventDefault();try{const data=await api('/api/login',{username:$('username').value.trim(),password:$('password').value});$('password').value='';csrf=data.csrf;await start();}catch(error){secretsClear();message(error);}};
$('logout').onclick=async()=>{try{await api('/api/logout',{});clearSession();}catch(error){secretsClear();message(error);}};
$('gateway').onchange=()=>discover();$('alarm').onchange=()=>{invalidate();refresh();};$('discover').onclick=()=>discover(true);$('refresh').onclick=refresh;
setInterval(()=>{if(!$('application').hidden&&$('automatic').checked&&Date.now()-lastDisplay>=(setup?.application.display_seconds||5)*1000){lastDisplay=Date.now();refresh();}},500);
(async()=>{try{const data=await api('/api/session');csrf=data.csrf;await start();}catch(_){/* A new session requires sign-in. */}})();

$('credential-recovery').onsubmit=async event=>{event.preventDefault();const selected=scope(),generation=epoch;let pin=$('recovery-pin').value;$('recovery-pin').value='';try{const tx=await api('/api/transaction',undefined,selected);if(generation!==epoch)return;await api('/api/recovery/credential',{transaction_id:tx.id,pin},selected);message('Credential verified without an alarm command. Review recovery and maintenance obligations before completing.');}catch(error){message(error);}finally{pin='';$('recovery-pin').value='';}};
