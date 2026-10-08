'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
let stage='browser startup';
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{for(const mobile of [false,true]){
  const child=spawn('python3',['-B',path.join(__dirname,'parity_fixture.py')],{env:{...process.env,CONFIGURATOR_PROTECTION:'synthetic'}});
  let errors='';child.stderr.on('data',b=>errors+=b);
  const [raw]=await once(child.stdout,'data'),fixture=JSON.parse(raw.toString());
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:mobile?{width:390,height:844}:{width:1440,height:1100}});
  const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',d=>d.accept());
  try{
   stage=(mobile?'mobile':'desktop')+' login and named status';
   await page.goto(fixture.origin);await page.fill('#password',fixture.password);await page.click('#login button');
   await page.waitForSelector('#user-list button');
   await page.waitForSelector('#demo-mode:enabled',{state:'attached'});
   if(mobile)await page.click('#mobile-menu');await page.click('[data-page="protection"]');
   await page.waitForSelector('[data-keypad-status="2"][data-state="locked"]');
   assert.equal(await page.textContent('#lockout-state'),'1 of 2 keypads locked out');
   assert((await page.textContent('[data-keypad-status="1"]')).includes('Entry keypad'));
   assert.equal(await page.getAttribute('[data-keypad-status="1"]','data-state'),'clear');
   assert((await page.textContent('[data-keypad-status="2"]')).includes('Side keypad'));
   assert((await page.textContent('[data-keypad-status="2"]')).includes('Stored escalation: 2 of 3'));
   assert.equal(await page.textContent('#configuration-context'),'Example gateway · Protection by alarm');
   const output=process.env.PREVIEW_OUTPUT||'/tmp/configurator-preview';await fs.mkdir(output,{recursive:true});
   await page.screenshot({path:path.join(output,mobile?'mobile-protection.png':'desktop-protection.png'),fullPage:true});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
   stage=(mobile?'mobile':'desktop')+' alarm-wide reset';
   await page.click('#lockout-reset');
   await page.waitForFunction(()=>document.querySelector('#lockout-state').textContent==='0 of 2 keypads locked out');
   assert.equal(await page.locator('[data-keypad-status][data-state="clear"]').count(),2);
   assert((await page.textContent('#protection-keypads')).match(/Stored escalation: 0 of 3/g).length===2);
   stage=(mobile?'mobile':'desktop')+' other alarm unchanged';
   await page.click('[data-protection-alarm="2"] summary');
   await page.waitForSelector('[data-keypad-status="3"][data-state="locked"]');
   assert.equal(await page.textContent('#lockout-state'),'1 of 1 keypad locked out');
   assert.equal(await page.locator('[data-keypad-status="2"]').count(),0);
   stage=(mobile?'mobile':'desktop')+' status failure and recovery';
   await page.route('**/api/lockout',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'}));
   await page.waitForFunction(()=>document.querySelector('#lockout-state').textContent==='Status unavailable');
   assert.equal(await page.getAttribute('[data-keypad-status="3"]','data-state'),'unknown');
   await page.unroute('**/api/lockout');
   await page.waitForSelector('[data-keypad-status="3"][data-state="locked"]');
   stage=(mobile?'mobile':'desktop')+' disabled protection';
   await page.uncheck('#lockout-enabled');await page.click('#lockout-form button.primary');
   await page.waitForFunction(()=>document.querySelector('#lockout-state').textContent==='Protection off');
   assert.equal(await page.getAttribute('[data-keypad-status="3"]','data-state'),'off');
   stage=(mobile?'mobile':'desktop')+' virtual keypad subtitle';
   await page.waitForSelector('#demo-mode:enabled',{state:'attached'});
   if(mobile)await page.click('#mobile-menu');await page.click('[data-page="keypad"]');
   await page.waitForSelector('[data-keypad-digit="2"]:enabled');
   assert.equal(await page.textContent('#configuration-context'),'Example gateway · Workshop alarm');
   assert.deepEqual(pageErrors,[]);
  }finally{await page.close();child.kill();if(errors)console.error(errors);}
 }
 console.log('Named keypad status, per-alarm reset, unavailable status and mobile layout passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(stage,e);if(process.env.GITHUB_OUTPUT)require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT,'result='+stage+': '+String(e).replaceAll('\n',' ').slice(0,1500)+'\n');process.exitCode=1;});
