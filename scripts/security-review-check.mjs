// Regression checks for the security review against a disposable local server.
// Does not use the live site, .env, existing accounts, or existing chat data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import crypto from '../public/crypto.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'silenza-security-review-'));
const probe = net.createServer();
probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
    ORIGIN: origin, ADMIN_USERNAME: 'review_host', ADMIN_PASSWORD: 'local review password only', SECURE_COOKIES: 'false', TRUSTED_PROXY_ADDRESSES: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const controllers = [];
async function request(user, route, input, forwarded) {
  const response = await fetch(`${origin}/api/${route}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Cookie: user.cookie || '', Origin: origin, 'Content-Type': 'application/json',
      'X-Forwarded-For': forwarded || '192.0.2.1' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) user.cookie = cookie.split(';')[0];
  return { status: response.status, data: await response.json() };
}
async function guest() {
  const user = {};
  const response = await request(user, 'session'); assert.equal(response.status, 200);
  user.me = response.data.me; user.rooms = response.data.rooms; user.identity = nacl.box.keyPair();
  assert.equal((await request(user, 'identity', { publicKey: crypto.base64(user.identity.publicKey) })).status, 200);
  return user;
}
async function dm(sender, recipient, text) {
  const id = randomUUID();
  const encrypted = crypto.encryptMessage({ id, sender: sender.me.id, recipient: recipient.me.id, text },
    sender.identity, crypto.base64(recipient.identity.publicKey));
  const result = await request(sender, 'message', { id, peer: recipient.me.id, encrypted });
  assert.equal(result.status, 200); return result.data;
}
async function upload(sender, recipient) {
  const response = await fetch(`${origin}/api/attachments?peer=${recipient.me.id}`, { method: 'POST',
    headers: { Cookie: sender.cookie, Origin: origin, 'Content-Type': 'application/octet-stream' },
    body: crypto.encryptAttachment(new Uint8Array([1])).bytes });
  assert.equal(response.status, 200); return (await response.json()).id;
}
async function download(user, id) {
  const response = await fetch(`${origin}/api/attachments/${id}`, { headers: { Cookie: user.cookie } });
  await response.body.cancel(); return response.status;
}
try {
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`Review server exited: ${code}`); })
  ]);
  const host = {};
  assert.equal((await request(host, 'auth/login', { username: 'review_host', password: 'local review password only' })).status, 200);
  const [a, b] = await Promise.all([guest(), guest()]);
  const oldId = a.me.id, oldAlias = a.me.alias;
  const publicMessage = await request(a, 'message', { room: a.rooms[0].id, text: 'Local review guest message' });
  const outgoing = await dm(b, a, 'Local review retained ciphertext');
  const oldUpload = await upload(b, a);
  assert.equal(await download(b, oldUpload), 200);
  const group = (await request(a, 'groups/create', { name: 'Guest transition room', access: 'open' })).data;
  assert.equal((await request(b, 'groups/request', { group: group.id })).status, 200);
  assert.equal((await request(a, 'groups/approve', { group: group.id, member: b.me.id })).status, 200);
  const originalCookie = a.cookie;
  const registered = await request(a, 'auth/register', { username: 'ReviewMember', password: 'disposable review password' });
  assert.equal(registered.status, 200); a.me = registered.data;
  assert.notEqual(a.cookie, originalCookie);
  assert.notEqual(a.me.id, oldId);
  assert.equal((await request({ cookie: originalCookie }, 'auth/status')).data.me, null);
  assert.equal((await request(b, `identity?peer=${oldId}`)).status, 409);
  assert.equal((await request(b, `identity?peer=${a.me.id}`)).status, 409);
  assert.equal((await request(b, 'message/delete', { id: outgoing.id })).status, 404);
  assert.equal(await download(b, oldUpload), 404);
  const transferred = (await request(b, `groups/state?group=${group.id}`)).data;
  assert.equal(transferred.owner, b.me.id); assert.equal(transferred.members.length, 1);
  a.identity = nacl.box.keyPair();
  assert.equal((await request(a, 'identity', { publicKey: crypto.base64(a.identity.publicKey) })).status, 200);
  const controller = new AbortController(); controllers.push(controller);
  const stream = await fetch(`${origin}/api/events`, { headers: { Cookie: a.cookie, 'X-Forwarded-For': '192.0.2.1' }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const observer = (await request(b, 'session')).data;
  assert.equal(observer.people.find(person => person.id === publicMessage.data.sender), undefined);
  assert.equal(observer.people.find(person => person.id === a.me.id)?.alias, 'ReviewMember');
  const oldPost = (await request(b, `history?room=${a.rooms[0].id}`)).data.find(m => m.id === publicMessage.data.id);
  assert.equal(oldPost.alias, oldAlias); assert.equal(oldPost.sender, oldId);
  console.log('PASS: guest-to-account transition rotates public identity, invalidates the guest cookie, drops old histories, and requires a new encryption identity.');

  const retained = await dm(b, a, 'Must be removed by a ban');
  const bannedUpload = await upload(b, a);
  assert.equal(await download(b, bannedUpload), 200);
  assert.equal((await request(host, 'admin/ban', { id: a.me.id })).status, 200);
  assert.equal((await request(b, `history?peer=${a.me.id}`)).status, 404);
  assert.equal((await request(b, 'message/delete', { id: retained.id })).status, 404);
  assert.equal(await download(b, bannedUpload), 404);
  console.log('PASS: banning a participant removes private history as well as denying access.');

  const sessions = [];
  for (let i = 0; i < 16; i++) {
    const result = await request({}, 'session'); assert.equal(result.status, 200); sessions.push(result.data.me.id);
  }
  assert.equal(new Set(sessions).size, 16);
  for (let i = 0; i < 12; i++) assert.equal((await request({}, 'session')).status, 200);
  assert.equal((await request({}, 'session')).status, 429);
  assert.equal((await request(b, 'session')).status, 200);
  assert.equal((await request({}, 'session', undefined, '198.51.100.2')).status, 200);
  console.log('PASS: guest creation is throttled without blocking existing sessions or another trusted client address.');

  for (let i = 0; i < 101; i++) {
    const result = await request({}, 'auth/login', { username: `review_probe_${i}`, password: 'x'.repeat(129) }, '203.0.113.1');
    assert.equal(result.status, i === 100 ? 429 : 403);
  }
  const unrelated = await request({}, 'auth/login', { username: 'review_host', password: 'local review password only' }, '198.51.100.2');
  assert.equal(unrelated.status, 200);
  console.log('PASS: exhausting one trusted client address does not deny another client a valid login.');
} finally {
  for (const controller of controllers) controller.abort();
  if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  assert.equal(path.dirname(directory), tmpdir());
  await rm(directory, { recursive: true, force: true });
}
