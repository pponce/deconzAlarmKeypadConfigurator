const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const freshId = prefix => prefix + '-' + Array.from(crypto.getRandomValues(new Uint8Array(4)), byte=>byte.toString(16).padStart(2,'0')).join('');
export function newGarage() {
  const id = freshId('garage');
  return { id, name: 'My garage', exposeBoltLock: true, autoBolt: true,
    door: { type:'tailwind', baseUrl:'', doorIndex:0, credentialRef:'garage-tailwind' },
    bolt: { type:'deconz', baseUrl:'', gatewayId:'', resourceId:'', uniqueId:'', resourceType:'On/Off output', modelId:'', manufacturer:'', credentialRef:'garage-deconz', lockedValue:true },
    feedback: { closing:'sensor', opening:'timed', bolt:'relay', openingSeconds:20, closingSeconds:20, closedStableSeconds:2, boltSettleSeconds:2, allowEstimatedBolting:false },
    timing: { operationPollSeconds:.5, idlePollSeconds:2, openRetractSettleSeconds:2, closeRetractSettleSeconds:2, boltTimeoutSeconds:10, motionTimeoutSeconds:45, interruptedOpenMarginSeconds:1 },
    motorPaths:[], inputs:[], keypad:null };
}
export class ProfileEditor {
  constructor(root, { configuration, credentials = [], discover, discoverHomebridge, changed = () => {}, error = () => {} }) {
    this.root=root; this.configuration=structuredClone(configuration); this.credentials=credentials; this.discover=discover; this.discoverHomebridge=discoverHomebridge; this.changed=changed; this.error=error;
    this.selected=0; this.step=0; this.render();
  }
  change() { this.changed(this.configuration); }
  button(text, action, cls='secondary') { const b=el('button',text,cls);b.type='button';b.addEventListener('click',action);return b; }
  input(grid, label, obj, key, { type='text', help, min, max, step, options, rerender=false }={}) {
    const wrap=el('label',label); const field=el(options?'select':'input'); field.dataset.field=key;
    if(options) for(const [value,label,disabled] of options){ const o=el('option',label);o.value=String(value);o.disabled=!!disabled;field.append(o); }
    else { field.type=type; if(min!==undefined)field.min=min;if(max!==undefined)field.max=max;if(step!==undefined)field.step=step; }
    if(type==='checkbox'){wrap.className='check';field.checked=!!obj[key];wrap.prepend(field);}
    else {field.value=obj[key]??'';wrap.append(field);}
    if(help)wrap.append(el('span',help,'help'));
    field.addEventListener('change',()=>{obj[key]=type==='checkbox'?field.checked:type==='number'?Number(field.value):field.value;this.change();if(rerender)this.render();});
    grid.append(wrap);return field;
  }
  grid(parent){const g=el('div',undefined,'field-grid');parent.append(g);return g;}
  panel(parent,title,subtitle){const p=el('section',undefined,'device-block');p.append(el('h3',title));if(subtitle)p.append(el('p',subtitle,'subtle small'));parent.append(p);return p;}
  credential(grid,connection){const input=this.input(grid,'Saved connection key',connection,'credentialRef',{help:'Use the connection name you saved below. The key itself stays private.'});if(this.credentials.length){const list=el('datalist');list.id=freshId('keys');for(const key of this.credentials)list.append(Object.assign(el('option'),{value:key}));input.setAttribute('list',list.id);grid.append(list);}}
  connection(parent, obj, key, kind) {
    const current=obj[key];const types=kind==='garage'?[['tailwind','Tailwind local API'],['homebridge','Existing Homebridge garage']]:[['deconz','deCONZ directly'],['homebridge','Existing Homebridge device']];
    const choice=this.input(this.grid(parent),'Connection',current,'type',{options:types});
    choice.addEventListener('change',()=>{
      obj[key]={type:current.type,baseUrl:'',credentialRef:'garage-'+current.type,...(kind==='garage'&&current.type==='tailwind'?{doorIndex:0}:{}),
        ...(kind==='bolt'?{lockedValue:true,...(current.type==='homebridge'?{serviceType:'switch'}:{})}:{}),...(kind==='motor'?{activeValue:true}:{}),
        ...(['button','keypad','switch'].includes(kind)?{kind:current.type==='homebridge'&&kind==='keypad'?'button':kind}: {})};
      this.change();this.render();
    });
  }
  bridgeDevice(parent,connection,kind){
    const grid=this.grid(parent);this.input(grid,'Homebridge accessory port',connection,'baseUrl',{help:'http://host:port for the bridge or child bridge that owns this device. This is not the Homebridge web UI port.'});this.credential(grid,connection);
    parent.append(el('p','Save this bridge’s pairing PIN as a private connection key. The selected Homebridge must allow unpaired accessory control (insecure mode). Native HomeKit accessories are not supported.','help'));
    const output=el('div',undefined,'discovery-results');parent.append(this.button('Find Homebridge devices',async()=>{
      if(!this.discoverHomebridge)return this.error('Discover Homebridge devices in the Homebridge plugin settings.');
      try {output.textContent='Finding devices…';const data=await this.discoverHomebridge({baseUrl:connection.baseUrl,credentialRef:connection.credentialRef});
        const allowed=kind==='garage'?['garage']:kind==='bolt'?['lock','switch','light']:kind==='motor'?['switch','light']:['button','switch'];
        const rows=data.services.filter(x=>allowed.includes(x.kind));const pick=el('select');pick.setAttribute('aria-label','Discovered Homebridge '+kind);pick.append(Object.assign(el('option','Choose a device'),{value:''}));
        rows.forEach((row,i)=>pick.append(Object.assign(el('option',row.name+' · '+row.kind),{value:String(i)})));
        pick.addEventListener('change',()=>{if(pick.value==='')return;const row=rows[Number(pick.value)];Object.assign(connection,{bridgeId:row.bridgeId,serviceId:row.serviceId,accessoryIdentity:row.accessoryIdentity});
          if(kind==='bolt'){connection.serviceType=row.kind;if(row.kind==='lock')delete connection.lockedValue;else connection.lockedValue??=true;}
          if(['button','keypad','switch'].includes(kind)){connection.kind=row.kind;const input=this.configuration.controllers.flatMap(p=>p.inputs??[]).find(i=>i.source===connection);if(input)input.trigger=row.kind==='switch'?'on':0;}
          this.change();this.render();});output.replaceChildren(pick);if(!rows.length)output.textContent='No compatible services found on this bridge.';
      }catch{output.textContent='Could not read this bridge. Check its accessory port, saved PIN and insecure-mode setting.';}
    }));parent.append(output);
    if(connection.serviceId)parent.append(el('p','Selected service '+connection.serviceId+' · '+connection.bridgeId,'route-note'));
    const details=el('details');details.append(el('summary','Pinned device identity'));const g=this.grid(details);for(const [key,label]of [['bridgeId','Bridge identity'],['serviceId','Accessory / service ID'],['accessoryIdentity','Accessory identity fingerprint']])this.input(g,label,connection,key);parent.append(details);
  }
  device(parent,connection,kind){
    if(connection.type==='homebridge')return this.bridgeDevice(parent,connection,kind);
    const grid=this.grid(parent);this.input(grid,'deCONZ address',connection,'baseUrl',{help:'For example http://192.168.1.20:80'});this.credential(grid,connection);
    const output=el('p','Choose a device to pin its identity.','help');
    parent.append(this.button('Find devices',async()=>{
      if(!this.discover)return this.error('Use Homebridge settings to discover and connect devices.');
      try{
        output.textContent='Finding devices…';const data=await this.discover({baseUrl:connection.baseUrl,credentialRef:connection.credentialRef});
        connection.gatewayId=data.gatewayId;
        const rows=kind==='bolt'||kind==='motor'?data.lights:data.sensors.filter(row=>kind==='keypad'?row.resourceType==='ZHAAncillaryControl':row.resourceType!=='ZHAAncillaryControl');
        const pick=el('select');pick.setAttribute('aria-label','Discovered '+kind);pick.append(Object.assign(el('option','Choose a '+kind),{value:''}));
        rows.forEach((row,index)=>pick.append(Object.assign(el('option',row.name+' · '+row.modelId),{value:String(index)})));
        pick.addEventListener('change',()=>{if(pick.value==='')return;const {name,...identity}=rows[Number(pick.value)];Object.assign(connection,identity);this.change();this.render();});
        output.replaceChildren(pick);if(!rows.length)output.textContent='No compatible devices found on this gateway.';
      }catch{output.textContent='Could not read devices. Check the address and saved connection key.';}
    }));parent.append(output);
    if(connection.resourceId)parent.append(el('p','Selected: '+(connection.modelId||'Device')+' · resource '+connection.resourceId,'route-note'));
    const detail=el('details');detail.append(el('summary','Device identity and manual connection'));const fields=this.grid(detail);
    for(const [key,label] of [['gatewayId','Gateway identity'],['resourceId','Resource number'],['uniqueId','Endpoint identity'],['resourceType','Resource type'],['modelId','Model'],['manufacturer','Manufacturer']])this.input(fields,label,connection,key);
    parent.append(detail);
  }
  render(){
    this.root.replaceChildren();const list=el('div',undefined,'garage-list');
    this.configuration.controllers.forEach((p,index)=>{const b=this.button('',()=>{this.selected=index;this.render();},'garage-card');b.setAttribute('aria-pressed',String(index===this.selected));b.append(el('strong',p.name),el('span',(p.inputs?.length??0)+' physical controls · '+(p.exposeBoltLock?'Garage + lock tiles':'Garage tile')));list.append(b);});
    list.append(this.button('Add a garage',()=>{this.configuration.controllers.push(newGarage());this.selected=this.configuration.controllers.length-1;this.change();this.render();},'add-garage'));this.root.append(list);
    const p=this.configuration.controllers[this.selected];if(!p){const empty=el('section',undefined,'panel empty');empty.append(el('h2','Start with one garage'),el('p','Add the opener and the separate bolt you want to coordinate.','subtle'));this.root.append(empty);return;}
    p.motorPaths??=[];p.inputs??=[];p.timing??={};
    const steps=el('nav',undefined,'steps');steps.setAttribute('aria-label','Garage setup');['Devices','Inputs','Behavior'].forEach((name,index)=>{const b=this.button(String(index+1).padStart(2,'0')+'  '+name,()=>{this.step=index;this.render();});if(index===this.step)b.setAttribute('aria-current','step');steps.append(b);});this.root.append(steps);
    const content=el('div',undefined,'step-content');this.root.append(content);
    if(this.step===0)this.devices(content,p);else if(this.step===1)this.inputs(content,p);else this.behavior(content,p);
  }
  devices(root,p){
    const identity=this.panel(root,'Garage details');const grid=this.grid(identity);this.input(grid,'Garage name',p,'name');identity.append(el('p','Controller ID: '+p.id+' · Use this to link the standalone administrator.','help'));this.input(grid,'Show a separate bolt Lock tile',p,'exposeBoltLock',{type:'checkbox'});
    const opener=this.panel(root,'Garage opener','HomeKit and the virtual keypad use this connection.');const dg=this.grid(opener);
    this.connection(opener,p,'door','garage');
    if(p.door.type==='homebridge')this.bridgeDevice(opener,p.door,'garage');else {
      this.input(dg,'Tailwind address',p.door,'baseUrl',{help:'Local network address, for example http://192.168.1.30'});this.input(dg,'Door',p.door,'doorIndex',{type:'number',min:0,max:2,step:1,help:'0 is door 1; 1 is door 2; 2 is door 3.'});this.credential(dg,p.door);
      const link=el('a','How to get a Tailwind local control key');link.href='https://gotailwind.zendesk.com/hc/en-us/articles/42573968819725-How-do-I-get-my-local-control-key-for-my-Tailwind-garage-door-controller';link.target='_blank';link.rel='noreferrer';opener.append(link);
    }
    const bolt=this.panel(root,'Separate bolt / lock','This is the output that retracts and extends the bolt.');this.connection(bolt,p,'bolt','bolt');this.device(bolt,p.bolt,'bolt');if(p.bolt.serviceType!=='lock')this.input(this.grid(bolt),'Relay ON means bolt extended',p.bolt,'lockedValue',{type:'checkbox',help:'Choose the mapping that matches your wiring. A relay report does not prove physical bolt position.'});
    root.append(this.button('Remove this garage',()=>{if(!confirm('Remove '+p.name+' from the pending configuration?'))return;this.configuration.controllers.splice(this.selected,1);this.selected=Math.max(0,this.selected-1);this.change();this.render();},'danger'));
  }
  inputs(root,p){
    root.append(el('div','HomeKit + virtual keypad → '+(p.door.type==='tailwind'?'Tailwind API':'primary Homebridge opener'),'route-note'));
    const paths=this.panel(root,'Additional motor path','Optional: a relay that pulses the opener, separate from the bolt output.');
    p.motorPaths.forEach((path,index)=>{
      const card=this.panel(paths,path.name);const g=this.grid(card);this.input(g,'Path name',path,'name');this.connection(card,path,'connection','motor');this.device(card,path.connection,'motor');this.input(this.grid(card),'Relay ON activates the opener',path.connection,'activeValue',{type:'checkbox'});if(path.connection.type==='homebridge')this.input(this.grid(card),'I verified OFF always releases this output, including repeated OFF commands',path.connection,'inactiveWriteIdempotent',{type:'checkbox',help:'A toggle-only switch cannot be used as the motor relay.'});
      const times=this.grid(card);for(const [k,l] of [['openPulseSeconds','Opening pulse (seconds)'],['closePulseSeconds','Closing pulse (seconds)']])this.input(times,l,path,k,{type:'number',min:.1,max:2,step:.1});
      this.input(times,'Button interruption support',path,'interruption',{options:[['disabled','No stop / reverse'],['stop-opening-reverse-closing','Stop opening / reverse closing']],help:'Enable only for a relay and opener verified to support this sequence.'});
      card.append(this.button('Remove motor path',()=>{p.motorPaths.splice(index,1);this.change();this.render();},'danger'));
    });
    paths.append(this.button('Add motor relay',()=>{p.motorPaths.push({id:freshId('motor'),name:'Opener relay',type:'pulse-relay',connection:{type:'deconz',baseUrl:p.bolt.type==='deconz'?p.bolt.baseUrl:'',credentialRef:p.bolt.type==='deconz'?p.bolt.credentialRef:'garage-deconz',activeValue:true},openPulseSeconds:1,closePulseSeconds:1,interruption:'disabled'});delete p.motorPaths.at(-1).connection.lockedValue;p.motorPaths.at(-1).connection.resourceId='';p.motorPaths.at(-1).connection.uniqueId='';this.change();this.render();}));
    const inputs=this.panel(root,'Physical controls','Assign a live button press or keypad outcome to this garage and a motor path.');
    p.inputs.forEach((input,index)=>{
      const card=this.panel(inputs,input.name);card.classList.add('input-profile');const g=this.grid(card);
      this.input(g,'Control name',input,'name');this.input(g,'Use this control',input,'enabled',{type:'checkbox'});
      this.connection(card,input,'source',input.source.kind);
      if(input.source.type==='deconz')this.input(g,'Input type',input.source,'kind',{options:[['button','deCONZ button'],['keypad','Physical deCONZ keypad']],rerender:true});
      if(input.source.kind==='keypad'){input.action='keypad';input.trigger='native-outcome';input.source.alarmId??=1;}
      else {delete input.source.alarmId;if(input.action==='keypad')input.action='toggle';if(input.trigger==='native-outcome'||input.source.type==='homebridge'&&input.source.kind==='button'&&input.trigger>2)input.trigger=input.source.type==='homebridge'?0:1002;if(input.source.kind==='switch'&&typeof input.trigger!=='string')input.trigger='on';}
      this.device(card,input.source,input.source.kind);const actions=this.grid(card);
      if(input.source.kind==='keypad')this.input(actions,'Alarm system number',input.source,'alarmId',{type:'number',min:1,max:255,step:1});
      else {if(input.source.kind==='switch')this.input(actions,'Switch transition',input,'trigger',{options:[['on','Turns on'],['off','Turns off'],['either','Either transition']]});else this.input(actions,'Button event',input,'trigger',{type:'number',min:0,max:input.source.type==='homebridge'?2:65535,step:1,help:input.source.type==='homebridge'?'0: single press, 1: double press, 2: long press.':'For example, 1002 is the usual single press on many deCONZ buttons.'});this.input(actions,'Action',input,'action',{options:[['toggle','Open / close toggle'],['open','Open'],['close','Close']]});}
      this.input(actions,'Motor path',input,'motorPath',{options:[['primary','Primary opener'],...p.motorPaths.map(path=>[path.id,path.name])]});
      this.input(actions,'During movement',input,'busyBehavior',{options:[['drop','Ignore new presses'],['interrupt','Stop / reverse this control’s operation',p.motorPaths.find(path=>path.id===input.motorPath)?.interruption!=='stop-opening-reverse-closing']],help:input.source.kind==='keypad'?'Optional relay policy: only a correct PIN opens from closed; either PIN outcome stops opening, reverses closing, or closes from open or a partial stop. Applies only to this keypad’s operation.':'Stop / reverse also requires a compatible configured motor path.'});
      this.input(actions,'Rearm delay (seconds)',input,'rearmSeconds',{type:'number',min:0,max:10,step:.1});
      const advanced=el('details');advanced.append(el('summary','Timing for this control'));const tg=this.grid(advanced);input.timing??={};
      for(const [key,label] of [['openRetractSettleSeconds','Retract before opening'],['closeRetractSettleSeconds','Retract before closing'],['openingSeconds','Estimated opening travel'],['closingSeconds','Estimated closing travel']]){
        const field=this.input(tg,label+' (seconds)',input.timing,key,{type:'number',min:key.includes('Retract')?0:1,max:300,step:.1,help:'Leave blank to use the garage default.'});field.addEventListener('change',()=>{if(field.value===''){delete input.timing[key];this.change();}});
      }card.append(advanced);card.append(this.button('Remove control',()=>{p.inputs.splice(index,1);this.change();this.render();},'danger'));
    });
    inputs.append(this.button('Add a button or keypad',()=>{p.inputs.push({id:freshId('input'),name:'Indoor button',enabled:true,source:{type:'deconz',kind:'button',baseUrl:p.bolt.baseUrl,gatewayId:p.bolt.gatewayId,resourceId:'',uniqueId:'',resourceType:'ZHASwitch',modelId:'',manufacturer:'',credentialRef:p.bolt.credentialRef},trigger:1002,action:'toggle',motorPath:p.motorPaths[0]?.id??'primary',busyBehavior:'drop',rearmSeconds:1.5,timing:{}});this.change();this.render();}));
    const virtual=this.panel(root,'Virtual keypad','Keep deCONZ authorization and the Tailwind motor route.');
    virtual.append(this.button(p.keypad?'Use first physical keypad’s alarm':'Link virtual keypad to physical keypad',()=>{const key=p.inputs.find(i=>i.source.kind==='keypad')?.source;if(!key)return this.error('Add a physical keypad first, then link its alarm.');p.keypad={baseUrl:key.baseUrl,gatewayId:key.gatewayId,alarmId:key.alarmId,credentialRef:key.credentialRef};this.change();this.render();}));
    virtual.append(this.button('Set an alarm directly',()=>{p.keypad={baseUrl:p.bolt.type==='deconz'?p.bolt.baseUrl:'',gatewayId:p.bolt.type==='deconz'?p.bolt.gatewayId:'',credentialRef:p.bolt.type==='deconz'?p.bolt.credentialRef:'garage-deconz',alarmId:1};this.change();this.render();}));
    if(p.keypad){const g=this.grid(virtual);this.input(g,'deCONZ address',p.keypad,'baseUrl');this.input(g,'Gateway identity',p.keypad,'gatewayId');this.credential(g,p.keypad);this.input(g,'Alarm number',p.keypad,'alarmId',{type:'number',min:1,max:255,step:1});virtual.append(this.button('Unlink virtual keypad',()=>{p.keypad=null;this.change();this.render();}));}
  }
  behavior(root,p){
    const feedback=this.panel(root,'What does your hardware actually report?','The coordinator uses this to decide when it may move or bolt the door.');const g=this.grid(feedback);
    this.input(g,'Closed means…',p.feedback,'closing',{options:[['sensor','A door sensor confirms closed'],['timed','A command / estimate only']],help:'Tailwind provides a closed sensor. Use that feedback for your installation.',rerender:true});
    this.input(g,'Open means…',p.feedback,'opening',{options:[['timed','Not closed; estimate full travel'],['sensor','A sensor confirms fully open']],help:'Tailwind reports not-closed. Full opening travel is estimated.'});
    this.input(g,'Bolt feedback',p.feedback,'bolt',{options:[['relay','Relay ON / OFF state'],['position','Physical position sensor']],help:'The direct deCONZ relay uses relay state.'});
    if(p.feedback.closing==='timed')this.input(g,'Allow bolting after estimated closure',p.feedback,'allowEstimatedBolting',{type:'checkbox',help:'Elapsed time cannot prove the door closed. This policy requires explicit acceptance.'});else p.feedback.allowEstimatedBolting=false;
    const travel=this.panel(root,'Movement timing');const tg=this.grid(travel);
    for(const [key,label,help] of [['openingSeconds','Full opening travel','Starts after the closed sensor departs.'],['closingSeconds','Full closing travel','Used when closure is estimated.'],['closedStableSeconds','Stable closed confirmation','How long the closed sensor must remain active before bolting.'],['boltSettleSeconds','Bolt extension settling','Time to allow the mechanism to finish extending.']])this.input(tg,label+' (seconds)',p.feedback,key,{type:'number',min:key.includes('Seconds')&&['openingSeconds','closingSeconds'].includes(key)?1:0,max:300,step:.1,help});
    const settling=this.panel(root,'Bolt retraction');const sg=this.grid(settling);
    this.input(sg,'Before opening (seconds)',p.timing,'openRetractSettleSeconds',{type:'number',min:0,max:120,step:.1});this.input(sg,'Before closing (seconds)',p.timing,'closeRetractSettleSeconds',{type:'number',min:0,max:120,step:.1});
    this.input(sg,'Automatically bolt a newly closed door',p,'autoBolt',{type:'checkbox',help:'An external unlock remains in effect until the next operation or restart.'});
    const advanced=el('details');advanced.append(el('summary','Polling and timeouts'));const ag=this.grid(advanced);
    for(const [key,label,min,max] of [['operationPollSeconds','Operation poll',.1,5],['idlePollSeconds','Idle poll',.5,30],['boltTimeoutSeconds','Bolt timeout',1,120],['motionTimeoutSeconds','Movement timeout',5,300],['interruptedOpenMarginSeconds','Extra travel after reversal',0,30]])this.input(ag,label+' (seconds)',p.timing,key,{type:'number',min,max,step:.1});root.append(advanced);
  }
}
