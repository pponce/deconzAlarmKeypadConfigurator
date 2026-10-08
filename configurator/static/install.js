'use strict';
(()=>{
 const $=id=>document.getElementById(id);let csrf='',question='',busy=false,finished=false;
 const clearSecrets=()=>document.querySelectorAll('input[type="password"]').forEach(input=>input.value='');
 async function api(path,body){const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error||'Setup is unavailable. Check the terminal.');return data;}
 function render(value){
  if(value.csrf)csrf=value.csrf;
  if(value.kind==='complete'||value.kind==='error'){
   finished=true;clearSecrets();$('install-card').hidden=true;$('install-status').textContent=value.message;
   $('install-title').textContent=value.kind==='complete'?'Your configurator is ready':'Setup needs attention';
   if(value.kind==='complete'&&value.url){const url=new URL(value.url);if(url.protocol==='https:'){$('install-done').href=url.href;$('install-done').hidden=false;}}
   return;
  }
  if(value.kind!=='question'){$('install-status').textContent='Checking your configuration…';return;}
  if(value.id===question)return; // Polling must never replace a draft or secret input.
  question=value.id;clearSecrets();$('install-title').textContent=value.title;$('install-stage').textContent=value.stage;
  $('install-status').textContent='';$('install-help').replaceChildren();$('install-fields').replaceChildren();
  for(const text of value.help||[]){const p=document.createElement('p');p.className='gp-sub';p.textContent=text;$('install-help').append(p);}
  for(const field of value.fields){
   const label=document.createElement('label');label.className='gp-field';label.textContent=field.label;
   const checkbox=field.type==='checkbox';const input=document.createElement(field.options&&!checkbox?'select':'input');input.name=field.id;input.id='install-'+field.id;
   if(checkbox){input.type='checkbox';input.checked=field.value==='y';label.className='gp-check';}
   else if(field.options){for(const option of field.options){const node=document.createElement('option');node.value=option.value;node.textContent=option.label;input.append(node);}}
   else{input.type=field.type||'text';input.autocomplete=input.type==='password'&&field.id!=='secret'?'new-password':'off';if(input.type==='number'){input.min=field.min;input.max=field.max;}else{input.maxLength=field.max||1024;if(field.min)input.minLength=field.min;}}
   if(!checkbox)input.value=field.value||'';input.required=!checkbox;label.append(input);$('install-fields').append(label);
  }
  $('install-card').hidden=false;$('install-submit').disabled=false;$('install-fields').querySelector('input,select')?.focus();
 }
 async function poll(){if(finished||busy)return;try{render(await api('status'));}catch(error){clearSecrets();$('install-status').textContent=error.message;}}
 $('install-form').onsubmit=async event=>{
  event.preventDefault();if(busy||!question)return;busy=true;$('install-submit').disabled=true;
  const body={id:question,values:Object.fromEntries(new FormData(event.target))};for(const input of event.target.querySelectorAll('input[type="checkbox"]'))body.values[input.name]=input.checked?'y':'n';clearSecrets();
  try{await api('answer',body);$('install-status').textContent='Checking your configuration…';}
  catch(error){$('install-status').textContent=error.message;}
  finally{for(const key in body.values)body.values[key]='';busy=false;await poll();}
 };
 window.addEventListener('pagehide',clearSecrets);
 (async()=>{let token=location.hash.slice(1);history.replaceState(null,'',location.pathname);try{if(token)csrf=(await api('claim',{token})).csrf;await poll();}catch(error){$('install-status').textContent=error.message;}finally{token='';}setInterval(poll,1000);})();
})();
