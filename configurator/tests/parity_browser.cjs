'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
let stage='fixture startup';
(async()=>{
 const child=spawn('python3',['-B',path.join(__dirname,'parity_fixture.py')]);let stderr='';child.stderr.on('data',b=>stderr+=b);
 const [raw]=await once(child.stdout,'data');const fixture=JSON.parse(raw.toString());
 let browser;try{browser=await chromium.launch({headless:true});}catch(e){child.kill();throw e;}
 try {for(const mobile of [false,true]){
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:mobile?{width:390,height:844}:{width:1440,height:1000}}),errors=[];
  const navigate=async name=>{if(mobile)await page.click('#mobile-menu');await page.click('[data-page="'+name+'"]');};
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  stage=(mobile?'mobile':'desktop')+' login and user editor';
  await page.goto(fixture.origin);await page.fill('#password',fixture.password);await page.click('#login button');
  if(mobile){await page.waitForSelector('#user-list button');await page.locator('#user-list button').first().click();}
  await page.waitForSelector('#name',{timeout:15000});
  assert.equal(await page.inputValue('#name'),'Owner');
  let releaseOverview,overviewRequested;
  const held=new Promise(resolve=>releaseOverview=resolve),requested=new Promise(resolve=>overviewRequested=resolve);
  await page.route('**/api/administration',async route=>{overviewRequested();await held;await route.continue();},{times:1});
  if(mobile){await page.click('#mobile-users-back');await page.waitForSelector('#user-list button');}
  await page.click('[data-id="0000000000000000000000000000000c"]');await requested;
  assert.equal(await page.inputValue('#name'),'Owner');assert.equal(await page.locator('#name').isDisabled(),true);
  releaseOverview();
  await page.waitForFunction(()=>/visitor/i.test(document.querySelector('#name')?.value||''));
  assert.equal(await page.locator('#hb-use').isChecked(),false);
  assert.equal(await page.locator('#hb-use').isDisabled(),true);
  assert.equal(await page.isVisible('#hb-configuration'),false);
  assert((await page.textContent('#hb-choice-note')).includes('To choose this user for Homebridge'));
  assert((await page.textContent('.gp-homebridge-selection')).includes('Current Homebridge user:'));
  assert(await page.locator('#hb-use').evaluate(el=>el.closest('label').nextElementSibling.id==='hb-choice-note'));
  await page.fill('#name',mobile?'Mobile visitor':'Desktop visitor');
  await page.check('#scheduled');if(await page.locator('.gp-window').count()===0)await page.click('#add-window');await page.locator('.window-full-day').first().check();
  await page.click('#editor button.primary');
  await page.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('Saved.'));
  assert.equal(await page.inputValue('#name'),mobile?'Mobile visitor':'Desktop visitor');
  assert.equal(await page.locator('.window-full-day').first().isChecked(),true);
  await fs.mkdir(process.env.PREVIEW_OUTPUT||'/tmp/configurator-preview',{recursive:true});
  await page.screenshot({path:path.join(process.env.PREVIEW_OUTPUT||'/tmp/configurator-preview',mobile?'mobile-users.png':'desktop-users.png'),fullPage:true});
  stage=(mobile?'mobile':'desktop')+' grants and alarm timings';
  await navigate('access');await page.waitForSelector('[data-edit-grant]');
  await navigate('alarm');await page.waitForSelector('[data-alarm-timer]');
  await page.fill('[data-alarm-timer="armed_stay_entry_delay"]','17');await page.click('#alarm-save');
  await page.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('Alarm timings saved'));
  assert.equal(await page.inputValue('[data-alarm-timer="armed_stay_entry_delay"]'),'17');
  stage=(mobile?'mobile':'desktop')+' protection';
  await navigate('protection');await page.waitForSelector('#lockout-threshold');
  await page.fill('#lockout-threshold','8');await page.click('#lockout-form button.primary');
  await page.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('Keypad protection saved'));
  stage=(mobile?'mobile':'desktop')+' scoped history';
  await navigate('history');await page.waitForSelector('.gp-history-row');
  if(await page.isVisible('#history-gateway'))await page.selectOption('#history-gateway','example');await page.selectOption('#history-alarm','2');
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.gp-history-row')).every(r=>r.textContent.includes('Workshop alarm')));
  stage=(mobile?'mobile':'desktop')+' scoped history clear';
  await page.click('#history-clear');await page.waitForFunction(()=>document.querySelector('#activity').textContent.includes('No collected'));
  await page.selectOption('#history-alarm','1');await page.waitForSelector('.gp-history-row');
  stage=(mobile?'mobile':'desktop')+' Homebridge user selection';
  await navigate('users');await page.click('[data-id="0000000000000000000000000000000d"]');
  await page.waitForFunction(()=>document.querySelector('#name')?.value==='Service user');
  assert.equal(await page.isVisible('#hb-configuration'),mobile);
  if(!mobile){
   await page.check('#hb-use');assert.equal(await page.isVisible('#hb-configuration'),true);
   await page.uncheck('#hb-use');assert.equal(await page.isVisible('#hb-configuration'),false);
  }
  await page.check('#hb-use');await page.fill('#pin',mobile?'56789012':'45678901');await page.fill('#pin-repeat',mobile?'56789012':'45678901');
  assert.equal(await page.isVisible('#hb-configuration'),true);
  assert.equal(await page.locator('[data-hb-alarm]:checked:disabled').count(),2);
  assert((await page.textContent('#hb-alarms')).includes('already linked to Homebridge'));
  await page.click('#editor button.primary');
  const flow=page.locator('.gp-homebridge-flow');await flow.waitFor();
  await flow.getByRole('button',{name:'Continue to preparation',exact:true}).click();
  await flow.getByRole('button',{name:'Start update',exact:true}).click();
  if(!mobile){
   await flow.getByRole('button',{name:'Check saved update and continue',exact:true}).click();
   assert.equal(await page.inputValue('#pin'),'');assert.equal(await page.inputValue('#pin-repeat'),'');
  }
  await flow.getByRole('heading',{name:'Homebridge access updated',exact:true}).waitFor();
  await flow.getByRole('button',{name:'Done',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('Homebridge access updated'));
  assert.equal(await page.isVisible('#interrupted-change'),false);
  assert.equal(await page.locator('a[href="/setup.html"]').count(),0);
  assert((await page.textContent('#homebridge-panel')).includes('Service user'));
  stage=(mobile?'mobile':'desktop')+' keypad';
  await navigate('keypad');await page.waitForSelector('[data-keypad-digit="2"]:enabled');
  for(const digit of '2323')await page.click('[data-keypad-digit="'+digit+'"]');
  await page.waitForFunction(()=>document.querySelector('#keypad-results').textContent.includes('Accepted'));
  await page.screenshot({path:path.join(process.env.PREVIEW_OUTPUT||'/tmp/configurator-preview',mobile?'mobile-keypad.png':'desktop-keypad.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
  await page.close();
 }
 console.log('Desktop/mobile real-core workflows passed.');
 }finally{await browser.close();child.kill();if(stderr)console.error(stderr);}
})().catch(e=>{console.error(stage,e);if(process.env.GITHUB_OUTPUT)require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT,'result='+stage+': '+String(e).replaceAll('\n',' ').slice(0,2000)+'\n');process.exitCode=1;});
