'use strict';
window.ConfiguratorHomebridgeReadiness = code => ({
  homebridge_not_configured: 'Homebridge PIN sync is optional. Set up the local integration using the standalone homebridge command; see Installation help.',
  homebridge_local_linux_required: 'Alarm PIN synchronization currently requires Homebridge on Linux.',
  one_homebridge_child_bridge_required: 'Configure one local deCONZ platform and one Homebridge UI in this Homebridge instance.',
  homebridge_child_identity_invalid: 'Run homebridge-deconz in its own child bridge.',
  homebridge_plugin_disabled: 'The homebridge-deconz plugin is disabled in this Homebridge instance.',
  homebridge_local_http_ui_required: 'This integration currently needs Homebridge UI to accept local HTTP connections. An HTTPS-only UI needs additional certificate support.',
  homebridge_source_changed_review_required: 'The installed deCONZ plugin or library differs from the reviewed versions (homebridge-deconz 1.3.5 and homebridge-lib 8.1.5). Compatibility must be checked before PIN synchronization can run.',
  homebridge_sources_unavailable: 'The installed homebridge-deconz plugin or its library could not be located at the configured package path.',
  homebridge_file_unavailable: 'A required Homebridge configuration or plugin file could not be read with the expected file permissions.',
  homebridge_configuration_unavailable: 'The local Homebridge configuration could not be inspected.',
})[code] || 'Check the local deCONZ child bridge and Homebridge UI setup. PIN synchronization is unavailable until setup is ready.';
// One user task, with declarative steps supplied by registered integrations.
// Credentials live only in the current request closure; recovery never resends it.
window.ConfiguratorHomebridgeFlow=deps=>{
  const dialog=document.createElement('dialog');dialog.className='gp-homebridge-flow';
  dialog.setAttribute('aria-labelledby','hb-flow-title');
  dialog.innerHTML='<header><div><p id="hb-flow-step" class="gp-sub"></p><h2 id="hb-flow-title" tabindex="-1">Update Homebridge access</h2></div><button type="button" class="gp-button" id="hb-flow-close">Cancel</button></header><div id="hb-flow-content"></div><p id="hb-flow-message" role="status"></p><footer id="hb-flow-actions"></footer>';
  document.getElementById('configurator-preview').append(dialog);
  const $=id=>dialog.querySelector('#'+id);
  let active=null,working=false,resolve=null;
  const wipe=()=>{if(active?.request){active.request.new_pin='';active.request.repeat_pin='';if(active.request.homebridge_login){active.request.homebridge_login.password='';active.request.homebridge_login.otp='';}active.request=null;}};
  const text=(tag,value,parent=$('hb-flow-content'))=>{const e=document.createElement(tag);e.textContent=value;parent.append(e);return e;};
  const button=(label,action,primary=true)=>{const e=text('button',label,$('hb-flow-actions'));e.type='button';e.className='gp-button'+(primary?' primary':'');e.onclick=()=>run(action);return e;};
  function view(step,title){$('hb-flow-step').textContent=step;$('hb-flow-title').textContent=title;$('hb-flow-content').replaceChildren();$('hb-flow-actions').replaceChildren();$('hb-flow-message').textContent='';$('hb-flow-close').textContent=active?.submitted?'Close':'Cancel';if(dialog.open)$('hb-flow-title').focus({preventScroll:true});}
  function lock(value){working=value;dialog.querySelectorAll('button,input').forEach(e=>e.disabled=value);}
  async function run(action){if(working||!active)return;lock(true);try{await action();}catch(e){$('hb-flow-message').textContent=e.message||'The connection is unavailable. Check the saved update before continuing.';if(active?.submitted&&!$('hb-flow-actions').querySelector('[data-refresh]'))button('Check saved update',()=>refresh(),false).dataset.refresh='true';}finally{lock(false);active?.validate?.();}}
  function close(){if(working)return;dialog.close();}
  $('hb-flow-close').onclick=close;
  dialog.addEventListener('cancel',e=>{if(working)e.preventDefault();});
  dialog.addEventListener('close',()=>{const result=active?.result||{completed:false,pending:Boolean(active?.submitted)};wipe();active=null;const done=resolve;resolve=null;done?.(result);});
  window.addEventListener('beforeunload',e=>{if(active?.submitted&&!active.result){e.preventDefault();e.returnValue='';}});
  function extensions(){return deps.extensions().filter(e=>e.maintenance);}
  async function statuses(){return Promise.all(extensions().map(async extension=>{
    const expected='/api/extensions/'+extension.id+'/maintenance';
    if(!/^[a-z][a-z0-9-]{0,26}$/.test(extension.id)||extension.maintenance!==expected)throw Error('Integration maintenance address is invalid.');
    const status=await deps.extension(extension.id,'maintenance');
    if(status.flow?.version!==1)throw Error(extension.name+' needs its existing maintenance instructions before this update can continue.');
    return {extension,status};
  }));}
  function checks(rows){
    const items=[];
    for(const row of rows){
      const spec=row.spec;
      if(!spec||!Array.isArray(spec.checks)||!spec.checks.length||spec.checks.length>12||!/^[a-z][a-z0-9-]{0,31}$/.test(spec.action))throw Error('Integration instructions are unavailable.');
      text('h3',spec.title);text('p',spec.message);
      if(row.status.deadline&&row.status.stage==='awaiting_still')text('p','Confirm before '+new Date(row.status.deadline*1000).toLocaleTimeString()+'. If this expires, the integration retains its review hold.');
      const inputs=[];
      for(const item of spec.checks){
        if(!/^[a-z][a-z0-9_]{0,31}$/.test(item.name)||['token','gateway'].includes(item.name))throw Error('Integration confirmation is invalid.');
        const label=document.createElement('label');label.className='gp-check';const input=document.createElement('input');input.type='checkbox';input.dataset.confirmation=item.name;label.append(input,document.createTextNode(item.label));$('hb-flow-content').append(label);inputs.push({input,name:item.name});
      }
      items.push({...row,inputs});
    }
    return items;
  }
  function requireChecks(items,action){
    active.validate=()=>{action.disabled=working||items.some(row=>row.inputs.some(x=>!x.input.checked));};
    for(const row of items)for(const {input} of row.inputs)input.onchange=active.validate;
    active.validate();
  }
  function homebridgeLogin(){
    text('h3','Authorize Homebridge maintenance');
    text('p','Use an administrator account from your Homebridge UI. This is separate from your web admin account. The password is used for this update and is not saved.');
    const fields={};
    for(const [name,label,type] of [['username','Homebridge username','text'],['password','Homebridge password','password'],['otp','Authentication code (if enabled)','text']]){
      const wrapper=text('label',label);wrapper.className='gp-field';const input=document.createElement('input');input.name='homebridge-'+name;input.type=type;input.autocomplete=name==='otp'?'one-time-code':name==='password'?'current-password':'username';input.maxLength=name==='otp'?6:name==='username'?256:1024;wrapper.append(input);fields[name]=input;
    }
    return ()=>{if(!fields.username.value.trim()||!fields.password.value)throw Error('Enter your Homebridge administrator username and password.');const value={username:fields.username.value.trim(),password:fields.password.value};if(fields.otp.value)value.otp=fields.otp.value;fields.password.value='';fields.otp.value='';return value;};
  }
  async function prepare(){
    const rows=await statuses();view('2 of 4 · Prepare','Prepare for the update');
    const native=deps.nativeHomebridge?.()===true;
    text('p',native?'The Homebridge deCONZ child bridge will stop while the PIN is updated, then restart. Its accessories will be temporarily unavailable. This web interface stays open on the same page.':'Homebridge accessories will be temporarily unavailable. Complete the checks below, then start the update here.');
    const items=checks(rows.map(row=>({...row,spec:row.status.flow.preparation})));
    let login,confirmation;
    if(native){login=homebridgeLogin();const label=text('label','');label.className='gp-check';confirmation=document.createElement('input');confirmation.type='checkbox';confirmation.name='homebridge-restart-confirmed';label.append(confirmation,document.createTextNode('I confirm the PIN change and the restart of Homebridge deCONZ.'));items.push({inputs:[{input:confirmation,name:'homebridge_confirmed'}]});}
    const go=button(native?'Save PIN and restart Homebridge deCONZ':'Start update',async()=>{
      // Capture explicit checked values before replacing the form with progress.
      const prepared=items.filter(row=>row.extension).map(row=>({...row,body:Object.fromEntries(row.inputs.map(x=>[x.name,x.input.checked]))}));
      if(prepared.some(row=>Object.values(row.body).some(v=>v!==true)))throw Error('Complete every preparation check first.');
      if(native){if(!confirmation.checked)throw Error('Confirm the restart before continuing.');active.request.homebridge_confirmed=true;active.request.homebridge_login=login();}
      active.validate=null;view('3 of 4 · Update','Updating Homebridge access');
      const progress=text('p','Checking preparation…');
      try{
        for(const row of prepared)await deps.extension(row.extension.id,row.spec.action,{gateway:active.context.gateway,...row.body});
      }catch(e){await prepare();throw e;}
      progress.textContent=native?'Updating the PIN and restarting the Homebridge deCONZ child bridge. Keep this page open…':'Pausing connected integrations, synchronizing the PIN and restarting Homebridge…';
      active.submitted=true;$('hb-flow-close').textContent='Close';
      let error;
      try{await deps.save(active.request,active.context);}catch(e){error=e;}finally{wipe();}
      await refresh(error);
    });
    requireChecks(items,go);
  }
  async function advance(login){
    if(login){let credentials=login();try{await deps.api('homebridge/authorize-recovery',{transaction_id:active.id,credentials},active.context);}finally{credentials.password='';credentials.otp='';}}
    const evidence=await deps.api('recovery/review',{},active.context);
    if(!evidence.ready||evidence.transaction_id!==active.id)throw Error('The saved update needs further verification. No change was repeated.');
    let error;
    try{await deps.api('recovery/confirm',{transaction_id:evidence.transaction_id,token:evidence.token,reviewed:true},active.context);}catch(e){error=e;}
    await refresh(error);
  }
  async function refresh(previousError){
    active.validate=null;
    const [tx,rows]=await Promise.all([deps.api('transaction',undefined,active.context),statuses()]);
    if(tx.id&&active.id&&tx.id!==active.id)throw Error('The saved operation changed. Close this flow and review the current update.');
    if(tx.id)active.id=tx.id;
    if(tx.stage==='complete'){
      if(tx.homebridge!==true)throw Error('This is not the selected Homebridge update.');
      if(rows.some(row=>row.status.id===tx.id&&!['none','complete'].includes(row.status.stage)))throw Error('The saved update finished, but an integration still needs review. Its hold remains in place.');
      const applied=tx.outcome==='applied';
      view('4 of 4 · Finished',applied?'Homebridge access updated':'Update finished without applying the change');
      text('p',applied?(active.success||'Homebridge is synchronized and the required integration checks are complete.'):'The saved operation was resolved without applying the requested credential change.');
      active.result={completed:applied,resolved:true};button('Done',()=>{lock(false);close();});return;
    }
    if(tx.stage==='none'){
      view('Update status','No saved Homebridge update was found');
      text('p',previousError?.message||'No pending operation is recorded. The PIN change will not be sent again by this flow.');
      button('Check status again',()=>refresh());return;
    }
    if(!tx.homebridge)throw Error('Another change is pending. Resolve that change before updating Homebridge.');
    active.submitted=true;active.context.alarm=tx.alarm;
    const matching=rows.filter(row=>row.status.id===tx.id&&row.status.gateway===active.context.gateway);
    const confirmations=matching.filter(row=>row.status.flow.confirmation);
    if(confirmations.length&&tx.verified){
      view('4 of 4 · Finish','Finish the Homebridge update');
      text('p',tx.outcome==='applied'?'The PIN change was verified. Complete the required checks below to finish.':'The credential change was not applied. Complete the checks below to finish restoring the connected integrations.');
      const items=checks(confirmations.map(row=>({...row,spec:row.status.flow.confirmation})));
      const next=button('Confirm and continue',async()=>{
        for(const row of items){
          if(row.inputs.some(x=>!x.input.checked))throw Error('Complete every confirmation first.');
          await deps.extension(row.extension.id,row.spec.action,{token:row.status.token,...Object.fromEntries(row.inputs.map(x=>[x.name,x.input.checked]))});
        }
        active.validate=null;view('4 of 4 · Finish','Checking the saved update');text('p','Verifying the completed step and resuming when ready…');await advance();
      });requireChecks(items,next);return;
    }
    view('Update needs attention','Continue the saved Homebridge update');
    text('p',tx.verified?'The saved outcome is verified. Continue the remaining checks without repeating the PIN change.':'The outcome still needs verification. Homebridge may remain stopped. The original PIN change will not be repeated.');
    if(matching.some(row=>row.status.flow.blocked))text('p','An integration requires local review. Its existing hold remains in place.');
    if(tx.write_attempted&&!tx.verified){
      const label=text('label','PIN submitted for this update');label.className='gp-field';const input=document.createElement('input');input.type='password';input.inputMode='numeric';input.autocomplete='off';input.maxLength=16;label.append(input);
      button('Verify submitted PIN',async()=>{let pin=input.value;input.value='';try{await deps.api('recovery/credential',{transaction_id:tx.id,pin},active.context);}finally{pin='';}await refresh();},false);
    }
    const login=deps.nativeHomebridge?.()===true?homebridgeLogin():null;
    button('Check saved update and continue',()=>advance(login));
    if(previousError&&previousError.code!=='transaction_recovery_required')$('hb-flow-message').textContent=previousError.message;
  }
  function open(options){
    if(active)throw Error('Finish the open Homebridge flow first.');
    active={...options,context:{...options.context},submitted:!options.request,id:options.transaction?.id};
    const result=new Promise(done=>resolve=done);dialog.showModal();
    if(!options.request){view('Continue','Loading the saved Homebridge update');run(()=>refresh());}
    else{
      view('1 of 4 · Review','Update Homebridge access');text('p',options.summary);
      const list=document.createElement('ul');for(const alarm of options.alarms)text('li',alarm,list);$('hb-flow-content').append(list);
      text('p','The PIN will be synchronized with deCONZ and Homebridge. A private policy snapshot is retained; remote gateway credentials need a backup by their administrator.');
      button('Continue to preparation',async()=>{const tx=await deps.api('transaction',undefined,active.context);if(!['none','complete'].includes(tx.stage))throw Error('Another update is pending. Close this flow and continue the saved update first.');await prepare();});
    }
    return result;
  }
  return {open,clear(){wipe();if(dialog.open){working=false;dialog.close();}},get isOpen(){return dialog.open;}};
};
