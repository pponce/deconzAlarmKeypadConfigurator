'use strict';
window.ConfiguratorHomebridgeReadiness = (code, check) => {
  const scopes = { configuration: 'Homebridge', plugin: 'homebridge-deconz', library: 'homebridge-lib' };
  const reasons = {
    missing: 'the required file is missing', unreadable: 'the Homebridge service cannot read this file',
    linked_path: 'the file path contains an unsupported symbolic link', not_regular: 'this is not a regular file',
    hard_link: 'the file has more than one hard link', writable_by_others: 'the file has write permissions outside the allowed policy (source files may be writable by the Homebridge service group; private configuration/cache files may not)',
    unexpected_owner: 'the file is owned by neither root nor the Homebridge service user',
    too_large: 'the file exceeds the supported size', read_failed: 'the file could not be read',
  };
  if (code === 'homebridge_file_unavailable' && scopes[check?.scope] && reasons[check?.reason] && typeof check.file === 'string') {
    return scopes[check.scope] + ' / ' + check.file + ': ' + reasons[check.reason] + '. PIN synchronization remains unavailable until this file passes the check.';
  }
  return ({
  homebridge_local_linux_required: 'Alarm PIN synchronization currently requires Homebridge on Linux.',
  one_homebridge_child_bridge_required: 'Configure one local deCONZ platform and one Homebridge UI in this Homebridge instance.',
  homebridge_child_identity_invalid: 'Run homebridge-deconz in its own child bridge.',
  homebridge_plugin_disabled: 'The homebridge-deconz plugin is disabled in this Homebridge instance.',
  homebridge_local_http_ui_required: 'This integration currently needs Homebridge UI to accept local HTTP connections. An HTTPS-only UI needs additional certificate support.',
  homebridge_source_changed_review_required: 'The installed deCONZ plugin or library does not match the reviewed package identity or source fingerprints. Changed source files require a compatibility review before PIN synchronization can run.',
  homebridge_sources_unavailable: 'The installed homebridge-deconz plugin or its library could not be located from this plugin.',
  homebridge_file_unavailable: 'A required Homebridge configuration or plugin file could not be read with the expected file permissions.',
  homebridge_configuration_unavailable: 'The local Homebridge configuration could not be inspected.',
  homebridge_cli_unavailable: 'The installed homebridge-deconz UI command could not be located or read. Check the plugin installation and its permissions.',
})[code] || 'Check the local deCONZ child bridge and Homebridge UI setup. PIN synchronization is unavailable until setup is ready.';
};
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
  async function run(action){if(working||!active)return;lock(true);try{await action();}catch(e){$('hb-flow-message').textContent=e.message||'The connection is unavailable. Check the saved update before continuing.';if(active?.submitted&&!$('hb-flow-actions').querySelector('[data-refresh]'))button('Refresh status',()=>refresh(),false).dataset.refresh='true';}finally{lock(false);active?.validate?.();}}
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
      if(row.status.deadline&&row.status.stage==='awaiting_still')text('p','Confirm before '+new Date(row.status.deadline*1000).toLocaleTimeString()+'. If this expires, the controller stops and keeps its review hold.');
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
  function homebridgeLogin(logsOnly=false){
    text('h3',logsOnly?'Authorize log clearing':'Authorize Homebridge maintenance');
    text('p',logsOnly?'Use a Homebridge UI administrator account to clear the logs after the PIN update succeeds. Your password is not saved.':'Use an administrator account from your Homebridge UI. This is separate from your web admin account. The password is used for this update and is not saved.');
    const fields={};
    for(const [name,label,type] of [['username','Homebridge username','text'],['password','Homebridge password','password'],['otp','Authentication code (if enabled)','text']]){
      const wrapper=text('label',label);wrapper.className='gp-field';const input=document.createElement('input');input.name='homebridge-'+name;input.type=type;input.autocomplete=name==='otp'?'one-time-code':name==='password'?'current-password':'username';input.maxLength=name==='otp'?6:name==='username'?256:1024;wrapper.append(input);fields[name]=input;
    }
    return ()=>{if(!fields.username.value.trim()||!fields.password.value)throw Error('Enter your Homebridge administrator username and password.');const value={username:fields.username.value.trim(),password:fields.password.value};if(fields.otp.value)value.otp=fields.otp.value;fields.password.value='';fields.otp.value='';return value;};
  }
  async function prepare(){
    const rows=await statuses();view('2 of 4 · Prepare','Prepare for the update');
    const native=deps.nativeHomebridge?.()===true;
    text('p',native?'The PIN will be updated through Homebridge deCONZ without restarting it. This web interface stays open on the same page. Homebridge saves the setting on its normal schedule; a crash or power loss before then could restore its previous PIN.':'Homebridge accessories will be temporarily unavailable. Complete the checks below, then start the update here.');
    const items=checks(rows.map(row=>({...row,spec:row.status.flow.preparation})));
    let login;
    if(native&&active.clearLogs===true)login=homebridgeLogin(true);
    const go=button(native?'Update PIN':'Start update',async()=>{
      // Capture explicit checked values before replacing the form with progress.
      const prepared=items.filter(row=>row.extension).map(row=>({...row,body:Object.fromEntries(row.inputs.map(x=>[x.name,x.input.checked]))}));
      if(prepared.some(row=>Object.values(row.body).some(v=>v!==true)))throw Error('Complete every preparation check first.');
      if(native){active.request.homebridge_confirmed=true;active.request.homebridge_clear_logs=active.clearLogs===true;if(login)active.request.homebridge_login=login();}
      active.validate=null;view('3 of 4 · Update','Updating Homebridge access');
      const progress=text('p','Checking preparation…');
      try{
        for(const row of prepared)await deps.extension(row.extension.id,row.spec.action,{gateway:active.context.gateway,...row.body});
      }catch(e){await prepare();throw e;}
      progress.textContent=native?'Updating and checking the PIN in deCONZ and Homebridge. Keep this page open…':'Pausing connected integrations, synchronizing the PIN and restarting Homebridge…';
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
    if(evidence.transaction_id!==active.id)throw Error('The saved operation changed. Close this window and reopen the pending update.');
    if(!evidence.ready){
      view('Update paused','A recovery check needs attention');
      text('p',login?'Homebridge sign-in succeeded. A recovery check is blocking completion; entering your password again will not resolve it.':'A recovery check is blocking completion.');
      const labels={saved_operation:'Saved Homebridge operation',gateway_state:'deCONZ user and alarm state',child_bridge_state:'deCONZ child bridge and saved PIN',homebridge_api:'Homebridge PIN API and saved value',private_backup:'Private PIN backup',child_bridge_stopped:'Stopped deCONZ child bridge',maintenance:'Garage controller maintenance',restore_service:'Restore deCONZ child bridge without changing the PIN'};
      const reasons={homebridge_snapshot_unverified:'The update stopped before its private PIN backup was confirmed.',homebridge_backup_changed:'The private backup does not match this update.',homebridge_cache_changed:'The saved Homebridge data differs from the expected backup.',homebridge_gateway_revision_changed:'The deCONZ settings differ from the saved update.',homebridge_login_required:'Homebridge authorization is no longer available.'};
      for(const item of evidence.diagnostics||[])text('p',(labels[item.check]||'Recovery verification')+': '+(reasons[item.reason]||'This check could not be verified.')+' ['+item.reason+']');
      if(!evidence.diagnostics?.length)text('p','The saved PIN outcome could not be independently verified.');
      text('p','The update remains pending. No PIN change was repeated. Share the check and reason above before retrying.');
      return;
    }
    let error;
    try{await deps.api('recovery/confirm',{transaction_id:evidence.transaction_id,token:evidence.token,reviewed:true},active.context);}catch(e){error=e;}
    await refresh(error);
  }
  async function refresh(previousError){
    if(previousError)active.saveError=previousError;
    previousError=active.saveError;
    active.validate=null;
    const [tx,rows]=await Promise.all([deps.api('transaction',undefined,active.context),statuses()]);
    if(active.submitted&&active.baselineCaptured&&(!tx.id||tx.id===active.baselineId)&&previousError?.code?.startsWith('maintenance_preflight_failed')){
      view('Update not started','Update did not start. No PIN was changed.');
      const parts=previousError.code.split(':');
      text('p','Preparation check: '+(parts[1]||'maintenance_preflight_failed')+(parts[2]?' ('+parts[2]+')':'')+'.');
      text('p','Close this window. Share the check above before trying again. There is no new pending update to cancel.');
      active.result={completed:false,pending:false};return;
    }
    if(active.submitted&&active.baselineCaptured&&(!tx.id||tx.id===active.baselineId)){
      view('Update status','The Homebridge update could not be confirmed');
      text('p',previousError?.message||'No new saved operation was found for this request. Its outcome has not been confirmed.');
      text('p','The saved status has not advanced beyond the operation recorded before you clicked Save. Checking again will not repeat the PIN change or restart.');
      button('Refresh status',()=>refresh(),false).dataset.refresh='true';return;
    }
    if(tx.id&&active.id&&tx.id!==active.id)throw Error('The saved operation changed. Close this flow and review the current update.');
    if(tx.id)active.id=tx.id;
    if(tx.stage==='complete'){
      if(tx.homebridge!==true)throw Error(previousError?.message||'The saved operation is not a Homebridge PIN update. No Homebridge result has been confirmed.');
      if(rows.some(row=>row.status.id===tx.id&&!['none','complete'].includes(row.status.stage)))throw Error('The saved update finished, but an integration still needs review. Its hold remains in place.');
      const applied=tx.outcome==='applied';
      view('4 of 4 · Finished',applied?'Homebridge access updated':'Update finished without applying the change');
      text('p',applied?(active.success||'Homebridge is synchronized and the required integration checks are complete.'):'The saved operation was resolved without applying the requested credential change.');
      if(applied&&tx.homebridge_method==='api')text('p','The running Homebridge PIN was verified. Homebridge will save it on its normal schedule.');
      if(applied&&tx.homebridge_logs==='cleared')text('p','The current Homebridge log was cleared.');
      else if(applied&&['pending','requested','failed'].includes(tx.homebridge_logs))text('p','PIN updated successfully, but Homebridge logs could not be confirmed cleared. You can clear them from Homebridge UI.');
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
    const notSent=tx.write_attempted===false;
    view('Update needs attention',notSent?'Cancel the unfinished PIN change':'Continue the saved Homebridge update');
    if(tx.failure){
      const participants={homebridge:'Homebridge deCONZ',coordinator:'Garage controller',controller:'Garage controller',gateway:'deCONZ gateway',backup:'Policy backup',integration:'Connected integration'};
      const steps={pause:'Pause',backup:'Save backup',revalidate:'Recheck settings',credential_evidence:'Prepare PIN verification',gateway_write:'Send gateway change',gateway_readback:'Verify gateway result',verify:'Verify saved state',resume:'Restore service and device readiness',complete:'Finish maintenance'};
      const kinds={coded_error:'Reported check failure',permission_denied:'File access denied',missing_file:'Required file missing',io_error:'Storage I/O failure',type_error:'Internal type error',unexpected_error:'Unexpected internal error'};
      text('p','Failed step: '+(participants[tx.failure.participant]||'Maintenance')+' — '+(steps[tx.failure.step]||'Check')+'.');
      text('p','Reason: '+tx.failure.reason+' ('+(kinds[tx.failure.kind]||'Unknown error')+').');
      if(tx.failure.reason==='homebridge_alarm_api_not_ready')text('p','Homebridge restarted, but its deCONZ device API did not become available within 30 seconds. Continue the saved update to check it again.');
      if(tx.failure.location)text('p','Diagnostic location: '+tx.failure.location.file+':'+tx.failure.location.line+':'+tx.failure.location.column+'.');
    }else if(tx.failure_reason)text('p','The update stopped at: '+tx.failure_reason+'.');
    if(notSent)text('p','The saved record confirms that no PIN write was attempted. Cancel this change to restore the deCONZ child bridge if it is stopped and finish the required checks.');
    else text('p',tx.verified?'The saved outcome is verified. Continue the remaining checks without repeating the PIN change.':'The outcome still needs verification. The controller may remain paused. The original PIN change will not be repeated.');
    if(matching.some(row=>row.status.flow.blocked))text('p','An integration requires local review. Its existing hold remains in place.');
    if(tx.write_attempted&&!tx.verified){
      const label=text('label','PIN submitted for this update');label.className='gp-field';const input=document.createElement('input');input.type='password';input.inputMode='numeric';input.autocomplete='off';input.maxLength=16;label.append(input);
      button('Verify submitted PIN',async()=>{let pin=input.value;input.value='';try{await deps.api('recovery/credential',{transaction_id:tx.id,pin},active.context);}finally{pin='';}await refresh();},false);
    }
    const login=deps.nativeHomebridge?.()===true&&(tx.homebridge_method!=='api'||tx.homebridge_logs==='pending')?homebridgeLogin(tx.homebridge_method==='api'):null;
    button(notSent?'Cancel PIN change and restore service':'Continue',()=>advance(login));
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
      text('p','Use this PIN for the selected alarms in deCONZ and Homebridge.');
      if(deps.nativeHomebridge?.()===true){
        text('p','Homebridge may record the PIN in its logs.');
        const label=text('label','');label.className='gp-check';const input=document.createElement('input');input.type='checkbox';input.name='homebridge-clear-logs';
        input.onchange=()=>{active.clearLogs=input.checked;};label.append(input,document.createTextNode('Clear Homebridge logs after this update'));
        text('p','Clears the entire current Homebridge log after the PIN update succeeds. Archived or downloaded copies are unaffected.');
      }
      button('Continue',async()=>{const tx=await deps.api('transaction',undefined,active.context);if(!['none','complete'].includes(tx.stage)){if(!tx.homebridge)throw Error('Another settings change needs recovery first.');wipe();active.submitted=true;active.id=tx.id;active.context.alarm=tx.alarm;await refresh();return;}active.baselineId=tx.id||null;active.baselineCaptured=true;await prepare();});
    }
    return result;
  }
  return {open,clear(){wipe();if(dialog.open){working=false;dialog.close();}},get isOpen(){return dialog.open;}};
};
