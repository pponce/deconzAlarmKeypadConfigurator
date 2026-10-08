'use strict';
// Bounded read-only event projection. No raw gateway events are logged.
const readline = require('node:readline');
const lines = readline.createInterface({input:process.stdin, crlfDelay:Infinity});
let started=false, update=null;
lines.on('line', input => {
  try {
    if(input.length>65536) throw Error();
    const cfg=JSON.parse(input);
    if(started) { update(cfg); return; }
    started=true;
    const url = new URL(cfg.url);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Error();
    const ws = new WebSocket(url);
    const start = Date.now(); let ready = false, scope = {};
    const alarmStates=new Map();
    let alarms=cfg.alarms;
    const valid = rows => rows && typeof rows==='object' && !Array.isArray(rows) &&
      Object.entries(rows).every(([id,pads]) => /^[1-9][0-9]{0,2}$/.test(id) && +id<=255 &&
        Array.isArray(pads) && pads.every(p=>typeof p==='string' && /^[0-9]+$/.test(p)));
    if(!valid(alarms))throw Error();
    update = next => {
      if(Object.keys(next).length!==1 || !valid(next.alarms))throw Error();
      for(const id of alarmStates.keys()) if(!Object.hasOwn(next.alarms,id))alarmStates.delete(id);
      alarms=next.alarms;
    };
    const states=['disarmed','armed_stay','armed_night','armed_away','exit_delay','entry_delay','not_ready','in_alarm','arming_stay','arming_night','arming_away'];
    const emit = row => process.stdout.write(JSON.stringify({...row,...scope}) + '\n');
    const timer = setTimeout(() => process.exit(1), 8000);
    ws.onopen = () => { clearTimeout(timer); ready = true; emit({type: 'ready'}); };
    ws.onmessage = ev => {
      try {
        if (!ready || typeof ev.data !== 'string' || ev.data.length > 1048576) return;
        const e = JSON.parse(ev.data);
        scope={};
        if (e.t !== 'event'||e.r!=='alarmsystems'||!Object.hasOwn(alarms,String(e.id))) return;
        scope.alarm=String(e.id);
        const alarmState=alarmStates.get(scope.alarm)??null;
        if(e.r==='alarmsystems' && Object.hasOwn(alarms,String(e.id)) && e.e==='changed' && states.includes(e.state?.armstate)) {
          // First observation establishes a baseline, never fabricates an action after a gap.
          if(alarmState!==null && alarmState!==e.state.armstate)
            emit({type:'alarm_state',state:e.state.armstate,timestamp:new Date().toISOString()});
          alarmStates.set(scope.alarm,e.state.armstate);
        }
        if(e.r==='alarmsystems' && Object.hasOwn(alarms,String(e.id)) && e.e==='alarm_command' && e.source==='rest') {
          const stamp=Date.parse(e.timestamp);
          if(!Number.isFinite(stamp)||stamp<start-1000||Math.abs(Date.now()-stamp)>10000)return;
          if(typeof e.event_id!=='string'||!/^[0-9a-f]{32}$/.test(e.event_id)||e.uses_consumed!==0)return;
          if(!['disarm','arm_stay','arm_night','arm_away'].includes(e.action)||!['accepted','rejected','failed'].includes(e.result))return;
          if(e.result!=='rejected' && (typeof e.user_id!=='string'||e.user_id.length>128))return;
          emit({type:'rest',key:e.event_id,action:e.action,result:e.result,
            ...(e.result==='rejected'?{}:{user:e.user_id}),timestamp:new Date(stamp).toISOString()});
          return;
        }
        if (e.e === 'access' && e.r === 'alarmsystems' && Object.hasOwn(alarms,String(e.id)) && alarms[String(e.id)].includes(String(e.sensor_id))) {
          scope.sensor=String(e.sensor_id);
          const stamp = Date.parse(e.timestamp);
          if (!Number.isFinite(stamp) || stamp < start - 1000 || Math.abs(Date.now() - stamp) > 10000) return;
          if (typeof e.event_id !== 'string' || !/^[0-9a-f]{32}$/.test(e.event_id)) return;
          if (e.result === 'rejected') {
            if (e.action !== 'invalid_code' || e.uses_consumed !== 0) return;
            const detail = {};
            if(e.lockout===true && Number.isInteger(e.lockout_level) && e.lockout_level>=1 && e.lockout_level<=3 &&
               Number.isSafeInteger(e.locked_until) && e.locked_until>stamp && e.locked_until-stamp<=3600000) {
              detail.level=e.lockout_level;
              detail.locked_until=e.locked_until;
              detail.remaining_seconds=Math.ceil((e.locked_until-stamp)/1000);
            }
            emit({type:'invalid', key:e.event_id, timestamp:new Date(stamp).toISOString(), locked:e.lockout===true, ...detail});
            return;
          }
          if (e.result !== undefined && e.result !== 'accepted') return;
          if (typeof e.user_id !== 'string' || e.user_id.length > 128) return;
          if (!['disarmed', 'already_disarmed', 'armed_stay', 'armed_away', 'armed_night'].includes(e.action)) return;
          if (![0, 1].includes(e.uses_consumed) || !(e.remaining_uses === null || Number.isSafeInteger(e.remaining_uses) && e.remaining_uses >= 0)) return;
          emit({type:'access', key:e.event_id, user:e.user_id, action:e.action, uses:e.uses_consumed, remaining:e.remaining_uses, timestamp:new Date(stamp).toISOString()});
        }
        // Legacy sensor state is mutable. Never count it as a rejected attempt.

      } catch (_) { /* Never print raw data or errors. */ }
    };
    ws.onerror = () => process.exit(1);
    ws.onclose = () => process.exit(0);

  } catch (_) { process.exit(1); }
});

lines.on('close',()=>process.exit(0));
