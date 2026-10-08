'use strict';
(() => {
  const dialog=document.getElementById('installation-settings');
  const $=s=>dialog.querySelector(s);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let request,signOut,onSaved,data,accounts,principal,generation=0,busy=false,dirty=false;
  const dirtyForms=new Set();
  function clearSecrets(){dialog.querySelectorAll('input[type="password"]').forEach(i=>i.value='');}
  function message(text,error=false){$('#settings-message').textContent=text;$('#settings-message').classList.toggle('gp-error',error);}
  function close(force=false){if(busy&&!force)return;if(dirty&&!force&&!confirm('Discard unsaved settings changes?'))return;generation++;clearSecrets();dirty=false;if(dialog.open)dialog.close();}
  $('#settings-close').onclick=()=>close();
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('input',event=>{dirtyForms.add(event.target.closest('form'));dirty=true;});
  dialog.querySelectorAll('[data-settings-tab]').forEach(button=>button.onclick=()=>{
    dialog.querySelectorAll('[data-settings-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));
    dialog.querySelectorAll('[data-settings-panel]').forEach(p=>p.hidden=p.dataset.settingsPanel!==button.dataset.settingsTab);
    clearSecrets();
  });
  const tabs=[...dialog.querySelectorAll('[data-settings-tab]')];
  tabs.forEach((tab,index)=>tab.addEventListener('keydown',event=>{let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();if(tabs[next].hidden)return;tabs[next].click();tabs[next].focus();}));
  function facts(rows){return '<dl class="gp-settings-facts">'+rows.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')+'</dl>';}
  function renderAccounts(){
    $('#settings-account-name').textContent=principal.username?principal.username+' · '+(principal.role==='admin'?'Administrator':'Regular user'):'Choose a username for your existing administrator login.';
    const box=$('#settings-account-management');box.replaceChildren();
    if(principal.role!=='admin')return;
    const current='<label class="gp-field">Confirm with your administrator password<input name="current_password" type="password" autocomplete="current-password" required maxlength="256"></label>';
    const name='<label class="gp-field">Username<input name="username" autocomplete="off" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"><span class="gp-sub">Letters, numbers, dots, underscores and hyphens. Usernames are not case-sensitive.</span></label>';
    if(!accounts.accounts.length){
      box.innerHTML='<form id="settings-claim" class="gp-panel gp-body"><h4>Name your administrator account</h4><p>Your current password stays the same. This does not rerun installation or change gateway users.</p>'+name+current+'<button class="gp-button primary">Save admin username</button></form>';
      $('#settings-claim').onsubmit=e=>{e.preventDefault();accountChange({action:'claim',username:e.target.elements.username.value,current_password:e.target.elements.current_password.value});};return;
    }
    box.innerHTML='<h4>Web accounts</h4><p class="gp-sub">These accounts sign in to this interface; they are separate from alarm users and PINs. Regular users manage ordinary alarm users and access grants, and reset keypad lockouts. Protected owners remain read-only.</p><div id="settings-account-list"></div><button type="button" id="settings-add-account" class="gp-button">Add web account</button><form id="settings-account-editor" class="gp-panel gp-body" hidden><h4 id="settings-account-heading"></h4>'+name+'<div class="gp-two"><label class="gp-field">Role<select name="role"><option value="regular">Regular</option><option value="admin">Admin</option></select></label><label class="gp-check"><input name="enabled" type="checkbox" checked>Account enabled</label></div><label class="gp-check" id="settings-reset-password-option"><input id="settings-reset-password" type="checkbox">Set a new password for this account</label><div class="gp-two" id="settings-account-passwords"><label class="gp-field">Password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="256"></label><label class="gp-field">Repeat password<input name="repeat_password" type="password" autocomplete="new-password" minlength="8" maxlength="256"></label></div><p class="gp-sub" id="settings-account-password-help"></p>'+current+'<p class="gp-sub">Confirm this change using the password you use to sign in. Keep at least one enabled admin. Changing an account signs out that account; other accounts stay signed in.</p><div class="gp-actions"><button class="gp-button primary">Save account</button><button class="gp-button" type="button" id="settings-delete-account">Delete account</button><button class="gp-button" type="button" id="settings-cancel-account">Cancel</button></div></form>';
    $('#settings-account-list').innerHTML=accounts.accounts.map((r,i)=>`<article class="gp-panel gp-body"><div class="gp-actions"><strong>${esc(r.username)}</strong><span class="gp-pill">${r.role==='admin'?'Admin':'Regular'} · ${r.enabled?'Enabled':'Disabled'}</span><button class="gp-button" type="button" data-web-account="${i}">Edit</button></div></article>`).join('');
    const form=$('#settings-account-editor');let selected=null;
    function edit(row){if(dirtyForms.has(form)&&!confirm('Discard unsaved account edits?'))return;clearSecrets();selected=row;form.hidden=false;form.elements.username.value=row?.username||'';form.elements.role.value=row?.role||'regular';form.elements.enabled.checked=row?.enabled??true;$('#settings-reset-password-option').hidden=!row;$('#settings-reset-password').checked=!row;passwordFields();$('#settings-delete-account').hidden=!row;$('#settings-account-heading').textContent=row?'Edit '+row.username:'New web account';form.elements.username.focus();}
    function passwordFields(){const reset=!selected||$('#settings-reset-password').checked;$('#settings-account-passwords').hidden=!reset;for(const name of ['password','repeat_password']){form.elements[name].required=reset;form.elements[name].disabled=!reset;form.elements[name].value='';}$('#settings-account-password-help').textContent=selected?(reset?'Choose a replacement password for this account. Its existing sessions will be signed out.':'The existing password will stay unchanged. You can update the username, role or enabled status without resetting it.'):'Choose a password for the new account, then enter it again to confirm.';}
    $('#settings-reset-password').onchange=passwordFields;
    dialog.querySelectorAll('[data-web-account]').forEach(button=>button.onclick=()=>edit(accounts.accounts[Number(button.dataset.webAccount)]));
    $('#settings-add-account').onclick=()=>edit(null);
    $('#settings-cancel-account').onclick=()=>{clearSecrets();form.hidden=true;dirtyForms.delete(form);dirty=dirtyForms.size>0;};
    form.onsubmit=e=>{e.preventDefault();const f=form.elements;accountChange({action:'save',id:selected?.id||null,username:f.username.value,role:f.role.value,enabled:f.enabled.checked,password:f.password.value,repeat_password:f.repeat_password.value,current_password:f.current_password.value});};
    $('#settings-delete-account').onclick=()=>{if(!selected||!form.elements.current_password.reportValidity()||!confirm('Delete web account '+selected.username+'?'))return;accountChange({action:'delete',id:selected.id,current_password:form.elements.current_password.value});};
  }
  function accountChange(body){
    body.expected_revision=accounts.revision;clearSecrets();
    perform(async()=>{try{const saved=await request('accounts',body);dirtyForms.delete($('#settings-account-editor'));dirtyForms.delete($('#settings-claim'));dirty=dirtyForms.size>0;if(saved.sign_in_required){signOut(body.action==='claim'?'Admin username saved. Sign in with that username and your existing password.':'Your account changed. Sign in again.');return;}accounts=await request('accounts');renderAccounts();message(body.action==='delete'?'Web account deleted.':body.id?'Web account updated.':'Web account created.');}
      catch(error){if(!error.code||['service_unavailable_private_details_omitted','web_account_changed','web_account_pending_review'].includes(error.code)){dirty=false;signOut('Account change needs confirmation. Sign in to check the saved result; do not automatically repeat it.');}else throw error;}
    },()=>{body.current_password=body.password=body.repeat_password='';});
  }
  function render(){
    renderAccounts();
    dialog.querySelector('.gp-settings-footer a').hidden=principal.role==='regular';
    if(principal.role==='regular'){ $('#settings-summary').textContent='Your sign-in and password';return; }

    $('#settings-summary').textContent=data.deployment?.label||'Your existing installation';
    $('#settings-web').innerHTML=facts([['HTTPS port',data.web.port],['Listening address',data.web.bind],['Direct origin',data.web.origin],['Access mode',data.access_mode==='manage'?'Managed administration':'Observation']]);
    $('#settings-home-screen-name').value=data.application.home_screen_name;$('#settings-discovery').value=data.application.discovery_seconds;$('#settings-display').value=data.application.display_seconds;
    $('#settings-gateways').innerHTML=data.gateways.map((g,i)=>`<article class="gp-panel"><div class="gp-panel-title"><strong>${esc(g.name)}</strong><span class="gp-pill">deCONZ</span></div><div class="gp-body">${facts([['Gateway identity',g.identity],['Connection',g.endpoint],['API key','Stored privately · never displayed']])}<details><summary>Edit connection</summary><form data-gateway-form="${i}"><label class="gp-field">Display name<input name="name" value="${esc(g.name)}" required maxlength="64"></label><label class="gp-field">Gateway URL<input name="endpoint" value="${esc(g.endpoint)}" type="url" required></label><label class="gp-field">Replacement API key <span class="gp-sub">· leave blank to keep the current key</span><input name="key" type="password" autocomplete="off" maxlength="128"></label><details><summary>Where do I get an API key?</summary><p class="gp-sub">If this connection works, leave the replacement field blank. An existing key is the value named username in the successful API-key creation response, or a copy you saved privately. It is not your Phoscon password, configurator password or alarm PIN.</p><p class="gp-sub">Need a replacement? In Phoscon choose Settings → Gateway → Advanced → Authenticate app. Within 60 seconds, create a dedicated key using the API instructions linked below, then paste the returned username here. Authenticate app authorizes creation; it does not itself give you the key.</p><p><a href="/installation-help.html#deconz-api-key-help" target="_blank" rel="noopener noreferrer">Step-by-step API-key help ↗</a></p></details><p class="gp-sub">The gateway identity stays fixed. Changes are verified before saving and activate after a reviewed broker restart.</p><button class="gp-button primary" type="submit">Verify and save connection</button></form></details></div></article>`).join('')||'<p>No gateway is configured. Consult Installation help for connection setup.</p>';
    $('#settings-restart').hidden=!data.restart_required;
    const hb=data.homebridge,details=data.homebridge_details;
    $('#settings-homebridge').innerHTML=hb&&hb.configured?`<div class="gp-settings-status"><span class="gp-pill">Configured · same host</span>${hb.pending?'<span class="gp-pill gp-warning">Maintenance needs attention</span>':''}</div>${facts([['Integration',details?.profile||hb.profile],['Storage',details?.storage||'Configured locally'],['Plugin',details?.package||'Configured locally']])}<h4>Managed alarm bindings</h4><ul>${(hb.bindings||[]).map(b=>`<li><strong>${esc(data.gateways.find(g=>g.id===b.gateway)?.name||b.gateway)}</strong><span>Alarms ${esc(b.alarms.join(', '))} · user ${esc(b.user)}</span></li>`).join('')}</ul><p class="gp-sub">Choose the Homebridge user in Users. Credential changes keep the coordinated maintenance and recovery workflow. Host paths and initial child-bridge registration are managed locally.</p>`:'<p>Homebridge is optional and is not configured for this installation.</p><p class="gp-sub">To add it, first configure a local Homebridge deCONZ child bridge, then complete the reviewed local registration procedure. Remote Homebridge is not supported yet.</p>';
    dialog.querySelectorAll('[data-gateway-form]').forEach(form=>form.onsubmit=event=>{
      event.preventDefault();const g=data.gateways[Number(form.dataset.gatewayForm)];
      const body={revision:data.revision,gateway:{...g,name:form.elements.name.value,endpoint:form.elements.endpoint.value,key:form.elements.key.value}};
      form.elements.key.value='';perform(async()=>{const saved=await request('setup/gateway',body);data={...data,...saved};onSaved(data);data.gateways=data.gateways.map(x=>({...x}));$('#settings-restart').hidden=!saved.restart_required;dirtyForms.delete(form);dirty=dirtyForms.size>0;message(saved.restart_required?'Connection saved. Broker activation is required before gateway changes can resume.':'Connection verified and saved.');},()=>body.gateway.key='');
    });
  }
  async function perform(action,finish=()=>{}){
    if(busy){finish();return;}busy=true;message('Saving…');dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{await action();}catch(error){message(error.message||'Request unavailable. Your draft has been kept.',true);}finally{finish();clearSecrets();busy=false;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
  }
  $('#settings-preferences').onsubmit=event=>{event.preventDefault();perform(async()=>{const saved=await request('setup/application',{revision:data.application_revision,settings:{home_screen_name:$('#settings-home-screen-name').value.trim(),discovery_seconds:Number($('#settings-discovery').value),display_seconds:Number($('#settings-display').value)}});data={...data,...saved};onSaved(data);document.querySelector('meta[name="apple-mobile-web-app-title"]').content=data.application.home_screen_name;dirtyForms.delete($('#settings-preferences'));dirty=dirtyForms.size>0;message('Display and discovery preferences saved.');});};
  $('#settings-password').onsubmit=event=>{
    event.preventDefault();const body={current_password:$('#settings-current-password').value,new_password:$('#settings-new-password').value,repeat_password:$('#settings-repeat-password').value};
    clearSecrets();
    if(body.new_password!==body.repeat_password){message('The new passwords do not match.',true);return;}
    perform(async()=>{
      try{await request('account/password',body);dirty=false;signOut('Password changed. Sign in with your new password.');}
      catch(error){if(!error.code||['service_unavailable_private_details_omitted','web_account_changed','web_account_pending_review'].includes(error.code)){dirty=false;signOut('Password result needs confirmation. Try signing in with your new password; do not repeat the change automatically.');}else throw error;}
    },()=>{body.current_password=body.new_password=body.repeat_password='';});
  };
  window.ConfiguratorSettings={
    async open(api,onSignOut,onUpdate,account){principal=account;request=api;signOut=onSignOut;onSaved=onUpdate;const token=++generation;dirty=false;dirtyForms.clear();clearSecrets();$('#settings-content').hidden=true;message('Loading your installation…');dialog.showModal();try{const accountResult=await request('accounts');const result=principal.role==='admin'?await request('settings'):{};if(token!==generation||!dialog.open)return;accounts=accountResult;data=result;dialog.querySelectorAll('[data-settings-tab]').forEach(tab=>tab.hidden=principal.role==='regular'&&tab.dataset.settingsTab!=='security');render();if(principal.role==='regular'||!principal.username)$('#tab-security').click();$('#settings-content').hidden=false;message('');}catch(error){if(token===generation)message(error.message,true);}},
    clear(){$('#settings-account-management').replaceChildren();$('#settings-account-name').textContent='';close(true);data=null;accounts=null;principal=null;$('#settings-content').hidden=true;$('#settings-gateways').replaceChildren();$('#settings-homebridge').replaceChildren();$('#settings-web').replaceChildren();}
  };
})();
