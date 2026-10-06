import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import encryption from '../public/crypto.js';

test('anonymous public chat, private isolation, admin control and persistence', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'silenzachat-test-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child; const streams = [];
  async function boot() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'integration-test-password', ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); }); });
  }
  async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  async function visitor() {
    const res = await fetch(`${origin}/api/session`);
    const user = { cookie: res.headers.get('set-cookie').split(';')[0], ...(await res.json()), identity: nacl.box.keyPair() };
    assert.equal((await request(user, 'identity', { publicKey: encryption.base64(user.identity.publicKey) })).status, 200);
    return user;
  }
  function privatePayload(user, peer, text, extra = {}) {
    const id = randomUUID();
    const encrypted = encryption.encryptMessage({ id, sender: user.me.id, recipient: peer.me.id, text, ...extra }, user.identity, encryption.base64(peer.identity.publicKey));
    return { id, peer: peer.me.id, encrypted, replyTo: extra.replyTo, attachmentId: extra.file?.id };
  }
  const decrypt = (message, user, peer) => encryption.decryptMessage(message, user.me.id, user.identity, encryption.base64(peer.identity.publicKey));
  async function request(user, route, body, source = origin) {
    const res = await fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: user.cookie, Origin: source, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.headers.get('set-cookie')) user.cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json() };
  }
  async function events(user) {
    const controller = new AbortController(); streams.push(controller);
    const res = await fetch(`${origin}/api/events`, { headers: { Cookie: user.cookie }, signal: controller.signal });
    let buffer = ''; const messages = []; messages.removals = [];
    (async () => { try { for await (const chunk of res.body) { buffer += new TextDecoder().decode(chunk); let end; while ((end = buffer.indexOf('\n\n')) !== -1) { const part = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (part.startsWith('event: message\n')) messages.push(JSON.parse(part.split('\ndata: ')[1])); if (part.startsWith('event: message-removed\n')) messages.removals.push(JSON.parse(part.split('\ndata: ')[1]).id); } } } catch {} })();
    return messages;
  }
  try {
    await boot();
    const [a,b,c] = await Promise.all([visitor(),visitor(),visitor()]);
    assert.notEqual(a.me.id, b.me.id); assert.equal(a.me.admin, false);
    assert.equal(a.me.displayAsAdmin, false);
    assert.equal((await request(c, 'admin/appearance', { displayAsAdmin: true })).status, 403);
    let [ae,be,ce] = await Promise.all([events(a),events(b),events(c)]);
    const room = a.rooms[0].id;
    const pub = await request(a, 'message', { room, text: 'Hello, everyone!', displayAsAdmin: true, admin: true }); assert.equal(pub.status, 200);
    assert.equal(pub.data.displayAsAdmin, false); // Client-supplied admin flags cannot impersonate an admin.
    const dm = await request(a, 'message', privatePayload(a, b, '<script>private</script>')); assert.equal(dm.status, 200);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(ae.some(m => m.id === dm.data.id)); assert.ok(be.some(m => m.id === dm.data.id)); assert.ok(ce.some(m => m.id === pub.data.id)); assert.ok(!ce.some(m => m.id === dm.data.id));
    const privateHistory = (await request(b, `history?peer=${a.me.id}`)).data;
    assert.equal(decrypt(privateHistory[0], b, a).text, '<script>private</script>');
    assert.equal(privateHistory[0].text, undefined);
    assert.ok(!JSON.stringify(privateHistory).includes('<script>private</script>'));
    assert.equal((await request(a, 'message', { peer: b.me.id, text: 'plaintext forbidden' })).status, 400);
    assert.equal((await request(a, 'identity', { publicKey: encryption.base64(nacl.box.keyPair().publicKey) })).status, 409);
    assert.equal((await request(a, 'identity', { publicKey: encryption.base64(new Uint8Array(32)) })).status, 400);
    assert.equal((await request(a, 'message', { ...privatePayload(a, b, 'secret'), text: 'leaked caption' })).status, 400);
    assert.deepEqual((await request(c, `history?peer=${a.me.id}`)).data, []);
    const reply = await request(b, 'message', { room, text: `Hi @${a.me.alias}! 👋`, replyTo: pub.data.id });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.data.reply, { id: pub.data.id, alias: a.me.alias, text: pub.data.text });
    assert.deepEqual(reply.data.mentions, [{ id: a.me.id, alias: a.me.alias, start: 3, end: 4 + a.me.alias.length }]);
    assert.equal((await request(c, 'message', { room, text: 'Expose private quote', replyTo: dm.data.id })).status, 400);
    assert.equal((await request(b, 'message', { room: a.rooms[1].id, text: 'Wrong room', replyTo: pub.data.id })).status, 400);
    assert.equal((await request(b, 'message', privatePayload(b, c, 'Wrong participants', { replyTo: dm.data.id }))).status, 400);
    const privateReply = await request(b, 'message', privatePayload(b, a, `Thanks @${a.me.alias}, @${c.me.alias}`, { replyTo: dm.data.id }));
    assert.equal(privateReply.status, 200);
    assert.equal(privateReply.data.mentions, undefined);
    assert.equal(decrypt(privateReply.data, a, b).text, `Thanks @${a.me.alias}, @${c.me.alias}`);
    const literal = await request(b, 'message', privatePayload(b, a, `email@${a.me.alias} @${a.me.alias}extra`));
    assert.equal(literal.data.mentions, undefined);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(be.some(m => m.id === reply.data.id && m.reply.id === pub.data.id));
    assert.ok(!ce.some(m => m.id === privateReply.data.id));
    assert.equal((await request(a, 'message', { room, text: 'x'.repeat(2001) })).status, 400);
    assert.equal((await request(a, 'message', { room, text: 'forged' }, 'https://other.example')).status, 403);
    assert.equal((await request(c, 'admin/create', { name: 'Forbidden' })).status, 403);
    assert.equal((await request(c, 'admin/remove-message', { id: pub.data.id })).status, 403);
    assert.equal((await request(c, 'admin/ban', { id: b.me.id })).status, 403);
    // Ordinary users can delete their own public and private messages, but never another sender's.
    assert.equal((await request(c, 'message/delete', { id: pub.data.id })).status, 404);
    assert.equal((await request(b, 'message/delete', { id: dm.data.id })).status, 404);
    assert.equal((await request(a, 'message/delete', { id: pub.data.id }, 'https://other.example')).status, 403);
    assert.equal((await request(a, 'message/delete', { id: dm.data.id })).status, 200);
    const afterPrivateDelete = (await request(b, `history?peer=${a.me.id}`)).data;
    assert.ok(!afterPrivateDelete.some(m => m.id === dm.data.id));
    assert.deepEqual(afterPrivateDelete.find(m => m.id === privateReply.data.id).reply, { id: dm.data.id, removed: true });
    assert.equal((await request(a, 'message/delete', { id: dm.data.id })).status, 404);
    assert.equal((await request(a, 'message/delete', { id: pub.data.id })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(ae.removals.includes(dm.data.id)); assert.ok(be.removals.includes(dm.data.id)); assert.ok(!ce.removals.includes(dm.data.id));
    assert.equal((await request(a, 'auth/login', { username: 'host', password: 'wrong' })).status, 403);
    const upgraded = await request(a, 'auth/login', { username: 'host', password: 'integration-test-password' });
    assert.equal(upgraded.status, 200); assert.notEqual(upgraded.data.id, a.me.id);
    a.me = upgraded.data; a.identity = nacl.box.keyPair();
    assert.equal((await request(a, 'identity', { publicKey: encryption.base64(a.identity.publicKey) })).status, 200);
    ae = await events(a);
    assert.equal((await request(a, 'session')).data.me.displayAsAdmin, false);
    const userRoom = (await request(b, 'groups/create', { name: 'User room', access: 'invite' })).data;
    const editRoom = { group: userRoom.id, name: 'Moderated room', description: 'Updated', rules: 'Be kind' };
    assert.equal((await request(c, 'admin/state')).status, 403);
    assert.equal((await request(c, 'admin/groups/update', editRoom)).status, 403);
    assert.equal((await request(c, 'admin/groups/delete', { group: userRoom.id })).status, 403);
    const listedRoom = (await request(a, 'admin/state')).data.groups.find(g => g.id === userRoom.id);
    assert.equal(listedRoom.name, 'User room'); assert.equal(listedRoom.joined, false);
    assert.equal(listedRoom.members, undefined); assert.equal(listedRoom.history, undefined);
    assert.equal((await request(a, 'admin/groups/update', { ...editRoom, name: '' })).status, 400);
    assert.equal((await request(a, 'admin/groups/update', { ...editRoom, access: 'open' })).status, 403);
    assert.equal((await request(a, 'admin/groups/update', editRoom)).status, 200);
    const updatedRoom = (await request(b, `groups/state?group=${userRoom.id}`)).data;
    assert.equal(updatedRoom.name, editRoom.name); assert.equal(updatedRoom.rules, editRoom.rules);
    assert.equal(updatedRoom.description, editRoom.description); assert.equal(updatedRoom.access, 'invite');
    assert.equal((await request(a, 'groups/join', { group: userRoom.id })).status, 403);
    assert.equal(updatedRoom.owner, b.me.id); assert.equal(updatedRoom.count, 1);
    assert.equal((await request(a, `groups/history?group=${userRoom.id}`)).status, 403);
    assert.equal((await request(a, 'admin/groups/delete', { group: userRoom.id })).status, 200);
    assert.equal((await request(b, `groups/state?group=${userRoom.id}`)).status, 404);
    assert.equal((await request(a, 'admin/groups/update', editRoom)).status, 404);
    assert.equal((await request(a, 'admin/appearance', { displayAsAdmin: 'true' })).status, 400);
    assert.equal((await request(a, 'admin/appearance', { displayAsAdmin: true })).data.displayAsAdmin, true);
    assert.equal((await request(a, 'session')).data.me.displayAsAdmin, true);
    const visibleAdmin = (await request(b, 'session')).data.people.find(p => p.id === a.me.id);
    assert.equal(visibleAdmin.displayAsAdmin, true);
    assert.equal(visibleAdmin.admin, undefined); // Do not disclose hidden admin rights to other users.
    assert.equal((await request(a, 'admin/appearance', { displayAsAdmin: false })).data.admin, true);
    assert.equal((await request(b, 'session')).data.people.find(p => p.id === a.me.id).displayAsAdmin, false);
    await request(a, 'admin/appearance', { displayAsAdmin: true });
    assert.equal((await request(a, 'admin/ban', { id: a.me.id })).status, 400);
    await new Promise(resolve => setTimeout(resolve, 100)); assert.ok(ce.removals.includes(pub.data.id));
    const remaining = (await request(c, `history?room=${room}`)).data;
    assert.equal(remaining.length, 1);
    assert.deepEqual(remaining[0].reply, { id: pub.data.id, removed: true });
    assert.equal((await request(b, 'message', { room, text: 'Reply after removal', replyTo: pub.data.id })).status, 400);
    const plaintext = new TextEncoder().encode('private attachment bytes only visible in browsers');
    const encryptedImage = encryption.encryptAttachment(plaintext);
    const uploadedResponse = await fetch(`${origin}/api/attachments?peer=${b.me.id}`, { method: 'POST', headers: { Cookie: a.cookie, Origin: origin, 'Content-Type': 'application/octet-stream' }, body: encryptedImage.bytes });
    assert.equal(uploadedResponse.status, 200); const uploaded = await uploadedResponse.json();
    const imageURL = `${origin}/api/attachments/${uploaded.id}`;
    assert.equal((await fetch(imageURL, { headers: { Cookie: b.cookie } })).status, 404); // Not published yet.
    const file = { id: uploaded.id, key: encryptedImage.key, nonce: encryptedImage.nonce, kind: 'file', type: 'application/octet-stream', name: 'notes.txt', size: plaintext.length };
    assert.equal((await request(b, 'message', privatePayload(b, a, 'stolen upload', { file }))).status, 404);
    const payload = privatePayload(a, b, 'encrypted caption', { file });
    const sentImage = await request(a, 'message', payload); assert.equal(sentImage.status, 200);
    assert.equal(sentImage.data.displayAsAdmin, true);
    assert.equal((await request(a, 'message', payload)).data.id, payload.id); // Safe network retry.
    assert.equal((await fetch(imageURL, { headers: { Cookie: c.cookie } })).status, 404);
    assert.equal((await fetch(imageURL)).status, 401);
    const downloaded = await fetch(imageURL, { headers: { Cookie: b.cookie } });
    assert.equal(downloaded.headers.get('cache-control'), 'no-store');
    const ciphertext = new Uint8Array(await downloaded.arrayBuffer());
    assert.deepEqual(ciphertext, encryptedImage.bytes); assert.notDeepEqual(ciphertext, plaintext);
    assert.deepEqual(encryption.decryptAttachment(ciphertext, decrypt(sentImage.data, b, a).file), plaintext);
    await request(a, 'admin/appearance', { displayAsAdmin: false });
    assert.equal((await request(a, 'session')).data.me.displayAsAdmin, false);
    assert.equal((await request(b, `history?peer=${a.me.id}`)).data.find(m => m.id === sentImage.data.id).displayAsAdmin, true);
    assert.equal((await request(b, 'message/delete', { id: sentImage.data.id })).status, 404);
    assert.equal((await request(a, 'message/delete', { id: sentImage.data.id })).status, 200);
    assert.equal((await request(a, 'auth/login', { username: 'host', password: 'integration-test-password' })).status, 200);
    // Changing from guest to account already removed the old private history.
    assert.equal((await request(a, 'admin/remove-message', { id: literal.data.id })).status, 404);
    // A private message that reuses a public message's ID (from a conversation stored earlier) must not
    // shadow it: admin removal targets the public message and never touches the private one.
    const earlier = await request(c, 'message', privatePayload(c, b, 'opens the conversation first')); assert.equal(earlier.status, 200);
    const shadowRoom = (await request(a, 'admin/create', { name: 'Shadow test', description: '' })).data.id;
    const target = await request(b, 'message', { room: shadowRoom, text: 'Abusive public message' }); assert.equal(target.status, 200);
    const decoy = privatePayload(c, b, 'decoy'); decoy.id = target.data.id;
    decoy.encrypted = encryption.encryptMessage({ id: decoy.id, sender: c.me.id, recipient: b.me.id, text: 'decoy' }, c.identity, encryption.base64(b.identity.publicKey));
    assert.equal((await request(c, 'message', decoy)).status, 200);
    const removal = await request(a, 'admin/remove-message', { id: target.data.id });
    assert.equal(removal.status, 200); assert.equal(removal.data.room, shadowRoom);
    // Others see a removal notice instead of the text; it cannot be edited, deleted by its author or replied to.
    const notice = (await request(b, `history?room=${shadowRoom}`)).data.find(m => m.id === target.data.id);
    assert.equal(notice.removedBy, 'admin'); assert.equal(notice.text, ''); assert.equal(removal.data.notice.removedBy, 'admin');
    assert.equal((await request(b, 'message/edit', { id: target.data.id, editVersion: 1, text: 'restored' })).status, 404);
    assert.equal((await request(b, 'message/delete', { id: target.data.id })).status, 404);
    assert.equal((await request(b, 'message', { room: shadowRoom, text: 'reply', replyTo: target.data.id })).status, 400);
    // Removing the notice again deletes it entirely.
    assert.equal((await request(a, 'admin/remove-message', { id: target.data.id })).data.notice, undefined);
    assert.ok(!(await request(b, `history?room=${shadowRoom}`)).data.some(m => m.id === target.data.id));
    assert.ok((await request(b, `history?peer=${c.me.id}`)).data.some(m => m.id === target.data.id));
    // A multi-byte character split across request body chunks must arrive intact.
    const split = await new Promise((resolve, reject) => {
      const bytes = Buffer.from(JSON.stringify({ room: shadowRoom, text: 'split 👋 emoji' })), cut = bytes.indexOf(0xf0) + 2;
      const req = http.request(`${origin}/api/message`, { method: 'POST', headers: { Cookie: b.cookie, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': bytes.length } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve(JSON.parse(text)));
      });
      req.on('error', reject); req.write(bytes.subarray(0, cut)); setTimeout(() => req.end(bytes.subarray(cut)), 50);
    });
    assert.equal(split.text, 'split 👋 emoji');
    assert.equal((await fetch(imageURL, { headers: { Cookie: b.cookie } })).status, 404);
    await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(!ce.removals.includes(sentImage.data.id));
    assert.equal((await request(a, 'admin/ban', { id: c.me.id })).status, 200);
    assert.equal((await request(c, `history?room=${room}`)).status, 403);
    assert.equal((await request(c, 'session')).status, 403);
    assert.equal((await request(a, 'admin/state')).data.bans.some(ban => ban.id === c.me.id), true);
    assert.equal((await request(a, 'admin/unban', { id: c.me.id })).status, 200);
    const returned = await request(c, 'session'); assert.equal(returned.status, 200); assert.notEqual(returned.data.me.id, c.me.id);
    const creations = await Promise.all(['Reading room', 'Music room'].map(name => request(a, 'admin/create', { name, description: 'Come chat' })));
    assert.ok(creations.every(r => r.status === 200));
    assert.equal((await request(a, 'admin/create', { name: 'Reading room' })).status, 400);
    const remove = creations[0].data.id;
    assert.equal((await request(a, 'admin/delete', { id: remove })).status, 200);
    assert.equal((await request(a, 'message', { room: remove, text: 'gone' })).status, 404);
    assert.equal((await request(b, 'admin/delete', { id: room })).status, 403);
    const d = await visitor();
    assert.equal((await request(a, 'auth/login', { username: 'host', password: 'integration-test-password' })).status, 200);
    assert.equal((await request(a, 'admin/ban', { id: d.me.id })).status, 200);
    assert.equal((await request(a, 'groups/create', { name: 'Temporary room', access: 'open' })).status, 200);
    assert.equal((await request(a, 'groups')).data.length, 1);
    for (const s of streams) s.abort(); await stop(); await boot();
    const fresh = await visitor(); assert.ok(fresh.rooms.some(r => r.name === 'Music room')); assert.ok(!fresh.rooms.some(r => r.name === 'Reading room'));
    assert.deepEqual(fresh.groups, []);
    assert.equal((await request(d, 'session')).status, 403);
    assert.deepEqual((await request(fresh, `history?room=${room}`)).data, []);
    assert.equal((await request(a, `history?room=${room}`)).status, 401);
  } finally { for (const s of streams) s.abort(); await stop(); await rm(data, { recursive: true, force: true }); }
});
