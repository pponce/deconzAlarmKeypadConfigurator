'use strict';
// One user task, with declarative steps supplied by registered integrations.
// Credentials live only in the current request closure; recovery never resends it.
window.ConfiguratorHomebridgeFlow=deps=>{
  const dialog=document.createElement('dialog');dialog.className='gp-homebridge-flow';
  dialog.setAttribute('aria-labelledby','hb-flow-title');
  dialog.innerHTML='<header><div><p id="hb-flow-step" class="gp-sub"></p><h2 id="hb-flow-title" tabindex="-1">Update Homebridge access</h2></div><button type="button" class="gp-button" id="hb-flow-close">Cancel</button></header><div id="hb-flow-content"></div><p id="hb-flow-message" role="status"></p><footer id="hb-flow-actions"></footer>';
  document.getElementById('configurator-preview').append(dialog);
  const $=id=>dialog.querySelector('#'+id);
  let active=null,working=false,resolve=null;
  const wipe=()=>{if(active?.request){active.request.new_pin='';active.request.repeat_pin='';active.request=null;}};
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
  async function prepare(){
    const rows=await statuses();view('2 of 4 · Prepare','Prepare for the update');
    text('p','Homebridge accessories will be temporarily unavailable. Complete the checks below, then start the update here.');
    const items=checks(rows.map(row=>({...row,spec:row.status.flow.preparation})));
    const go=button('Start update',async()=>{
      // Capture explicit checked values before replacing the form with progress.
      const prepared=items.map(row=>({...row,body:Object.fromEntries(row.inputs.map(x=>[x.name,x.input.checked]))}));
      if(prepared.some(row=>Object.values(row.body).some(v=>v!==true)))throw Error('Complete every preparation check first.');
      active.validate=null;view('3 of 4 · Update','Updating Homebridge access');
      const progress=text('p','Checking preparation…');
      try{
        for(const row of prepared)await deps.extension(row.extension.id,row.spec.action,{gateway:active.context.gateway,...row.body});
      }catch(e){await prepare();throw e;}
      progress.textContent='Pausing connected integrations, synchronizing the PIN and restarting Homebridge…';
      active.submitted=true;$('hb-flow-close').textContent='Close';
      let error;
      try{await deps.save(active.request,active.context);}catch(e){error=e;}finally{wipe();}
      await refresh(error);
    });
    requireChecks(items,go);
  }
  async function advance(){
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
    text('p',tx.verified?'The saved outcome is verified. Continue the remaining checks without repeating the PIN change.':'The outcome still needs verification. The controller may remain paused. The original PIN change will not be repeated.');
    if(matching.some(row=>row.status.flow.blocked))text('p','An integration requires local review. Its existing hold remains in place.');
    if(tx.write_attempted&&!tx.verified){
      const label=text('label','PIN submitted for this update');label.className='gp-field';const input=document.createElement('input');input.type='password';input.inputMode='numeric';input.autocomplete='off';input.maxLength=16;label.append(input);
      button('Verify submitted PIN',async()=>{let pin=input.value;input.value='';try{await deps.api('recovery/credential',{transaction_id:tx.id,pin},active.context);}finally{pin='';}await refresh();},false);
    }
    button('Check saved update and continue',advance);
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
