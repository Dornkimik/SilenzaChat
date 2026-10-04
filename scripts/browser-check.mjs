import { enterGuest, enterAccount, signOut } from './auth-browser-helper.mjs';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { auditAttachments } from './attachment-privacy-audit.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'silenzachat-browser-'));
const probe = net.createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); const port = probe.address().port; await new Promise(r=>probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',ORIGIN:origin,ADMIN_USERNAME: 'host', ADMIN_PASSWORD:'browser-test-only'},stdio:['ignore','pipe','pipe']});
let browser; const errors=[];
try {
  await once(server.stdout,'data');
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox']});
  const [ac,bc,cc] = await Promise.all([browser.newContext({ reducedMotion: 'reduce' }),browser.newContext({ reducedMotion: 'reduce' }),browser.newContext({ reducedMotion: 'reduce' })]);
  const [a,b,c] = await Promise.all([ac.newPage(),bc.newPage(),cc.newPage()]);
  await ac.addInitScript(() => {
    localStorage.setItem('silenzachat-legacy-theme', 'light');
    const nativeFetch = window.fetch.bind(window);
    const ready = new Promise((resolve, reject) => {
      const request = indexedDB.open('silenzachat-legacy-private-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('identities');
        request.result.createObjectStore('peers');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('identities', 'readwrite');
        tx.objectStore('identities').put({ migrationSentinel: 'preserved' }, 'migration-probe');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    window.fetch = (...args) => ready.then(() => nativeFetch(...args));
  });
  const sent=[];
  for(const page of [a,b,c]) { page.on('pageerror',e=>errors.push(e.message)); page.on('request',r=>{if(r.url().endsWith('/api/message') && r.method()==='POST') sent.push(r.postDataJSON());}); }
  const landing = await browser.newPage();
  await landing.goto(origin);
  assert.match(await landing.locator('h1').textContent(), /A little company/);
  await landing.locator('#guest-enter').click();
  await landing.waitForURL(`${origin}/chat/`);
  await landing.close();
  await enterAccount(a, origin, 'browser-test-only');
  await Promise.all([enterGuest(b, origin),enterGuest(c, origin)]);
  assert.equal(await a.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await a.evaluate(() => localStorage.getItem('silenzachat-theme')), 'light');
  assert.equal(await a.evaluate(() => localStorage.getItem('silenzachat-legacy-theme')), null);
  await a.selectOption('#theme-select', 'dark');
  const migratedKeys = await a.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('silenzachat-private-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('identities'), get = tx.objectStore('identities').get('migration-probe');
      get.onsuccess = () => { db.close(); resolve(get.result?.migrationSentinel); };
      get.onerror = () => reject(get.error);
    };
  }));
  assert.equal(migratedKeys, 'preserved');
  for(const page of [a,b,c]) await page.waitForFunction(()=>document.querySelector('#connection').textContent==='Connected');
  const aliasA=await a.locator('#my-alias').textContent(), aliasB=await b.locator('#my-alias').textContent();
  await a.locator('#people .person').filter({hasText:aliasB}).click();
  await a.waitForFunction(()=>document.querySelector('#encryption-status').textContent.includes('End-to-end encrypted'));
  await a.locator('#message').fill('private sentinel caption'); await a.locator('.send-button').click();
  await b.locator('#dms .dm-room').filter({hasText:aliasA}).click();
  await b.getByText('private sentinel caption',{exact:true}).waitFor();
  assert.equal(sent[0].text,undefined); assert.ok(sent[0].encrypted); assert.ok(!JSON.stringify(sent[0]).includes('private sentinel caption'));
  // Reload and another tab reuse the local identity.
  await b.reload(); await b.locator('#dms .dm-room').filter({hasText:aliasA}).click(); await b.getByText('private sentinel caption',{exact:true}).waitFor();
  const tab=await ac.newPage(); await tab.goto(`${origin}/chat/`); await tab.locator('#dms .dm-room').filter({hasText:aliasB}).click(); await tab.getByText('private sentinel caption',{exact:true}).waitFor(); await tab.close();
  await a.locator('#verify-identity').click(); await b.locator('#verify-identity').click();
  await a.locator('#verify-dialog').waitFor({state:'visible'}); await b.locator('#verify-dialog').waitFor({state:'visible'});
  assert.equal(await a.locator('#verification-code').textContent(),await b.locator('#verification-code').textContent());
  await a.locator('#confirm-verification').click(); await b.locator('#confirm-verification').click();
  assert.match(await a.locator('#encryption-status').textContent(),/Identity verified/);
  // Reproduce a browser closing IndexedDB while the chat is still open.
  const storageRecovery = await a.evaluate(async () => {
    const nativeTransaction = IDBDatabase.prototype.transaction;
    let closed = false;
    IDBDatabase.prototype.transaction = function (...args) {
      if (!closed && this.name === 'silenzachat-private-v1') { closed = true; this.close(); }
      return nativeTransaction.apply(this, args);
    };
    try {
      const before = encryptionClient.code(peerIdentity);
      const peers = await Promise.all(Array.from({ length: 4 }, () => encryptionClient.peer(current.peer)));
      const after = encryptionClient.code(peers[0]);
      await encryptionClient.verify(peers[0]);
      let rejectsChangedKey = false;
      try {
        await encryptionClient.encryptGroup({ id: crypto.randomUUID(), group: 'test', version: 1, sender: me.id, text: 'Must not encrypt' },
          [{ id: peers[0].id, publicKey: SilenzaCrypto.base64(nacl.box.keyPair().publicKey) }]);
      } catch (e) { rejectsChangedKey = e.message.includes('Encryption identity changed'); }
      return { closed, sameIdentity: before === after, verified: peers.every(p => p.verified), rejectsChangedKey };
    } finally { IDBDatabase.prototype.transaction = nativeTransaction; }
  });
  assert.deepEqual(storageRecovery, { closed: true, sameIdentity: true, verified: true, rejectsChangedKey: true });
  // Encrypt a locally generated raster image. The original filename must never leave the browser.
  const imageAudit = await auditAttachments(a);
  const image=await a.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=100;const ctx=canvas.getContext('2d');ctx.fillStyle='#326b50';ctx.fillRect(0,0,160,100);return canvas.toDataURL('image/png').split(',')[1];});
  await imageAudit.assertFailsClosed(Buffer.from(image, 'base64'));
  await a.locator('#file-input').setInputFiles({name:'private-filename.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await a.locator('#attachment-preview').waitFor({state:'visible'});
  await a.locator('#message').fill('secret image caption'); await a.locator('.send-button').click();
  await b.waitForFunction(()=>{const img=document.querySelector('.private-image');return img?.complete && img.naturalWidth===160;});
  assert.ok(!JSON.stringify(sent).includes('secret image caption')); assert.ok(!JSON.stringify(sent).includes('private-filename'));
  const imageMessage=sent.find(m=>m.attachmentId); assert.ok(imageMessage);
  const unauthorized=await c.request.get(`${origin}/api/attachments/${imageMessage.attachmentId}`); assert.equal(unauthorized.status(),404);
  // Private reply content is also ciphertext.
  await b.locator('.chat-message').filter({hasText:'secret image caption'}).getByRole('button',{name:'Reply',exact:true}).click();
  await b.locator('#message').fill('secret reply'); await b.locator('.send-button').click();
  await a.getByText('secret reply',{exact:true}).waitFor();
  assert.ok(!JSON.stringify(sent).includes('secret reply'));
  await a.screenshot({path:path.join(data, 'private-desktop.png'),fullPage:true});
  await b.setViewportSize({width:390,height:844}); await b.screenshot({path:path.join(data, 'private-mobile.png'),fullPage:true});
  // An attachment can be sent with no caption (the textarea is not required).
  await a.locator('#file-input').setInputFiles({name:'image-only.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await a.locator('#attachment-preview').waitFor({state:'visible'}); assert.equal(await a.locator('#message').inputValue(), '');
  await a.locator('.send-button').click();
  await b.waitForFunction(()=>[...document.querySelectorAll('.private-image')].filter(img=>img.complete && img.naturalWidth===160).length===2);
  // The next attachments come from the other participant, so the sender stays within the message rate limit.
  const attachmentAuditB = await auditAttachments(b);
  // A camera-style JPEG with EXIF location: the metadata is removed before encryption and the photo still renders.
  const jpeg = Buffer.from(await b.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;const ctx=canvas.getContext('2d');ctx.fillStyle='#8a3b2f';ctx.fillRect(0,0,120,80);return canvas.toDataURL('image/jpeg').split(',')[1];}),'base64');
  const exif = Buffer.concat([Buffer.from([0x45,0x78,0x69,0x66,0,0,0x4D,0x4D,0,42,0,0,0,8,0,0,0,0,0,0]), Buffer.from('GPS-SECRET-48.8584N-2.2945E')]);
  const camera = Buffer.concat([jpeg.subarray(0,2), Buffer.from([0xFF,0xE1,(exif.length+2)>>8,(exif.length+2)&255]), exif, jpeg.subarray(2)]);
  await b.locator('#file-input').setInputFiles({name:'holiday-photo.jpg',mimeType:'image/jpeg',buffer:camera});
  await b.locator('#attachment-preview').waitFor({state:'visible'});
  assert.match(await b.locator('#attachment-preview .attachment-detail').textContent(), /Metadata removed/);
  await b.locator('.send-button').click();
  await a.waitForFunction(()=>[...document.querySelectorAll('.private-image')].some(img=>img.complete && img.naturalWidth===120));
  attachmentAuditB.assertNeverEncrypted('GPS-SECRET');
  // A real browser recording (WebM with live, unknown-size elements) loads on demand and plays without its muxer metadata.
  const clip = Buffer.from(await b.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=48;const ctx=canvas.getContext('2d');
    const recorder=new MediaRecorder(canvas.captureStream(10),{mimeType:'video/webm'}),chunks=[];
    recorder.ondataavailable=event=>chunks.push(event.data);recorder.start();
    for(let i=0;i<8;i++){ctx.fillStyle=`rgb(${i*30},90,120)`;ctx.fillRect(0,0,64,48);await new Promise(r=>setTimeout(r,60));}
    const stopped=new Promise(r=>{recorder.onstop=r;});recorder.stop();await stopped;
    const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);
  }),'base64');
  assert.ok(clip.includes('Chrome'), 'The recorder should have written its muxer name as metadata.');
  await b.locator('#file-input').setInputFiles({name:'recording.webm',mimeType:'video/webm',buffer:clip});
  await b.locator('#attachment-preview').waitFor({state:'visible'}); await b.locator('.send-button').click();
  await a.getByRole('button',{name:'Load video',exact:true}).click();
  await a.waitForFunction(()=>{const video=document.querySelector('.private-video');return video && video.readyState>=1 && video.videoWidth===64;});
  attachmentAuditB.assertNeverEncrypted('Chrome');
  // Other files are encrypted with their name and offered only as a download.
  await b.locator('#file-input').setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('private notes body')});
  await b.locator('#attachment-preview').waitFor({state:'visible'});
  assert.match(await b.locator('#attachment-preview .attachment-detail').textContent(), /notes\.txt.*not removed/);
  await b.locator('.send-button').click();
  const downloadButton = a.getByRole('button',{name:'Download notes.txt',exact:true}); await downloadButton.waitFor();
  const [download] = await Promise.all([a.waitForEvent('download'), downloadButton.click()]);
  assert.match(download.suggestedFilename(),/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.txt$/);
  assert.equal(await readFile(await download.path(),'utf8'),'private notes body');
  for (const secret of ['holiday-photo','recording.webm','notes.txt','private notes body']) assert.ok(!JSON.stringify(sent).includes(secret));
  // Senders can delete their own images; recipients cannot. Replies and active previews are cleared.
  const imageRow = `#message-${imageMessage.id}`;
  assert.equal(await b.locator(imageRow).getByRole('button', {name:'Delete',exact:true}).count(), 0);
  await b.locator(imageRow).getByRole('button', {name:'Reply',exact:true}).click();
  await a.locator(imageRow).getByRole('button', {name:'Delete',exact:true}).click();
  await a.locator(imageRow).waitFor({state:'detached'}); await b.locator(imageRow).waitFor({state:'detached'});
  await b.locator('#reply-preview').waitFor({state:'hidden'});
  await b.getByText('Original message removed', {exact:true}).waitFor();
  assert.equal((await b.request.get(`${origin}/api/attachments/${imageMessage.attachmentId}`)).status(), 404);
  // Ordinary public-room messages have the same Delete action.
  await c.locator('#message').fill('public message to delete'); await c.locator('.send-button').click();
  const publicRow = c.locator('.chat-message').filter({hasText:'public message to delete'});
  await publicRow.getByRole('button', {name:'Delete',exact:true}).click(); await publicRow.waitFor({state:'detached'});
  // Private drafts must not appear in public room composers.
  await a.locator('#message').fill('unsent private draft');
  await a.locator('#rooms .nav-room').first().click(); assert.equal(await a.locator('#message').inputValue(), '');
  await a.locator('#dms .dm-room').filter({hasText:aliasB}).click();
  await a.waitForFunction(()=>document.querySelector('#message').disabled===false);
  assert.equal(await a.locator('#message').inputValue(), 'unsent private draft'); await a.locator('#message').fill('');
  // Offline recipients can decrypt later without either browser uploading a private key.
  await b.close(); await a.locator('#message').fill('delivered while offline'); await a.locator('.send-button').click();
  await a.getByText('delivered while offline', {exact:true}).waitFor();
  const returned=await bc.newPage(); returned.on('pageerror',e=>errors.push(e.message)); await returned.goto(`${origin}/chat/`);
  await returned.locator('#dms .dm-room').filter({hasText:aliasA}).click(); await returned.getByText('delivered while offline',{exact:true}).waitFor();
  assert.match(await returned.locator('#encryption-status').textContent(), /Identity verified/);
  // Only authenticated admins can opt into the visible identity, shared across tabs.
  await a.locator('#rooms .nav-room').first().click();
  await a.locator('#message').fill('message before admin display'); await a.locator('.send-button').click();
  const earlierName = c.locator('.chat-message').filter({hasText:'message before admin display'}).locator('.message-name');
  await earlierName.waitFor(); assert.equal(await earlierName.getAttribute('class'), 'message-name');
  await a.locator('#dms .dm-room').filter({hasText:aliasB}).click();
  assert.equal(await c.locator('#display-as-admin').isVisible(), false);
  await a.locator('#open-admin').click();
  await a.locator('#display-as-admin').waitFor({state:'visible'});
  assert.equal(await a.locator('#display-as-admin').isChecked(), false);
  await a.locator('#display-as-admin').check();
  await c.locator('#people .admin-name').filter({hasText:aliasA}).waitFor();
  assert.equal(await earlierName.locator('.admin-badge').count(), 0);
  const earlierOwnName = a.locator('.chat-message').filter({hasText:'delivered while offline'}).locator('.message-name');
  assert.equal(await earlierOwnName.locator('.admin-badge').count(), 0);
  await c.reload(); await earlierName.waitFor();
  const adminTab = await ac.newPage(); await adminTab.goto(`${origin}/chat/`);
  await adminTab.waitForFunction(()=>document.querySelector('#display-as-admin').checked);
  await a.locator('#admin-dialog .close-dialog').click();
  await a.locator('#message').fill('visible admin private message'); await a.locator('.send-button').click();
  const privateAdmin = returned.locator('.chat-message').filter({hasText:'visible admin private message'});
  await privateAdmin.locator('.message-name.admin-name').waitFor();
  await a.locator('#rooms .nav-room').first().click();
  await a.locator('#message').fill('visible admin public message'); await a.locator('.send-button').click();
  const adminName = c.locator('.chat-message').filter({hasText:'visible admin public message'}).locator('.message-name');
  await adminName.locator('.admin-badge').waitFor();
  assert.equal(await adminName.evaluate(el => getComputedStyle(el).fontWeight), '800');
  assert.equal(await adminName.evaluate(el => getComputedStyle(el).color), 'rgb(239, 143, 150)');
  await c.selectOption('#theme-select', 'light');
  assert.equal(await adminName.evaluate(el => getComputedStyle(el).color), 'rgb(169, 45, 66)');
  await c.selectOption('#theme-select', 'dark');
  await a.locator('#open-admin').click(); await a.locator('#display-as-admin').uncheck();
  await c.locator('#people .admin-name').filter({hasText:aliasA}).waitFor({state:'detached'});
  await adminTab.waitForFunction(()=>!document.querySelector('#display-as-admin').checked);
  await a.locator('#admin-dialog .close-dialog').click();
  await a.locator('#message').fill('ordinary admin public message'); await a.locator('.send-button').click();
  const ordinaryName = c.locator('.chat-message').filter({hasText:'ordinary admin public message'}).locator('.message-name');
  await ordinaryName.waitFor(); assert.equal(await ordinaryName.getAttribute('class'), 'message-name');
  assert.equal(await adminName.locator('.admin-badge').count(), 1);
  assert.equal(await earlierName.locator('.admin-badge').count(), 0);
  await privateAdmin.locator('.admin-badge').waitFor();
  await a.locator('#open-admin').click(); await a.locator('#display-as-admin').check();
  assert.equal(await ordinaryName.locator('.admin-badge').count(), 0);
  await a.locator('#admin-dialog .close-dialog').click(); await adminTab.close();
  // A substituted public key must block the conversation instead of silently trusting it.
  const substitute=await c.evaluate(()=>btoa(String.fromCharCode(...nacl.box.keyPair().publicKey)));
  await a.route('**/api/identity?peer=*',async route=>{ const response=await route.fetch(); const data=await response.json(); await route.fulfill({json:{...data,publicKey:substitute}}); });
  await a.locator('#rooms .nav-room').first().click(); await a.locator('#dms .dm-room').filter({hasText:aliasB}).click();
  await a.waitForFunction(()=>document.querySelector('#error').textContent.includes('Encryption identity changed'));
  assert.equal(await a.locator('#message').isDisabled(),true);
  // Losing a local key does not silently replace the registered key.
  await returned.evaluate(async()=>{await new Promise((resolve,reject)=>{const r=indexedDB.open('silenzachat-private-v1');r.onsuccess=()=>{const tx=r.result.transaction('identities','readwrite');tx.objectStore('identities').clear();tx.oncomplete=resolve;tx.onerror=reject;};});});
  await returned.reload(); await returned.locator('#dms .dm-room').filter({hasText:aliasA}).click();
  await returned.waitForFunction(()=>document.querySelector('#error').textContent.includes('local encryption key does not match'));
  assert.equal(await returned.locator('#message').isDisabled(),true);
  assert.deepEqual(errors,[]);
  const auditedImages = await imageAudit.verify(Buffer.from(image, 'base64'), 'private-filename.png') + await attachmentAuditB.verify(camera, 'holiday-photo.jpg');
  console.log(`PASS: ${auditedImages} private attachment uploads contain exact padded ciphertext; server returns unchanged ciphertext; no attachment plaintext or secret keys in captured requests`);
  console.log('PASS: private text, encrypted images (EXIF removed), on-demand WebM video, generic file download, replies, third-party isolation, reload, shared-tab keys, matching verification codes, offline delivery, key-change/key-loss blocking, private draft isolation, owner deletion and attachment cleanup, desktop/mobile rendering');
} finally {
  await browser?.close(); server.kill(); await once(server,'exit'); await rm(data,{recursive:true,force:true});
}
