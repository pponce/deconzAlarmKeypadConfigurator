'use strict';
// Deliberately has no transport, credentials, device addresses or server fallback.
window.ConfiguratorDemo = (() => {
  const KEY='configurator-pages-demo-v1';
  const copy=x=>JSON.parse(JSON.stringify(x));
  const topology=[['demo-home','Demo · Home',['Entry','Workshop']],['demo-office','Demo · Office',['Reception','Office','Storage']],['demo-cabin','Demo · Cabin',['Cabin','Boathouse']]];
  const uid=n=>n.toString(16).padStart(32,'0');
  const timings=()=>Object.fromEntries(['stay','night','away'].flatMap(m=>['entry_delay','exit_delay','trigger_duration'].map(f=>['armed_'+m+'_'+f,f==='trigger_duration'?120:30])));
  function seed(){return Object.fromEntries(topology.map(([id,name,names],g)=>{
    const people=['Owner','Visitor','Homebridge'].map((name,i)=>({id:uid((g+1)*100+i),name,enabled:true,user_revision:1}));
    const alarms=names.map((name,i)=>({id:i+1,name:name+' alarm',managed:true,
      keypads:[0,1].map(k=>({name:name+(k?' side':' front')+' keypad',source:((g+1)*1000+i*10+k).toString(16),endpoint:1})),
      users:people.map((u,j)=>({...u,revision:1,grant_enabled:true,owner:j===0,arm:true,disarm:true,all_keypads:j===0,keypads:[],remaining_uses:j===1&&i===0?3:null,api_arm_disarm:j!==1,schedule:j===1&&i===1?{timezone:'UTC',not_before:null,expires_at:null,windows:[{day:1,start:540,end:1020}]}:null})),
      timing:timings(),timingRevision:1,policy:{enabled:false,threshold:6,window_seconds:60,durations_seconds:[60,600,1800],reset_seconds:3600,revision:1}}));
    alarms.forEach(a=>a.users.filter(u=>u.name==='Visitor').forEach(u=>u.keypads=[{source:a.keypads[0].source,endpoint:1}]));
    return [id,{identities:people,alarms,homebridge:{stage:'complete',user_id:people[2].id,alarm_ids:alarms.map(a=>a.id),gateway_selection:true},rows:[]}];
  }));}
  let state,retentionDays=30;
  const keypadSimulations=new Map();
  function keypadSimulation(g,alarm,context){
    const key=context.gateway+":"+alarm.id;
    if(!keypadSimulations.has(key))keypadSimulations.set(key,new window.BrowserKeypad.Simulation(()=>{}));
    return keypadSimulations.get(key);
  }
  function load(){if(state)return;try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved?.version===2&&topology.every(([id,,alarms])=>saved.data[id]?.alarms?.length===alarms.length)){state=saved.data;retentionDays=[1,3,7,30].includes(saved.retentionDays)?saved.retentionDays:30;}}catch(_){}if(!state)state=seed();
    // Remove historical demo rows only; never contact or clear the real collector.
    const hadRows=Object.values(state).some(g=>g.rows?.length);
    for(const g of Object.values(state))g.rows=[];
    if(hadRows)persist();
  }
  function persist(){try{localStorage.setItem(KEY,JSON.stringify({version:2,data:state,retentionDays}));}catch(_){throw Error('Demo storage unavailable. Changes remain in this tab only.');}}
  function log(){ /* Demo actions have no activity-history side effects. */ }
  function validPin(pin){if(typeof pin!=='string'||!/^\d{4,16}$/.test(pin))throw Error('Use a fictional PIN of 4–16 digits.');}
  function schedule(s){if(!s)return null;new Intl.DateTimeFormat('en',{timeZone:s.timezone});const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];return {timezone:s.timezone,not_before:s.not_before||null,expires_at:s.expires_local?new Date(s.expires_local+'Z').toISOString():null,windows:s.weekly.trim()?s.weekly.split('\n').map(line=>{const m=/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(line);if(!m)throw Error('Check the demo weekly time windows.');const start=Number(m[2])*60+Number(m[3]),end=Number(m[4])*60+Number(m[5]);if(start>=end||end>1440)throw Error('End time must follow start time.');return {day:days.indexOf(m[1])+1,start,end};}):[]};}
  function ownerGuard(g,alarm,next,remove=false){if(next.owner&&(!next.enabled||!next.grant_enabled||!next.arm||!next.disarm||!next.api_arm_disarm||next.remaining_uses!==null||next.schedule))throw Error('An owner must keep unrestricted time, uses, arm/disarm and API access.');for(const a of g.alarms){const rows=a.users.map(u=>u.id===next.id?(a===alarm?next:{...u,enabled:next.enabled}):u).filter(u=>!(remove&&a===alarm&&u.id===next.id));if(a.users.length&&!rows.some(u=>u.owner&&u.enabled&&u.grant_enabled))throw Error('Each alarm must retain an unrestricted owner.');}}
  function expireHistory(){const cutoff=Date.now()-retentionDays*86400000;for(const g of Object.values(state))g.rows=g.rows.filter(r=>Date.parse(r.time)>=cutoff);}
  async function request(path,body,context){load();if(path==='gateways')return {gateways:topology.map(([id,name])=>({id,name,demo:true}))};
    if(path==='activity-options')return {gateways:topology.map(([id,name])=>({id,name,connected:true,alarms:state[id].alarms.map(a=>({id:a.id,name:a.name}))}))};
    if(path==='history/retention'){
      if(![1,3,7,30].includes(body.days)||body.expected_days!==retentionDays)throw Error('Reload activity before changing retention.');
      if(body.days<retentionDays&&body.confirmed!==true)throw Error('Confirm before clearing older activity.');
      retentionDays=body.days;expireHistory();persist();return {retention_days:retentionDays};
    }
    if(path==='history/clear'){
      if(body.confirmed!==true||body.alarm&&!body.gateway)throw Error('Confirm the activity scope.');
      for(const [id,g] of Object.entries(state))if(!body.gateway||body.gateway===id)g.rows=g.rows.filter(r=>body.alarm&&r.alarm_id!==body.alarm);
      persist();return {cleared:true};
    }
    if(path==='history/query')return {connected:false,retention_days:retentionDays,sources:[],rows:[]};
    const g=state[context.gateway],top=topology.find(x=>x[0]===context.gateway);if(!g||!top)throw Error('Choose a demo gateway.');
    const alarm=g.alarms.find(a=>a.id===Number(body?.alarm??context.alarm))||g.alarms[0];
    if(path==='keypad')return {available:true,physical_lockout:false,simulation:keypadSimulation(g,alarm,context).snapshot()};
    if(path==='keypad/send')return keypadSimulation(g,alarm,context).send(body.code,body.mode,alarm.policy,alarm.timing);
    if(path==='transaction')return {stage:'none'};
    if(path==='inventory'||path==='discover')return {gateway:{name:top[1]},alarms:g.alarms.map(a=>({id:String(a.id),name:a.name,state:'disarmed',current:false})),keypads:g.alarms.flatMap(a=>a.keypads.map((k,i)=>({id:String(a.id*10+i),name:k.name,alarm_ids:[String(a.id)],current:false,reachable:true}))),current_alarm_id:null,current_keypad_id:null};
    if(path==='overview')return copy({identities:g.identities,alarms:g.alarms,users:alarm.users,managed:true,schedules:true,homebridge_sync:false,homebridge_available:true,homebridge_binding:{user:g.homebridge.user_id,alarms:g.homebridge.alarm_ids},homebridge_alarm:1,homebridge_selection:g.homebridge,settings_stage:'none'});
    if(path==='history')return {connected:false,rows:[]};
    if(path==='alarm')return copy({state:'disarmed',target:'disarmed',seconds_remaining:0,timings:alarm.timing,revision:String(alarm.timingRevision),timing_supported:true,rest_activity:true});
    if(path==='alarm/save'){if(body.revision!==String(alarm.timingRevision))throw Error('Reload the demo alarm before saving.');if(Object.keys(body.timings).length!==9||Object.values(body.timings).some(v=>!Number.isInteger(v)||v<0||v>255))throw Error('Use whole seconds from 0 to 255.');alarm.timing=copy(body.timings);alarm.timingRevision++;log(g,'Alarm timings saved',alarm);}
    else if(path==='lockout')return copy({managed:true,policy:alarm.policy,unmatched_keypads:[],keypads:alarm.keypads.map((pad,i)=>({id:String(alarm.id*10+i),name:pad.name,known:true,...(i===0?keypadSimulation(g,alarm,context).snapshot():{level:0,remaining_seconds:0})}))});
    else if(path==='lockout/save'){if(body.revision!==alarm.policy.revision)throw Error('Reload the demo protection settings.');const d=body.durations_seconds;if(d.length!==3||d.some((v,i)=>v<1||v>3600||i&&v<d[i-1]))throw Error('Choose three ascending durations, up to one hour.');alarm.policy={...copy(body),revision:body.revision+1};log(g,'Protection settings saved',alarm);}
    else if(path==='lockout/reset'){keypadSimulation(g,alarm,context).reset();log(g,'Lockout reset by administrator',alarm);}
    else if(path==='users/save'){
      if(body.pin!==undefined)validPin(body.pin);
      const existing=g.identities.find(u=>u.id===body.id);if(!existing&&body.id)throw Error('User is not on this gateway.');if(!existing&&!body.pin)throw Error('Enter a fictional PIN.');
      const old=alarm.users.find(u=>u.id===body.id);if(existing&&body.user_revision!==existing.user_revision||old&&old.revision!==body.revision)throw Error('Reload this demo user before saving.');
      const id=existing?.id||crypto.randomUUID().replaceAll('-','');
      const identity={id,name:body.name,enabled:body.enabled,user_revision:(existing?.user_revision||0)+1};
      // Explicit projection: PINs and repeat PINs can never enter persisted data.
      const grant={...identity,revision:(old?.revision||0)+1};
      for(const key of ['grant_enabled','owner','arm','disarm','all_keypads','keypads','remaining_uses','api_arm_disarm'])grant[key]=copy(body[key]);grant.schedule=body.preserve_schedule?copy(old.schedule):schedule(body.schedule);
      if(id===g.homebridge.user_id&&(!grant.enabled||g.homebridge.alarm_ids.includes(alarm.id)&&(!grant.grant_enabled||!grant.arm||!grant.disarm||!grant.api_arm_disarm||grant.remaining_uses!==null||grant.schedule)))throw Error('Keep unrestricted API access on included Homebridge alarms.');
      ownerGuard(g,alarm,grant);
      if(existing)Object.assign(existing,identity);else g.identities.push(identity);
      for(const a of g.alarms)for(const u of a.users)if(u.id===id)Object.assign(u,identity);
      if(old)Object.assign(old,grant);else alarm.users.push(grant);log(g,body.pin?'User and simulated PIN saved':'Access grant saved',alarm);
    }
    else if(path==='users/delete'){if(body.id===g.homebridge.user_id&&g.homebridge.alarm_ids.includes(alarm.id))throw Error('Switch Homebridge users before removing this grant.');const u=alarm.users.find(u=>u.id===body.id);if(!u)throw Error('Demo grant not found.');ownerGuard(g,alarm,u,true);alarm.users=alarm.users.filter(u=>u.id!==body.id);if(!g.alarms.some(a=>a.users.some(u=>u.id===body.id)))g.identities=g.identities.filter(u=>u.id!==body.id);log(g,'Alarm access removed',alarm);}
    else if(path==='homebridge')return copy(g.homebridge);
    else if(path==='users/rotate-pin'||path==='homebridge/configure'||path==='homebridge/pin-change'){
      const pin=body.pin??body.new_pin;validPin(pin);if(pin!==body.repeat_pin)throw Error('The PIN entries do not match.');
      const u=g.identities.find(u=>u.id===body.id);if(!u)throw Error('Demo user not found.');
      if(path==='homebridge/configure'||body.homebridge_selection){if(body.homebridge_selection&&body.homebridge_selection.expected_user_id!==g.homebridge.user_id)throw Error('Homebridge selection changed. Reload first.');const ids=body.homebridge_selection?.alarms||body.alarms||g.homebridge.alarm_ids;if(!ids?.length||g.homebridge.alarm_ids.some(id=>!ids.includes(id)))throw Error('Keep existing Homebridge alarm bindings.');for(const id of ids){const grant=g.alarms.find(a=>a.id===id)?.users.find(x=>x.id===u.id);if(!grant?.enabled||!grant.grant_enabled||!grant.arm||!grant.disarm||!grant.api_arm_disarm||grant.schedule||grant.remaining_uses!==null)throw Error('Homebridge needs unrestricted API access on each included alarm.');}g.homebridge={stage:'complete',user_id:u.id,alarm_ids:copy(ids),gateway_selection:true};}
      u.user_revision++;for(const a of g.alarms)for(const grant of a.users)if(grant.id===u.id)grant.user_revision=u.user_revision;
      log(g,'PIN change simulated',alarm);persist();return copy(g.homebridge);
    }
    else throw Error('This action is not available in demo mode. No request was sent.');
    persist();return {saved:true};
  }
  return Object.freeze({request,reset(){keypadSimulations.clear();state=seed();retentionDays=30;persist();}});
})();

