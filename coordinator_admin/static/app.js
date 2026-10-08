import { ProfileEditor } from './editor.js';
'use strict';
(() => {
  let editor, settings, reviewToken, busy=false;
  const $ = id => document.getElementById(id);
  const labels = { tailwind: 'Tailwind API', deconz: 'deCONZ', homebridge: 'Homebridge accessory',
    sensor: 'Door sensor', timed: 'Timed estimate', relay: 'Relay state', position: 'Position sensor' };
  const errors = {
    coordinator_authentication_failed: 'The coordinator rejected the connection credentials.',
    coordinator_identity_mismatch: 'The responding coordinator does not match the configured instance.',
    coordinator_api_incompatible: 'The coordinator and administrator use incompatible API versions.',
    coordinator_controller_not_found: 'A configured keypad refers to a controller that was not found.',
    coordinator_token_file_invalid: 'The administrator could not read its coordinator credential file.',
    coordinator_operational_status_unsupported: 'This administrator does not yet support the coordinator’s operational status.',
    coordinator_capability_unavailable: 'Update the coordinator to a version that supports connection checks.',
    coordinator_probe_invalid: 'The coordinator returned an invalid connection check.',
    coordinator_routing_invalid: 'The coordinator returned an invalid input or motor-path mapping.',
  };
  const probeMessages = {
    credentials_unavailable: 'The coordinator could not read its private device credentials file.',
    credential_reference_missing: 'The configured credential reference is missing from the coordinator’s credentials file.',
    backend_not_implemented: 'Checks for existing Homebridge accessories are not implemented yet.',
    tailwind_credential_invalid: 'The Tailwind local control key must contain six digits.',
    door_read_failed: 'Could not read Tailwind. Check its address, local control key and network connection.',
    door_response_invalid: 'Tailwind did not return the expected door index and sensor state.',
    bolt_credential_invalid: 'The deCONZ API key format is invalid.',
    bolt_identity_configuration_required: 'Configure the deCONZ gateway identity, resource type, model and manufacturer before checking.',
    bolt_read_failed: 'Could not read deCONZ. Check its address, API key and network connection.',
    bolt_gateway_identity_mismatch: 'The deCONZ gateway does not match the configured identity.',
    bolt_resource_identity_mismatch: 'The bolt resource does not match the configured endpoint, model, type or manufacturer.',
    bolt_unreachable: 'deCONZ reports that the bolt relay is unreachable.',
    bolt_response_invalid: 'deCONZ did not return a valid relay state.',
    device_probe_failed: 'The device check could not be completed.',
    tailwind_open_requires_estimate: 'Tailwind detects closed versus not closed. Choose a timed estimate for fully open.',
    tailwind_closed_sensor_available: 'Tailwind provides a closed sensor. Select sensor feedback for closing.',
    deconz_relay_is_not_position: 'This deCONZ connection reports relay state. Select relay feedback; it does not sense bolt position.',
    door_blocked: 'Tailwind reports the door as disabled or locked out.',
    bolt_extended_with_door_not_closed: 'The relay indicates locked while the door sensor says not closed. Review the physical setup.',
  };
  function item(label, value) {
    const term = document.createElement('dt'); term.textContent = label;
    const detail = document.createElement('dd'); detail.textContent = value;
    return [term, detail];
  }
  function routingTable(value) {
    const section = document.createElement('section'); section.className = 'input-routing';
    const heading = document.createElement('h4'); heading.textContent = 'Inputs and motor paths';
    const note = document.createElement('p'); note.textContent = value.runtimeEnabled ? 'Physical inputs are active with the assignments below.' : 'Physical inputs are disabled until this garage is enabled.';
    const paths = new Map(value.motorPaths.map(path => [path.id, path.id === 'primary' ? labels[path.type] : path.name]));
    const rows = [['HomeKit garage tile', 'Open / close', paths.get(value.builtins.homekit)],
      ['Virtual keypad', 'Disarm accepted: open; rejected code: close', paths.get(value.builtins.virtualKeypad)],
      ...value.inputs.map(input => [input.name + (input.enabled ? '' : ' (disabled)'),
        input.action === 'keypad' ? 'Disarm accepted: open; rejected code: close' :
          input.action === 'toggle' ? 'Open / close toggle' : input.action === 'open' ? 'Open' : 'Close', paths.get(input.motorPath)])];
    const table = document.createElement('table'); const head = document.createElement('thead'); const body = document.createElement('tbody');
    const header = document.createElement('tr');
    for (const title of ['Input', 'Action', 'Motor path']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = title; header.append(cell); }
    head.append(header);
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const value of row) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
      body.append(tr);
    }
    table.append(head, body); section.append(heading, note, table); return section;
  }
  function controller(row, diagnostics, routing) {
    const panel = document.createElement('article'); panel.className = 'gp-panel gp-body';
    const heading = document.createElement('h3'); heading.textContent = row.name;
    const details = document.createElement('dl'); details.className = 'coordinator-details';
    for (const pair of [
      ['Garage door', labels[row.doorBackend]], ['Bolt', labels[row.boltBackend]],
      ['Door state', row.status.state?.phase || row.status.phase], ['Bolt state', row.status.state?.bolt || row.status.bolt],
      ['Closing feedback', labels[row.feedback.closing]], ['Opening feedback', labels[row.feedback.opening]],
      ['Bolt feedback', labels[row.feedback.bolt]], ['Separate lock tile', row.exposeBoltLock ? 'Requested' : 'Not requested'],
    ]) details.append(...item(...pair));
    const button = document.createElement('button'); button.type = 'button'; button.className = 'gp-button probe-button';
    button.textContent = 'Check connections'; button.disabled = !diagnostics;
    const result = document.createElement('div'); result.className = 'probe-result';
    result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
    const help = document.createElement('p'); help.textContent = 'Reads Tailwind and deCONZ once. Does not open, close, lock or unlock anything.';
    button.addEventListener('click', () => probe(row.id, button, result));
    panel.append(heading, details);
    if (routing) panel.append(routingTable(routing));
    panel.append(button, help, result);
    if(row.status.bootId){const actions=document.createElement('div');actions.className='actions';
      for(const [command,label] of [['open','Open garage'],['close','Close and bolt'],['unlock','Retract bolt'],['lock','Extend bolt']]){
        const b=document.createElement('button');b.type='button';b.textContent=label;b.disabled=!row.status.actuationEnabled||row.status.state.busy||!!row.status.state.fault;
        b.onclick=()=>run(async()=>{await request('command',{controller:row.id,command,bootId:row.status.bootId,requestId:crypto.randomUUID(),issuedAt:Date.now()});message('Command accepted. Follow the current state below.');await refresh(false);});actions.append(b);
      }panel.append(actions);
      if(!row.status.actuationEnabled && row.status.held!=='maintenance'){
        const label=document.createElement('label');label.className='check';const checked=document.createElement('input');checked.type='checkbox';label.append(checked,document.createTextNode('The old controller is stopped. I have checked that the door is physically closed, the bolt wiring is correct and the motor relay is released.'));
        const enable=document.createElement('button');enable.type='button';enable.textContent='Enable / recover this garage';enable.disabled=true;checked.onchange=()=>{enable.disabled=!checked.checked;};enable.onclick=()=>run(async()=>{const current=await request('settings');await request('commission',{controller:row.id,revision:current.revision,previousControllerStopped:true,physicalSetupReviewed:true,recover:true});await refresh(false);message('Garage enabled. Begin supervised testing.');});panel.append(label,enable);
      }
      if(row.status.state.fault){const fault=document.createElement('p');fault.textContent='Control held: '+row.status.state.fault+'. Check the physical setup before recovery.';panel.append(fault);}
    }
    return panel;
  }
  async function probe(id, button, target) {
    button.disabled = true; target.replaceChildren(); target.textContent = 'Checking device connections…';
    try {
      const sessionResponse = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!sessionResponse.ok) throw Error('Sign in to the administration interface again.');
      const session = await sessionResponse.json();
      const response = await fetch('/api/extensions/homebridge-coordinator/probe', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        body: JSON.stringify({ controller: id }),
      });
      if (!response.ok) throw Error('The connection check could not be completed.');
      const data = await response.json();
      if (!data.available) throw Error(errors[data.reason] || 'The coordinator is unavailable. No current device check is available.');
      const value = data.probe;
      const summary = document.createElement('p'); summary.className = 'probe-summary';
      summary.textContent = value.compatible ? 'Connections verified. This check did not move hardware.' : 'Connection check needs attention. This check did not move hardware.';
      const details = document.createElement('dl'); details.className = 'coordinator-details';
      details.append(...item('Checked at', new Date(value.checkedAt).toLocaleString()));
      details.append(...item('Door at check', value.door.error ? probeMessages[value.door.error] :
        value.door.state === 'closed' ? 'Closed sensor active' : 'Not closed · fully open position is unknown'));
      details.append(...item('Bolt at check', value.bolt.error ? probeMessages[value.bolt.error] :
        (value.bolt.state === 'locked' ? 'Relay indicates locked' : 'Relay indicates unlocked') + ' · physical bolt position is not sensed'));
      const messages = value.limitations.map(code => { const p = document.createElement('p'); p.textContent = probeMessages[code]; return p; });
      target.replaceChildren(summary, details, ...messages);
    } catch (error) { target.replaceChildren(); target.textContent = error.message; }
    finally { button.disabled = false; }
  }
  function message(text){$('operation-message').textContent=text;}
  async function request(name, body){
    const options={credentials:'same-origin',cache:'no-store'};
    if(body!==undefined){const session=await fetch('/api/session',options);if(!session.ok)throw Error('Sign in again.');const auth=await session.json();Object.assign(options,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrf},body:JSON.stringify(body)});}
    const response=await fetch('/api/extensions/homebridge-coordinator/'+name,options);if(!response.ok)throw Error('Request could not be completed. Refresh the connection and check whether the controller is busy or held.');return response.json();
  }
  async function run(fn){if(busy)return;busy=true;try{await fn();}catch(error){message(error.message);}finally{busy=false;}}
  async function loadSettings(){settings=await request('settings');editor=new ProfileEditor($('editor'),{configuration:settings.configuration,changed:()=>{reviewToken=null;$('settings-review').hidden=true;$('settings-hint').textContent='Unsaved changes';},error:message});$('settings-panel').hidden=false;$('settings-hint').textContent='Saved settings';}
  $('review-settings').onclick=()=>run(async()=>{
    const review=await request('review-settings',{configuration:editor.configuration,revision:settings.revision});reviewToken=review.token;
    const box=$('settings-review');box.replaceChildren();box.hidden=false;const summary=document.createElement('p');summary.textContent=review.configuration.controllers.length+' garages. '+review.requiresCommissioning.length+' need enabling after saving.';
    const save=document.createElement('button');save.type='button';save.className='primary';save.textContent='Save reviewed settings';save.onclick=()=>run(async()=>{if(!reviewToken)throw Error('Review the changes again.');await request('apply-settings',{token:reviewToken});reviewToken=null;box.hidden=true;await loadSettings();await refresh(false);message('Settings saved. Changed garages require connection checks and enabling.');});
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Keep editing';cancel.onclick=()=>run(async()=>{if(reviewToken)await request('cancel-settings',{token:reviewToken});reviewToken=null;box.hidden=true;});box.append(summary,save,cancel);
  });
  async function refresh(includeSettings=true) {
    $('refresh').disabled = true;
    $('connection').textContent = 'Checking the coordinator connection…';
    try {
      const response = await fetch('/api/extensions/homebridge-coordinator/connection', {
        credentials: 'same-origin', cache: 'no-store',
      });
      if (!response.ok) throw Error(response.status === 401 ? 'Sign in to the administration interface again.' : 'The coordinator connection could not be checked.');
      const result = await response.json();
      if (!result.connected) throw Error(errors[result.reason] || 'The coordinator is unavailable or returned an unsupported response.');
      $('connection').textContent = 'Connected to the Homebridge coordinator.';
      $('controllers').replaceChildren(...result.controllers.map(row => controller(row, result.plugin.capabilities.diagnostics,
        (result.routing || []).find(routing => routing.controllerId === row.id))));
      $('readiness').textContent = result.management_ready ? 'Controller settings, coordinated commands, virtual keypad routing and maintenance are connected. Each garage must be enabled before its first supervised test.' : 'This coordinator version provides observation only. Update it to enable management.';
      if(result.management_ready){if(includeSettings)await loadSettings();const activity=await request('activity');$('activity-panel').hidden=false;$('activity').replaceChildren(...activity.events.slice(-20).reverse().map(e=>{const li=document.createElement('li');li.textContent=new Date(e.at).toLocaleString()+' · '+(e.controllerId||'Coordinator')+' · '+e.type+(e.detail?' · '+e.detail:'');return li;}));}
    } catch (error) {
      $('controllers').replaceChildren();$('connection').textContent = error.message;
      $('readiness').textContent = 'No current controller state is available. Existing door and bolt controls have not been changed.';
    } finally { $('refresh').disabled = false; }
  }
  $('refresh').addEventListener('click', ()=>run(()=>refresh(false)));
  setInterval(()=>{if(!busy&&!document.hidden&&document.activeElement===document.body)void refresh(false);},5000);
  refresh();
})();
