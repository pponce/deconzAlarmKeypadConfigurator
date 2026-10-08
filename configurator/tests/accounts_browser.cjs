'use strict';
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
let stage='launch';
(async()=>{
 for(const engine of [chromium,webkit]){
 const browser=await engine.launch({headless:true});
 try{for(const mobile of [false,true]){
  const child=spawn('python3',['-B',path.join(__dirname,'parity_fixture.py')],{env:{...process.env,CONFIGURATOR_ACCOUNTS:'synthetic'}});
  try{
   const [raw]=await once(child.stdout,'data'),fixture=JSON.parse(raw.toString());
   const context=await browser.newContext({ignoreHTTPSErrors:true,isMobile:mobile,hasTouch:mobile,viewport:mobile?{width:390,height:844}:{width:1440,height:1000}});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
   const click=selector=>mobile?page.locator(selector).tap():page.locator(selector).click();
   const login=async(username,password)=>{await page.fill('#username',username);await page.fill('#password',password);await click('#login button');await page.waitForSelector('#settings-gear');};
   stage=engine.name()+' '+(mobile?'phone':'desktop')+' existing admin username';
   await page.goto(fixture.origin);await login('',fixture.password);await click('#settings-gear');await page.waitForSelector('#settings-claim');
   await page.fill('#settings-claim [name=username]','Admin');await page.fill('#settings-claim [name=current_password]',fixture.password);await click('#settings-claim button');await page.waitForSelector('#login');
   await login('Admin',fixture.password);await click('#settings-gear');await page.waitForSelector('#settings-content');await click('#tab-security');await click('#settings-add-account');
   stage=engine.name()+' create Regular web account';
   await page.fill('#settings-account-editor [name=username]','Helper');await page.fill('#settings-account-editor [name=password]','helper-password');await page.fill('#settings-account-editor [name=repeat_password]','helper-password');await page.fill('#settings-account-editor [name=current_password]',fixture.password);await click('#settings-account-editor button[type=submit], #settings-account-editor button.primary');await page.waitForFunction(()=>document.querySelector('#settings-account-list').textContent.includes('Helper'));assert.equal(await page.isVisible('#login'),false);await click('[data-web-account="1"]');assert.equal(await page.isVisible('#settings-account-passwords'),false);assert.match(await page.textContent('#settings-account-password-help'),/stay unchanged/);await click('#settings-reset-password');assert.equal(await page.isVisible('#settings-account-passwords'),true);const preview=process.env.PREVIEW_OUTPUT;if(preview){fs.mkdirSync(preview,{recursive:true});await page.screenshot({path:path.join(preview,'account-editor-'+engine.name()+'-'+(mobile?'mobile':'desktop')+'.png'),fullPage:true});}await click('#settings-cancel-account');await page.keyboard.press('Escape');await click('#logout');await page.waitForSelector('#login');
   let release;const held=new Promise(resolve=>release=resolve);
   await page.route('**/api/administration',async route=>{await held;await route.continue();});
   await login('Helper','helper-password');
   assert.equal(await page.locator('#user-list button').count(),0,'Previous admin list must be cleared before regular responses arrive');
   assert.equal(await page.locator('#settings-account-management button').count(),0);
   release();await page.waitForSelector('#user-list button');await page.unroute('**/api/administration');
   stage=engine.name()+' regular redaction and owner protections';
   assert.doesNotMatch(await page.textContent('#user-list'),/Service user/);
   if(mobile){await click('#mobile-menu');}
   for(const id of ['gateway','history','alarm','keypad'])assert.equal(await page.isVisible(`[data-page=${id}]`),false,'Forbidden navigation: '+id);
   if(mobile)await click('#mobile-menu-close');
   await click('#user-list [data-id="'+'a'.repeat(32)+'"]');await page.waitForFunction(()=>document.querySelector('#name')?.value==='Owner'&&!document.querySelector('#editor').dataset.loading);assert.equal(await page.isDisabled('#name'),true);assert.equal(await page.isDisabled('#pin'),true);
   if(mobile)await click('#mobile-users-back');
   stage=engine.name()+' ordinary user editor readiness';
   await click('#user-list [data-id="'+(12).toString(16).padStart(32,'0')+'"]');await page.waitForFunction(()=>document.querySelector('#name')?.value==='Visitor'&&!document.querySelector('#editor').dataset.loading);
   assert.equal(await page.isDisabled('#name'),false);assert.doesNotMatch(await page.textContent('#editor'),/Homebridge/i);
   stage=engine.name()+' regular policy write';
   await page.fill('#name','Updated visitor');await click('#editor button.primary');await page.waitForFunction(()=>document.querySelector('#user-list').textContent.includes('Updated visitor'));
   const session=await page.evaluate(()=>fetch('/api/session').then(r=>r.json()));
   for(const url of ['/api/settings','/api/activity-options','/api/extensions/controller/settings','/extensions/controller/index.html']){
    const code=await page.evaluate(async url=>(await fetch(url)).status,url);assert.equal(code,403,url);
   }
   const denied=await page.evaluate(async csrf=>(await fetch('/api/lockout/save',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,'X-Configurator-Gateway':'example','X-Configurator-Alarm':'1'},body:'{}'})).status,session.csrf);assert.equal(denied,403);
   stage=engine.name()+' phone list summary and reset-only protections';
   if(mobile){await click('#mobile-users-back');assert.equal(await page.isVisible('#user-list #user-alarm-access'),false);await click('#mobile-menu');}
   await click('[data-page=protection]');await page.waitForSelector('#lockout-reset');assert.equal(await page.locator('#lockout-form input').count(),0);await click('#lockout-reset');
   await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('escalation reset'));
   await click('#settings-gear');await page.waitForSelector('#settings-content');assert.equal(await page.isVisible('#tab-general'),false);assert.equal(await page.locator('#settings-account-management button').count(),0);
   const out=process.env.PREVIEW_OUTPUT;if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'accounts-'+engine.name()+'-'+(mobile?'mobile':'desktop')+'.png')});}
   assert.deepEqual(errors,[]);await context.close();
  }finally{child.kill();}
 }}finally{await browser.close();}
 }
 console.log('Account migration, regular-user workflows, permissions and mobile summary passed in Chromium/WebKit.');
})().catch(e=>{if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'result='+String(stage+': '+e.message).replace(/\n/g,' ').slice(0,2500)+'\n');console.error(stage,e);process.exitCode=1;});
