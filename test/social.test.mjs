import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import encryption from '../public/crypto.js';

test('profiles, read receipts and room join requests work over HTTP', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'silenza-social-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child;
  async function boot() {
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
  }
  async function stop() { if (child?.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
  async function request(user, route, body) {
    const response = await fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: user.cookie || '', Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  }
  async function identity(user) {
    user.identity = nacl.box.keyPair();
    assert.equal((await request(user, 'identity', { publicKey: encryption.base64(user.identity.publicKey) })).status, 200);
  }
  function dm(a, b) {
    const id = randomUUID();
    return request(a, 'message', { id, peer: b.me.id, encrypted: encryption.encryptMessage({ id, sender: a.me.id, recipient: b.me.id, text: 'Hello' }, a.identity, encryption.base64(b.identity.publicKey)) });
  }
  const a = {}, b = {}, guest = {};
  try {
    await boot();
    a.me = (await request(a, 'auth/register', { username: 'Profiled', password: 'a long test password' })).data;
    b.me = (await request(b, 'auth/register', { username: 'Reader', password: 'a long test password' })).data;
    guest.me = (await request(guest, 'session')).data.me;
    await Promise.all([identity(a), identity(b), identity(guest)]);

    // Profiles are optional, validated, visible to others and kept by accounts across logins.
    for (const invalid of [{ age: 17 }, { age: 100 }, { age: '30' }, { gender: 'robot' }, { gender: 'woman', extra: true }])
      assert.equal((await request(a, 'profile', invalid)).status, 400);
    const saved = await request(a, 'profile', { gender: 'woman', age: 31 });
    assert.equal(saved.status, 200); assert.equal(saved.data.gender, 'woman'); assert.equal(saved.data.age, 31);
    const relogin = {};
    assert.equal((await request(relogin, 'auth/login', { username: 'Profiled', password: 'a long test password' })).data.age, 31);
    const cleared = await request(a, 'profile', { gender: null, age: null });
    assert.equal(cleared.data.gender, undefined); assert.equal(cleared.data.age, undefined);
    assert.equal((await request(guest, 'profile', { gender: 'nonbinary' })).data.gender, 'nonbinary');
    // Saving the same profile again is free; frequent changes are limited because each one is broadcast.
    assert.equal((await request(guest, 'profile', { gender: 'nonbinary' })).status, 200);
    const changes = [];
    for (const age of [20, 21, 22, 23, 24]) changes.push((await request(guest, 'profile', { gender: 'nonbinary', age })).status);
    assert.deepEqual(changes, [200, 200, 200, 200, 429]);
    await request(guest, 'profile', { gender: 'nonbinary', age: 23 });

    // Read receipts: only the recipient can mark the peer's messages as seen.
    const first = (await dm(a, b)).data, second = (await dm(a, b)).data;
    assert.equal((await request(a, 'private/read', { peer: b.me.id, id: first.id })).status, 404);
    assert.equal((await request(b, 'private/read', { peer: a.me.id, id: 'missing' })).status, 404);
    const read = await request(b, 'private/read', { peer: a.me.id, id: second.id });
    assert.deepEqual(read.data.ids, [first.id, second.id]);
    assert.deepEqual((await request(b, 'private/read', { peer: a.me.id, id: second.id })).data.ids, []);
    const history = (await request(a, `history?peer=${b.me.id}`)).data;
    assert.ok(history.every(m => typeof m.readAt === 'string'));

    // Discoverable rooms take a request that staff approve; direct joins are refused.
    const room = (await request(a, 'groups/create', { name: 'Ask first', access: 'open' })).data;
    assert.equal((await request(b, 'groups/join', { group: room.id })).status, 403);
    assert.equal((await request(b, 'groups/request', { group: room.id })).data.requested, true);
    assert.equal((await request(guest, 'groups/request', { group: room.id })).status, 200);
    const requests = (await request(a, `groups/state?group=${room.id}`)).data.joinRequests;
    assert.deepEqual(requests.map(r => r.id), [b.me.id, guest.me.id]);
    // Profile details are visible to others next to the name.
    assert.equal(requests[1].gender, 'nonbinary'); assert.equal(requests[0].gender, undefined);
    assert.equal((await request(a, 'groups/decline', { group: room.id, member: guest.me.id })).status, 200);
    assert.equal((await request(b, 'groups/approve', { group: room.id, member: b.me.id })).status, 403);
    const approved = await request(a, 'groups/approve', { group: room.id, member: b.me.id });
    assert.equal(approved.status, 200); assert.equal(approved.data.members.length, 2);
    assert.equal((await request(b, `groups/state?group=${room.id}`)).status, 200);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
