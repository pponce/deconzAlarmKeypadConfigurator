'use strict';
// Entry timing is local. Codes exist only in short-lived memory, never storage.
((root) => {
  class Entry {
    constructor({submit, change, now=()=>Date.now(), schedule=(fn,delay)=>setTimeout(fn,delay), cancel=id=>clearTimeout(id)}) {
      Object.assign(this,{submit,change,now,schedule,cancel});
      this.timer=null;this.clear();
    }
    clear() {
      this.cancel(this.timer);this.timer=null;this.buffer='';this.count=0;
      this.deadline=0;this.mode='disarm';this.change?.(this);
    }
    select(mode) {
      this.clear();this.mode=mode;this.change(this);
    }
    digit(digit) {
      if(!/^[0-9]$/.test(digit))return;
      if(this.deadline&&this.now()>=this.deadline)this.clear();
      this.cancel(this.timer);this.deadline=this.now()+5000;this.count++;
      if(this.count<=4)this.buffer+=digit;
      let code=this.count===4?this.buffer:this.count>4?digit:null;
      if(this.count>=4)this.buffer='';
      this.timer=this.schedule(()=>this.clear(),5000);this.change(this);
      if(code!==null){this.submit(code,this.mode);code='';}
    }
  }

  class Simulation {
    constructor(log, now=()=>Date.now()) {
      this.log=log;this.now=now;this.failures=[];this.level=0;this.until=0;
      this.lastFailure=0;this.target='disarmed';
      this.alarm='disarmed';this.alarmUntil=0;
    }
    tick() {
      const now=this.now();
      if(this.until&&now>=this.until){this.until=0;this.log('Lockout expired','Simulated deadline passed');}
      if(this.alarmUntil&&now>=this.alarmUntil){this.alarm=this.target;this.alarmUntil=0;this.log('Alarm '+this.alarm,'Simulated alarm state');}
    }
    reset() {this.failures=[];this.level=0;this.until=0;this.lastFailure=0;}
    send(code,mode,policy,timing) {
      this.tick();const now=this.now();let result;
      if(!policy.enabled)this.reset();
      if(policy.enabled&&this.until>now)result='locked';
      else if(code==='2323') {
        result='accepted';this.failures=[];
        this.target=({disarm:'disarmed',arm_stay:'armed_stay',arm_away:'armed_away',arm_night:'armed_night'})[mode];
        const delay=mode==='disarm'?0:(timing[this.target+'_exit_delay']||0)*1000;
        this.alarmUntil=delay?now+delay:0;this.alarm=delay?'arming_'+mode.slice(4):this.target;
      } else {
        result='rejected';
        if(policy.enabled) {
          if(now-this.lastFailure>=policy.reset_seconds*1000)this.level=0;
          this.failures=this.failures.filter(t=>now-t<policy.window_seconds*1000);
          this.failures.push(now);this.lastFailure=now;
          if(this.failures.length>=policy.threshold){
            this.level=Math.min(3,this.level+1);this.until=now+policy.durations_seconds[this.level-1]*1000;
            this.failures=[];
          }
        }
      }
      this.log(result==='accepted'?'Code accepted':result==='locked'?'Requests blocked during lockout':'Code rejected',
        mode.replaceAll('_',' ')+'; '+code.length+' digit(s); fictional request');
      if(result==='rejected'&&this.until>now)this.log('Lockout detected','Simulated level '+this.level+'; '+Math.ceil((this.until-now)/1000)+' seconds');
      return {result,mode};
    }
    snapshot(){this.tick();return {alarm:this.alarm,remaining_seconds:Math.max(0,Math.ceil((this.until-this.now())/1000)),level:this.level};}
  }
  const api={Entry,Simulation};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.BrowserKeypad=Object.freeze(api);
})(typeof window==='undefined'?globalThis:window);
