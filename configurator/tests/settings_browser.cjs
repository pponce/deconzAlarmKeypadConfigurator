'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
let stage='launch';
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{for(const mobile of [false,true]){
  const child=spawn('python3',['-B',path.join(__dirname,'parity_fixture.py')]);
  try{
   const [raw]=await once(child.stdout,'data'),fixture=JSON.parse(raw.toString());
   const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:mobile?{width:390,height:844}:{width:1440,height:1000}});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
   stage=(mobile?'mobile':'desktop')+' settings entry and draft';
   await page.goto(fixture.origin);assert.equal(await page.isVisible('#settings-gear'),false);
   await page.fill('#password',fixture.password);await page.click('#login button');if(mobile){await page.waitForSelector('#user-list button');await page.locator('#user-list button').first().click();}await page.waitForSelector('#name');
   await page.fill('#name','Unsaved editor draft');await page.click('#settings-gear');await page.waitForSelector('#settings-content');
   const gear=await page.locator('#settings-gear').boundingBox(),logout=await page.locator('#logout').boundingBox();assert.ok(gear.x>=logout.x+logout.width);
   await page.click('#settings-close');assert.equal(await page.inputValue('#name'),'Unsaved editor draft');
   await page.click('#settings-gear');await page.waitForSelector('#settings-content');
   stage=(mobile?'mobile':'desktop')+' settings preferences';await page.click('#tab-general');
   assert.equal(await page.inputValue('#settings-home-screen-name'),'Keypad Cntrl');await page.fill('#settings-home-screen-name','Workshop Admin');await page.fill('#settings-display','9');await page.click('#settings-preferences button');
   await page.waitForFunction(()=>document.querySelector('#settings-message').textContent.includes('preferences saved'));
   await page.click('#settings-close');await page.click('#settings-gear');await page.waitForSelector('#settings-content');assert.equal(await page.inputValue('#settings-display'),'9');assert.equal(await page.inputValue('#settings-home-screen-name'),'Workshop Admin');assert.equal(await page.getAttribute('meta[name="apple-mobile-web-app-title"]','content'),'Workshop Admin');const manifest=await page.evaluate(()=>fetch('/manifest.webmanifest').then(r=>r.json()));assert.equal(manifest.name,'Workshop Admin');assert.equal(manifest.short_name,'Workshop Admin');
   stage=(mobile?'mobile':'desktop')+' connection details';
   await page.click('#tab-connections');assert.match(await page.textContent('#settings-gateways'),/Example gateway/);assert.match(await page.textContent('#settings-homebridge'),/Configured · same host/);
   assert.equal(await page.evaluate(()=>document.querySelector('#installation-settings').scrollWidth>document.querySelector('#installation-settings').clientWidth),false);
   const out=process.env.PREVIEW_OUTPUT;if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'settings-connections-'+(mobile?'mobile':'desktop')+'.png'),fullPage:true});}
   stage=(mobile?'mobile':'desktop')+' verified connection save';
   await page.click('#settings-gateways summary');await page.fill('[data-gateway-form] input[name="name"]','Renamed gateway');await page.click('[data-gateway-form] button');
   await page.waitForFunction(()=>document.querySelector('#settings-message').textContent.includes('Connection saved'));
   assert.equal(await page.isVisible('#settings-restart'),true);
   stage=(mobile?'mobile':'desktop')+' password verification';
   await page.click('#tab-security');
   if(out)await page.screenshot({path:path.join(out,'settings-security-'+(mobile?'mobile':'desktop')+'.png'),fullPage:true});
   await page.fill('#settings-current-password','wrong');await page.fill('#settings-new-password','new-preview-password');await page.fill('#settings-repeat-password','new-preview-password');await page.click('#settings-password button');
   await page.waitForFunction(()=>document.querySelector('#settings-message').textContent.includes('current password is incorrect'));
   assert.equal(await page.inputValue('#settings-new-password'),'');
   await page.fill('#settings-current-password',fixture.password);await page.fill('#settings-new-password','new-preview-password');await page.fill('#settings-repeat-password','new-preview-password');await page.click('#settings-password button');
   await page.waitForSelector('#login');assert.equal(await page.isVisible('#installation-settings'),false);
   await page.fill('#password',fixture.password);await page.click('#login button');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Username or password not recognized'));
   await page.fill('#password','new-preview-password');await page.click('#login button');await page.waitForSelector('#settings-gear');
   assert.equal(page.url(),fixture.origin+'/');assert.deepEqual(errors,[]);await context.close();
  }finally{child.kill();}
 }}finally{await browser.close();}
 console.log('Settings desktop/mobile, draft preservation, connection/preferences writes and password rotation passed.');
})().catch(e=>{if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'result='+String(stage+': '+e.message).replace(/\n/g,' ').slice(0,2500)+'\n');console.error(stage,e);process.exitCode=1;});
