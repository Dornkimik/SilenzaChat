// Security regressions. Uses disposable local data and browser profiles only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import nacl from 'tweetnacl';
import crypto from '../public/crypto.js';
import { Groups } from '../lib/groups.mjs';
import { enterGuest } from './auth-browser-helper.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'silenza-recheck-'));
const probe = net.createServer();
probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
    ORIGIN: origin, ADMIN_USERNAME: '', ADMIN_PASSWORD: '', TRUSTED_PROXY_ADDRESSES: '', SECURE_COOKIES: 'false' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
try {
  await once(server.stdout, 'data');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const [ac, bc] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all([ac.newPage(), bc.newPage()]);
  a.setDefaultNavigationTimeout(15000);
  a.setDefaultTimeout(10000);
  await Promise.all([enterGuest(a, origin), enterGuest(b, origin)]);
  await Promise.all([a, b].map(page => page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected')));
  const ownId = await a.evaluate(() => me.id), peer = await b.evaluate(() => ({ id: me.id, alias: me.alias }));
  await a.evaluate(id => select({ peer: id }), peer.id);
  const forged = { id: randomUUID(), sender: peer.id, recipient: ownId, room: null,
    alias: peer.alias, text: 'REVIEW unauthenticated plaintext', time: new Date().toISOString(), reply: null, attachment: null };
  // Simulate an untrusted relay's event without modifying the application's delivered JavaScript.
  await a.evaluate(message => receive(message), forged);
  assert.equal(await a.getByText(forged.text, { exact: true }).count(), 0);
  assert.equal(await a.evaluate(id => messages.find(message => message.id === id).locked, forged.id), true);
  assert.match(await a.locator('#encryption-status').textContent(), /End-to-end encrypted/);

  const groupId = await a.evaluate(async () => (await api('groups/create', { name: 'Security regression', access: 'open' })).id);
  await b.request.post(`${origin}/api/groups/request`, { headers: { Origin: origin }, data: { group: groupId } });
  await a.evaluate(async ({ group, member }) => api('groups/approve', { group, member }), { group: groupId, member: peer.id });
  const senderKey = await a.evaluate(async id => (await api(`identity?peer=${id}`)).publicKey, peer.id);
  for (const kind of ['private', 'group']) {
    const target = kind === 'private' ? { peer: peer.id } : { group: groupId };
    await a.evaluate(target => select(target), target);
    const sample = kind === 'private' ? forged : { id: randomUUID(), sender: peer.id, senderKey, group: groupId, version: 2,
      alias: peer.alias, text: forged.text, time: forged.time, reply: null, attachment: null };
    for (const encrypted of [undefined, null, { v: 1 }, { v: 9 }, { v: 1, nonce: crypto.base64(new Uint8Array(24)), ciphertext: crypto.base64(new Uint8Array(32)) }]) {
      const input = { ...sample, id: randomUUID(), encrypted, file: { id: 'untrusted-file' }, mentions: [{ start: 0, end: 1, id: ownId }] };
      await a.evaluate(message => receive(message), input);
      assert.equal(await a.getByText(forged.text, { exact: true }).count(), 0);
      assert.equal(await a.evaluate(id => messages.find(message => message.id === id).locked, input.id), true);
      await a.evaluate(message => applyEdit({ ...message, editVersion: 1 }), input);
      assert.equal(await a.getByText(forged.text, { exact: true }).count(), 0);
      assert.equal(await a.evaluate(id => messages.find(message => message.id === id).locked, input.id), true);
    }
    const historyURL = kind === 'private' ? '**/api/history?peer=*' : '**/api/groups/history?group=*';
    await a.route(historyURL, route => route.fulfill({ json: [{ ...sample, id: randomUUID() }] }));
    await a.evaluate(target => select(target), target);
    assert.equal(await a.getByText(forged.text, { exact: true }).count(), 0);
    assert.equal(await a.evaluate(() => messages.every(message => message.locked)), true);
    await a.unroute(historyURL);
    const before = await a.evaluate(() => messages.length);
    await a.evaluate(message => receive(message), { ...sample, id: randomUUID(), room: 'contradictory-public-room', recipient: ownId });
    assert.equal(await a.evaluate(() => messages.length), before);
  }
  console.log('PASS: private/group live messages, history and edits reject missing, malformed and unauthenticated envelopes; mixed routing metadata is rejected.');

  // Keep a stale tab alive long enough to exercise its retired client directly.
  const shared = await ac.newPage(); await shared.goto(`${origin}/chat/`);
  await shared.waitForFunction(() => Boolean(encryptionClient));
  await shared.evaluate(() => { window.retiredClient = encryptionClient; signingOut = true; stream?.close(); });
  await a.evaluate(async () => {
    for (const name of ['silenzachat-private-v1', 'silenzachat-legacy-private-v1']) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onblocked = () => reject(new Error(`Legacy storage opening blocked: ${name}`));
        request.onupgradeneeded = () => { request.result.createObjectStore('identities'); request.result.createObjectStore('peers'); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction(['identities', 'peers'], 'readwrite');
          const obsoleteId = name.includes('legacy') ? 'legacy-only-identity' : 'obsolete-identity';
          tx.objectStore('identities').put(nacl.box.keyPair(), obsoleteId);
          tx.objectStore('peers').put({ publicKey: 'obsolete-pin', verified: true }, `${obsoleteId}:peer`);
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
        };
      });
    }
  });
  await a.locator('#open-settings').click(); await a.locator('#account-signout').click();
  await a.waitForFunction(() => location.pathname === '/' || document.querySelector('#signout-status').textContent.length > 0);
  if (new URL(a.url()).pathname !== '/') throw new Error(await a.locator('#signout-status').textContent());
  await a.waitForURL(`${origin}/#entry`);
  await a.waitForLoadState('load');
  const retained = await a.evaluate(id => new Promise((resolve, reject) => {
    const request = indexedDB.open('silenzachat-private-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('identities'), read = tx.objectStore('identities').get(id);
      tx.oncomplete = () => { resolve(Boolean(read.result?.secretKey)); db.close(); };
      tx.onerror = () => reject(tx.error);
    };
  }), ownId);
  assert.equal(retained, false);
  const checkStores = page => page.evaluate(async () => {
    for (const name of ['silenzachat-private-v1', 'silenzachat-legacy-private-v1']) {
      const result = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('identities'); request.result.createObjectStore('peers'); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction(['identities', 'peers']), keys = tx.objectStore('identities').getAll(), peers = tx.objectStore('peers').count();
          tx.oncomplete = () => { resolve({ revoked: keys.result.every(value => value.revoked && !value.secretKey), peers: peers.result }); db.close(); };
          tx.onerror = () => reject(tx.error);
        };
      });
      if (!result.revoked || result.peers) return false;
    }
    return true;
  });
  assert.equal(await checkStores(a), true);
  await shared.waitForFunction(() => { try { retiredClient.code({}); return false; } catch (error) { return error.message.includes('signed out'); } });
  assert.equal(await shared.evaluate(async id => {
    try { await SilenzaCrypto.createClient(id, async () => ({})); return false; }
    catch (error) { return error.message.includes('signed out'); }
  }, ownId), true);
  assert.equal(await checkStores(a), true);
  console.log('PASS: chat logout clears current/obsolete/legacy keys and peer pins; stale tabs and migration cannot restore the retired identity.');

  // The landing page also offers sign-out and must clear keys without loading NaCl.
  const registered = await a.request.post(`${origin}/api/auth/register`, { headers: { Origin: origin }, data: { username: 'review_member', password: 'local browser password only' } });
  assert.equal(registered.status(), 200);
  await a.goto(`${origin}/chat/`); await a.waitForFunction(() => Boolean(encryptionClient));
  await a.goto(origin); await a.locator('#entry-signout').waitFor({ state: 'visible' });
  await a.locator('#entry-signout').click();
  await a.locator('#guest-enter').waitFor({ state: 'visible' });
  assert.equal(await checkStores(a), true);
  console.log('PASS: landing-page sign-out also clears local keys and pins.');

  const ownerIdentity = nacl.box.keyPair(), adminIdentity = nacl.box.keyPair();
  const owner = { id: randomUUID(), alias: 'Owner', publicKey: crypto.base64(ownerIdentity.publicKey), sent: [] };
  const admin = { id: randomUUID(), alias: 'Admin', publicKey: crypto.base64(adminIdentity.publicKey), sent: [], admin: true };
  const store = new Groups({ isAdmin: user => user.admin === true, emit() {}, broadcast() {}, safeUser: user => ({ id: user.id, alias: user.alias }), findUser: id => [owner, admin].find(user => user.id === id) });
  const room = store.handle('POST', 'create', owner, { name: 'Restricted', access: 'invite' });
  assert.throws(() => store.handle('POST', 'join', admin, { group: room.id }), /invitation/);
  assert.throws(() => store.moderate('update', admin, { group: room.id, name: room.name, access: 'open' }), /Only the room owner/);
  store.moderate('update', admin, { group: room.id, name: 'Moderated description', description: 'Updated' });
  assert.equal(store.get(room.id).access, 'invite');
  assert.throws(() => store.handle('POST', 'join', admin, { group: room.id }), /invitation/);
  store.handle('POST', 'invite', owner, { group: room.id, member: admin.id });
  const state = store.handle('POST', 'join', admin, { group: room.id });
  const id = randomUUID();
  const envelopes = crypto.encryptGroupMessage({ id, group: room.id, version: state.version, sender: owner.id, text: 'REVIEW future group message' }, ownerIdentity, state.members);
  const sent = store.handle('POST', 'message', owner, { group: room.id, id, version: state.version, envelopes });
  const view = store.viewMessage(store.get(room.id).history.find(message => message.id === sent.id), admin);
  assert.equal(crypto.decryptGroupMessage(view, admin.id, adminIdentity, owner.publicKey).text, 'REVIEW future group message');
  console.log('PASS: admin metadata moderation preserves invite-only access; joining and decrypting future messages requires an owner invitation.');
} finally {
  await browser?.close();
  const exited = once(server, 'exit'); server.kill(); await exited;
  await rm(directory, { recursive: true, force: true });
}
