import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import crypto from '../public/crypto.js';
import { Groups } from '../lib/groups.mjs';
import { Attachments } from '../lib/attachments.mjs';
import { Readable } from 'node:stream';

function setup() {
  let time = Date.now(); const events = [];
  const users = ['a', 'b', 'c', 'd'].map(alias => {
    const identity = nacl.box.keyPair(), signing = crypto.signingKeys(identity);
    return { id: randomUUID(), alias, identity, signing, publicKey: crypto.base64(identity.publicKey), signKey: crypto.base64(signing.publicKey), sent: [] };
  });
  const attachments = new Attachments({ now: () => time });
  const store = new Groups({ isAdmin: u => u.role === 'admin', attachments, now: () => time, emit: (u, event, data) => events.push({ user: u.id, event, data }), broadcast: () => {},
    safeUser: u => ({ id: u.id, alias: u.alias, displayAsAdmin: false }), findUser: id => users.find(u => u.id === id) });
  const call = (u, action, input = {}, method = 'POST') => store.handle(method, action, u, input);
  // Joining a discoverable room takes a request that the owner approves.
  const join = (u, group) => { call(u, 'request', { group }); const room = store.get(group); return call(room.members.get(room.owner).user, 'approve', { group, member: u.id }); };
  const send = (u, group, text = 'secret group sentinel', replyTo) => {
    const state = call(u, 'state', { group }, 'GET'), id = randomUUID();
    const shareable = Boolean(state.shareHistory);
    return { group, id, version: state.version, replyTo, ...(shareable ? { shareable } : {}),
      envelopes: crypto.encryptGroupMessage({ id, group, version: state.version, sender: u.id, text, replyTo, shareable }, u.identity, state.members, u.signing) };
  };
  return { store, attachments, users, events, call, join, send, advance: ms => { time += ms; } };
}

test('group attachments authenticate descriptors, isolate memberships and clean up with messages and rooms', async () => {
  const { store, attachments, users: [a,b,c], call, join, send, advance } = setup();
  const group = call(a, 'create', { name: 'Images' }).id; join(b, group);
  const plain = new TextEncoder().encode('private group attachment bytes'), encrypted = crypto.encryptAttachment(plain);
  async function upload(room = group, peer = null) {
    const version = store.get(room).version;
    return attachments.upload(Readable.from([encrypted.bytes]), a.id, peer, peer ? {} : { group: room, version });
  }
  function payload(id, room = group) {
    const state = call(a, 'state', { group: room }, 'GET'), mid = randomUUID();
    const file = { id, key: encrypted.key, nonce: encrypted.nonce, kind: 'image', type: 'image/webp', width: 1, height: 1, size: plain.length };
    return { id: mid, group: room, version: state.version, attachmentId: id,
      envelopes: crypto.encryptGroupMessage({ id: mid, group: room, version: state.version, sender: a.id, text: '', file }, a.identity, state.members) };
  }
  const first = await upload();
  assert.throws(() => attachments.get(first.id, b.id), /unavailable/);
  const imagePayload = payload(first.id), message = call(a, 'message', imagePayload);
  assert.equal(call(a, 'message', imagePayload).id, message.id);
  const received = call(b, 'history', { group }, 'GET')[0];
  const decoded = crypto.decryptGroupMessage(received, b.id, b.identity, a.publicKey);
  assert.equal(decoded.text, '');
  assert.deepEqual(crypto.decryptAttachment(attachments.get(first.id, b.id).bytes, decoded.file), plain);
  assert.throws(() => crypto.decryptGroupMessage({ ...received, attachment: { id: 'substituted' } }, b.id, b.identity, a.publicKey), /metadata/);
  assert.throws(() => crypto.decryptGroupMessage({ ...received, attachment: null }, b.id, b.identity, a.publicKey), /metadata/);
  assert.throws(() => attachments.get(first.id, c.id), /unavailable/);
  join(c, group); assert.throws(() => store.checkAttachment(attachments.items.get(first.id), c), /unavailable/);
  call(a, 'kick', { group, member: b.id }); assert.throws(() => store.checkAttachment(attachments.items.get(first.id), b), /unavailable/);
  call(a, 'message-delete', { group, id: message.id }); assert.equal(attachments.items.has(first.id), false);
  const otherRoom = call(a, 'create', { name: 'Other' }).id;
  const uploadOther = await upload(otherRoom);
  assert.throws(() => call(a, 'message', payload(uploadOther.id)), /Invalid attachment/);
  const dm = await upload(group, c.id);
  assert.throws(() => call(a, 'message', payload(dm.id)), /Invalid attachment/);
  const pending = await upload();
  assert.throws(() => attachments.claim(pending.id, a.id, null, randomUUID()), /Invalid/);
  call(c, 'leave', { group }); join(c, group);
  assert.throws(() => call(a, 'message', payload(pending.id)), /membership changed/);
  const published = await upload(); const posted = call(a, 'message', payload(published.id));
  call(c, 'leave', { group }); join(c, group);
  assert.throws(() => store.checkAttachment(attachments.items.get(published.id), c), /unavailable/);
  // Evicting a message also removes its encrypted attachment bytes.
  for (let i = 0; i < 100; i++) { advance(10001); call(a, 'message', send(a, group)); }
  assert.ok(!store.get(group).history.some(m => m.id === posted.id)); assert.equal(attachments.items.has(published.id), false);
  const finalUpload = await upload(); call(a, 'message', payload(finalUpload.id));
  call(a, 'delete', { group });
  assert.equal(attachments.items.has(finalUpload.id), false); assert.equal(attachments.items.has(pending.id), false);
  const expiring = await upload(otherRoom); call(a, 'message', payload(expiring.id, otherRoom));
  advance(86400000); assert.throws(() => attachments.get(expiring.id, a.id), /unavailable/);
});
test('temporary encrypted rooms enforce invitation, ownership, membership versions, counts and deletion', () => {
  const { store, users: [a,b,c,d], events, call, join, send } = setup();
  const room = call(a, 'create', { name: 'Test room', description: 'Description', rules: 'Be kind', access: 'invite' });
  const group = room.id;
  assert.equal(room.owner, a.id); assert.equal(room.rules, 'Be kind');
  assert.deepEqual(call(b, '', {}, 'GET'), []);
  assert.throws(() => call(b, 'join', { group }), /invitation/);
  assert.throws(() => call(b, 'state', { group }, 'GET'), /Join/);
  assert.throws(() => call(b, 'history', { group }, 'GET'), /Join/);
  assert.throws(() => call(a, 'message', { group, text: 'plaintext' }), /ciphertext/);
  const early = call(a, 'message', send(a, group, 'before anyone joined'));
  call(a, 'invite', { group, member: b.id });
  assert.equal(call(b, '', {}, 'GET')[0].invited, true);
  const stale = send(a, group);
  call(b, 'join', { group });
  assert.throws(() => call(a, 'message', stale), /Membership changed/);
  assert.deepEqual(call(b, 'history', { group }, 'GET'), []);
  assert.throws(() => call(b, 'message', send(b, group, 'quote hidden history', early.id)), /reply/);
  assert.throws(() => call(b, 'update', { group, name: 'stolen' }), /owner/);
  assert.throws(() => call(b, 'delete', { group }), /owner/);
  assert.throws(() => call(b, 'transfer', { group, member: b.id }), /owner/);
  assert.throws(() => call(b, 'kick', { group, member: a.id }), /owner/);
  assert.throws(() => call(b, 'invite', { group, member: c.id }), /owner/);
  const payload = send(a, group), message = call(a, 'message', payload);
  assert.ok(!JSON.stringify(message).includes('secret group sentinel'));
  assert.equal(message.envelopes, undefined);
  const delivered = events.find(e => e.user === b.id && e.event === 'message' && e.data.id === message.id).data;
  assert.equal(crypto.decryptGroupMessage(delivered, b.id, b.identity, a.publicKey).text, 'secret group sentinel');
  assert.equal(crypto.decryptGroupMessage(message, a.id, a.identity, a.publicKey).text, 'secret group sentinel');
  assert.ok(!events.some(e => e.user === c.id && e.event === 'message'));
  assert.equal(call(a, 'message', payload).id, message.id);
  assert.equal(call(a, 'state', { group }, 'GET').members.find(m => m.id === a.id).messages, 2);
  assert.ok(call(b, 'state', { group }, 'GET').members.every(m => !Object.hasOwn(m, 'messages')));
  assert.throws(() => call(b, 'message-delete', { group, id: message.id }), /sender, the room owner/);
  const reply = call(b, 'message', send(b, group, 'reply', message.id));
  call(a, 'message-delete', { group, id: message.id });
  const history = call(b, 'history', { group }, 'GET');
  assert.equal(history.find(m => m.id === reply.id).reply.removed, true);
  assert.equal(crypto.decryptGroupMessage(history.find(m => m.id === reply.id), b.id, b.identity, b.publicKey).text, 'reply');
  assert.equal(call(a, 'state', { group }, 'GET').members.find(m => m.id === a.id).messages, 2);
  call(a, 'update', { group, name: 'Open now', description: 'Changed', rules: 'New rules', access: 'open' });
  assert.equal(call(c, '', {}, 'GET')[0].name, 'Open now');
  join(c, group);
  assert.deepEqual(call(c, 'history', { group }, 'GET'), []);
  assert.throws(() => call(a, 'leave', { group }), /Transfer/);
  const beforeKick = send(b, group);
  call(a, 'transfer', { group, member: b.id });
  assert.throws(() => call(a, 'kick', { group, member: c.id }), /owner/);
  call(b, 'ban', { group, member: c.id });
  assert.throws(() => call(b, 'message', beforeKick), /Membership changed/);
  assert.throws(() => call(c, 'join', { group }), /cannot rejoin/);
  assert.throws(() => call(c, 'history', { group }, 'GET'), /Join/);
  assert.throws(() => call(c, 'message', { group }), /Join/);
  const next = send(b, group); assert.equal(next.envelopes[c.id], undefined);
  const afterKick = call(b, 'message', next);
  assert.ok(!events.some(e => e.user === c.id && e.event === 'message' && e.data.id === afterKick.id));
  assert.throws(() => crypto.decryptGroupMessage(afterKick, c.id, c.identity, b.publicKey), /authenticated/);
  assert.throws(() => call(d, 'message-delete', { group, id: afterKick.id }), /Join/);
  call(b, 'delete', { group });
  assert.equal(store.bytes, 0); assert.equal(store.rooms.size, 0);
  assert.throws(() => call(a, 'history', { group }, 'GET'), /expired or was deleted/);
});

test('group encryption binds sender, recipient, room, message, reply and membership version', () => {
  const { users: [a,b,c], call, join, send } = setup();
  const group = call(a, 'create', { name: 'Group' }).id; join(b, group);
  const payload = send(a, group), message = call(a, 'message', payload);
  const received = { ...message, encrypted: payload.envelopes[b.id] };
  for (const change of [{ group: 'different' }, { id: 'different' }, { sender: b.id }, { version: 999 }, { reply: { id: 'fake' } }]) {
    assert.throws(() => crypto.decryptGroupMessage({ ...received, ...change }, b.id, b.identity, a.publicKey), /metadata/);
  }
  assert.throws(() => crypto.decryptGroupMessage(received, c.id, b.identity, a.publicKey), /metadata/);
  assert.throws(() => crypto.decryptGroupMessage(received, b.id, b.identity, c.publicKey), /authenticated/);
  const bytes = crypto.unbase64(received.encrypted.ciphertext); bytes[0] ^= 1;
  assert.throws(() => crypto.decryptGroupMessage({ ...received, encrypted: { ...received.encrypted, ciphertext: crypto.base64(bytes) } }, b.id, b.identity, a.publicKey), /authenticated/);
  assert.notEqual(payload.envelopes[a.id].nonce, payload.envelopes[b.id].nonce);
});

test('temporary rooms expire, clean up removed users, and enforce limits and complete recipient sets', () => {
  const { store, users: [a,b,c], call, join, send, advance } = setup();
  const group = call(a, 'create', { name: 'Temporary' }).id;
  join(b, group);
  const earlier = call(a, 'message', send(a, group));
  call(b, 'leave', { group }); join(b, group);
  assert.deepEqual(call(b, 'history', { group }, 'GET'), []);
  assert.throws(() => call(b, 'message', send(b, group, 'quote prior membership', earlier.id)), /reply/);
  const missing = send(a, group); delete missing.envelopes[b.id];
  assert.throws(() => call(a, 'message', missing), /every current member/);
  const extra = send(a, group); extra.envelopes[c.id] = extra.envelopes[b.id];
  assert.throws(() => call(a, 'message', extra), /every current member/);
  call(a, 'message', send(a, group));
  store.removeUser(a.id);
  assert.equal(call(b, 'state', { group }, 'GET').owner, b.id);
  store.removeUser(b.id); assert.equal(store.rooms.size, 0); assert.equal(store.bytes, 0);
  const expires = call(c, 'create', { name: 'Expires' });
  advance(24 * 3600000);
  assert.throws(() => call(c, 'state', { group: expires.id }, 'GET'), /expired/);
  for (let i = 0; i < 3; i++) call(a, 'create', { name: `Room ${i}` });
  assert.throws(() => call(a, 'create', { name: 'Fourth' }), /Limit/);
  assert.throws(() => call(c, 'create', { name: '', rules: 'x'.repeat(2001) }), /40 characters/);
  assert.throws(() => call({ ...c, publicKey: undefined }, 'create', { name: 'Unsafe' }), /encryption/);
});


test('admin room moderation preserves encryption boundaries and cleans up deleted rooms', async () => {
  const { store, attachments, users: [owner, admin], call, join, send, events, advance } = setup();
  const room = call(owner, 'create', { name: 'Private room', access: 'invite' });
  assert.throws(() => store.moderate('list', admin), /Unlock/);
  admin.role = 'admin';
  const message = call(owner, 'message', send(owner, room.id));
  const upload = await attachments.upload(Readable.from([new Uint8Array(32)]), owner.id, null, { group: room.id, version: room.version });
  assert.equal(store.moderate('list', admin)[0].id, room.id);
  for (const invalid of [{ name: '' }, { name: 'x'.repeat(41) }, { description: 'x'.repeat(121) }, { rules: 'x'.repeat(2001) }]) {
    assert.throws(() => store.moderate('update', admin, { group: room.id, name: 'Valid', ...invalid }), /Use a name|Choose open/);
  }
  for (const access of ['open', 'invalid']) assert.throws(() => store.moderate('update', admin, { group: room.id, name: 'Valid', access }), /Only the room owner/);
  assert.equal(store.get(room.id).access, 'invite');
  assert.throws(() => call(admin, 'join', { group: room.id }), /invitation/);
  const changed = store.moderate('update', admin, { group: room.id, name: 'Updated', rules: 'Rules', access: 'invite' });
  assert.equal(changed.owner, owner.id); assert.equal(changed.version, room.version);
  assert.equal(changed.joined, false); assert.equal(changed.count, 1);
  assert.equal(changed.history, undefined); assert.equal(changed.members, undefined);
  assert.throws(() => call(admin, 'history', { group: room.id }, 'GET'), /Join/);
  assert.equal(call(owner, 'history', { group: room.id }, 'GET')[0].id, message.id);
  assert.ok(events.some(e => e.user === owner.id && e.event === 'group-state' && e.data.name === 'Updated'));
  advance(3600001);
  assert.equal(store.moderate('list', admin)[0].id, room.id);
  admin.role = 'member';
  assert.throws(() => store.moderate('update', admin, { group: room.id, name: 'Expired admin' }), /Unlock/);
  assert.throws(() => store.moderate('delete', admin, { group: room.id }), /Unlock/);
  admin.role = 'admin';
  store.moderate('delete', admin, { group: room.id });
  assert.equal(store.bytes, 0); assert.equal(attachments.items.has(upload.id), false);
  assert.ok(events.some(e => e.user === owner.id && e.event === 'group-removed'));
  assert.throws(() => store.get(room.id), /expired or was deleted/);
});


test('editing group messages preserves original audience, ownership, replies, counts and byte accounting', () => {
  const { store, users: [a,b,c], events, call, join, send, advance } = setup();
  const room = call(a, 'create', { name: 'Edit room' }), group = room.id;
  join(b, group);
  const message = call(a, 'message', send(a, group, 'Before'));
  const edit = (text, editVersion = 1) => {
    const state = call(a, 'message-edit-state', { group, id: message.id }, 'GET');
    return { group, id: message.id, membershipVersion: state.membershipVersion, editVersion,
      envelopes: crypto.encryptGroupMessage({ id: message.id, group, version: message.version, sender: a.id, text, editVersion }, a.identity, state.members) };
  };
  assert.throws(() => call(b, 'message-edit-state', { group, id: message.id }, 'GET'), /Your message/);
  assert.throws(() => call(b, 'message-edit', edit('Stolen')), /Your message/);
  const stale = edit('Before join'); join(c, group);
  assert.throws(() => call(a, 'message-edit', stale), /Membership changed/);
  const valid = edit('After edit');
  assert.deepEqual(Object.keys(valid.envelopes).sort(), [a.id,b.id].sort());
  assert.throws(() => call(a, 'message-edit', { ...valid, text: 'plaintext' }), /ciphertext/);
  assert.throws(() => call(a, 'message-edit', { ...valid, envelopes: { ...valid.envelopes, [c.id]: valid.envelopes[a.id] } }), /original recipients/);
  const updated = call(a, 'message-edit', valid);
  assert.equal(updated.time, message.time); assert.equal(updated.editVersion, 1); assert.ok(updated.editedAt);
  assert.equal(crypto.decryptGroupMessage(updated, a.id, a.identity, a.publicKey).text, 'After edit');
  assert.throws(() => crypto.decryptGroupMessage({ ...updated, editVersion: 0 }, a.id, a.identity, a.publicKey), /metadata/);
  assert.deepEqual(call(c, 'history', { group }, 'GET'), []);
  assert.ok(!events.some(e => e.user === c.id && e.event === 'message-edited'));
  assert.ok(events.some(e => e.user === b.id && e.event === 'message-edited'));
  assert.equal(call(a, 'state', { group }, 'GET').members.find(m => m.id === a.id).messages, 1);
  assert.throws(() => call(a, 'message-edit', valid), /message changed/);
  call(a, 'kick', { group, member: b.id });
  const afterKick = edit('After kick', 2); assert.deepEqual(Object.keys(afterKick.envelopes), [a.id]);
  call(a, 'message-edit', afterKick);
  assert.equal(store.bytes, store.get(group).bytes);
  assert.equal(store.bytes, store.get(group).history.reduce((sum,m) => sum + m.bytes, 0));
  call(a, 'message-delete', { group, id: message.id }); assert.equal(store.bytes, 0);
  assert.throws(() => call(a, 'message-edit', afterKick), /Your message/);
  advance(10001);
});

test('room moderators manage regular members only and inherit ownership before members', () => {
  const { store, users: [a,b,c,d], call, join, send } = setup();
  const group = call(a, 'create', { name: 'Moderated' }).id;
  for (const u of [b, c, d]) join(u, group);
  assert.throws(() => call(b, 'promote', { group, member: c.id }), /owner/);
  call(a, 'promote', { group, member: b.id }); call(a, 'promote', { group, member: d.id });
  const state = call(c, 'state', { group }, 'GET');
  assert.equal(state.members.find(m => m.id === b.id).role, 'moderator');
  assert.equal(state.links, undefined); assert.equal(state.banned, undefined);
  assert.ok(Array.isArray(call(b, 'state', { group }, 'GET').links));
  assert.equal(call(b, 'state', { group }, 'GET').members.find(m => m.id === c.id).messages, 0);
  assert.throws(() => call(b, 'kick', { group, member: a.id }), /regular members/);
  assert.throws(() => call(b, 'kick', { group, member: d.id }), /regular members/);
  assert.throws(() => call(b, 'update', { group, name: 'Mod rename' }), /owner/);
  assert.throws(() => call(b, 'promote', { group, member: c.id }), /owner/);
  assert.throws(() => call(b, 'delete', { group }), /owner/);
  const fromOwner = call(a, 'message', send(a, group)), fromMember = call(c, 'message', send(c, group));
  assert.throws(() => call(b, 'message-delete', { group, id: fromOwner.id }), /moderator/);
  call(b, 'message-delete', { group, id: fromMember.id });
  call(a, 'demote', { group, member: d.id });
  assert.throws(() => call(d, 'kick', { group, member: c.id }), /owner or a moderator/);
  call(b, 'kick', { group, member: c.id });
  assert.equal(store.get(group).members.has(c.id), false);
  store.removeUser(a.id);
  assert.equal(store.get(group).owner, b.id);
  assert.equal(store.get(group).moderators.has(b.id), false);
});

test('kicks allow rejoining, bans block it until unbanned, and invite-only kicks drop the invitation', () => {
  const { users: [a,b,c], call, join } = setup();
  const group = call(a, 'create', { name: 'Kick vs ban' }).id;
  join(b, group); call(a, 'kick', { group, member: b.id });
  join(b, group);
  call(a, 'ban', { group, member: b.id });
  assert.equal(call(b, '', {}, 'GET')[0].blocked, true);
  assert.throws(() => call(b, 'join', { group }), /cannot rejoin/);
  assert.throws(() => call(a, 'invite', { group, member: b.id }), /banned/);
  assert.deepEqual(call(a, 'state', { group }, 'GET').banned.map(x => x.alias), ['b']);
  call(a, 'unban', { group, member: b.id });
  assert.throws(() => call(a, 'unban', { group, member: b.id }), /not banned/);
  join(b, group);
  const closed = call(a, 'create', { name: 'Closed', access: 'invite' }).id;
  call(a, 'invite', { group: closed, member: c.id }); call(c, 'join', { group: closed });
  call(a, 'kick', { group: closed, member: c.id });
  assert.throws(() => call(c, 'join', { group: closed }), /invitation/);
});

test('mutes, slow mode and staff-only posting are enforced by the server', () => {
  const { users: [a,b,c], call, join, send, advance } = setup();
  const group = call(a, 'create', { name: 'Quiet' }).id;
  join(b, group); join(c, group); call(a, 'promote', { group, member: c.id });
  const before = call(b, 'message', send(b, group, 'before mute'));
  assert.throws(() => call(a, 'mute', { group, member: b.id, minutes: 7 }), /listed/);
  call(a, 'mute', { group, member: b.id, minutes: 5 });
  assert.equal(call(b, 'state', { group }, 'GET').members.find(m => m.id === b.id).muted, true);
  assert.throws(() => call(b, 'message', send(b, group)), /muted/);
  const editState = call(b, 'message-edit-state', { group, id: before.id }, 'GET');
  const edit = { group, id: before.id, membershipVersion: editState.membershipVersion, editVersion: 1,
    envelopes: crypto.encryptGroupMessage({ id: before.id, group, version: before.version, sender: b.id, text: 'edited', editVersion: 1 }, b.identity, editState.members) };
  assert.throws(() => call(b, 'message-edit', edit), /muted/);
  // Leaving and rejoining does not clear a mute.
  call(b, 'leave', { group }); join(b, group);
  assert.throws(() => call(b, 'message', send(b, group)), /muted/);
  advance(5 * 60000 + 1);
  call(b, 'message', send(b, group));
  call(c, 'mute', { group, member: b.id, minutes: 0 });
  advance(2 * 3600000);
  assert.throws(() => call(b, 'message', send(b, group)), /until a moderator unmutes/);
  call(c, 'unmute', { group, member: b.id });
  call(a, 'update', { group, name: 'Quiet', slowMode: 30 });
  call(b, 'message', send(b, group));
  assert.throws(() => call(b, 'message', send(b, group)), /Slow mode/);
  call(c, 'message', send(c, group)); call(c, 'message', send(c, group));
  advance(30001); call(b, 'message', send(b, group));
  call(a, 'update', { group, name: 'Quiet', readOnly: true });
  assert.equal(call(a, 'state', { group }, 'GET').slowMode, 30);
  advance(30001);
  assert.throws(() => call(b, 'message', send(b, group)), /owner and moderators/);
  call(c, 'message', send(c, group));
});

test('discoverable rooms need an approved request; hidden rooms only invitations or links', () => {
  const { store, users: [a,b,c,d], events, call, advance } = setup();
  const open = call(a, 'create', { name: 'Discoverable' }).id, hidden = call(a, 'create', { name: 'Hidden', access: 'invite' }).id;
  assert.throws(() => call(b, 'join', { group: open }), /Ask to join/);
  assert.throws(() => call(b, 'request', { group: hidden }), /invitation/);
  assert.equal(call(b, 'request', { group: open }).requested, true);
  assert.equal(call(b, 'request', { group: open }).requested, true);
  assert.equal(call(a, '', {}, 'GET').find(g => g.id === open).requests, 1);
  assert.equal(call(c, '', {}, 'GET').find(g => g.id === open).requests, undefined);
  assert.throws(() => call(b, 'state', { group: open }, 'GET'), /Join/);
  call(c, 'request', { group: open });
  call(a, 'decline', { group: open, member: c.id });
  assert.ok(events.some(e => e.user === c.id && e.event === 'group-request' && e.data.approved === false));
  assert.throws(() => call(a, 'approve', { group: open, member: c.id }), /no longer pending/);
  // A declined person waits before asking again, and asking or withdrawing too often is limited.
  assert.throws(() => call(c, 'request', { group: open }), /declined/);
  advance(10 * 60000 + 1);
  for (let i = 0; i < 3; i++) { call(c, 'request', { group: open }); call(c, 'request-cancel', { group: open }); }
  assert.throws(() => call(c, 'request', { group: open }), /Try again in a minute/);
  advance(60001);
  call(a, 'approve', { group: open, member: b.id });
  assert.ok(events.some(e => e.user === b.id && e.event === 'group-request' && e.data.approved === true));
  assert.equal(call(b, 'state', { group: open }, 'GET').joined, true);
  // Moderators decide too, while regular members cannot.
  call(d, 'request', { group: open });
  assert.throws(() => call(b, 'approve', { group: open, member: d.id }), /owner or a moderator/);
  call(a, 'promote', { group: open, member: b.id });
  call(b, 'approve', { group: open, member: d.id });
  // A withdrawn request disappears; banned people cannot ask again; locked rooms refuse requests.
  call(c, 'request', { group: open }); call(c, 'request-cancel', { group: open });
  assert.equal(store.get(open).requests.size, 0);
  call(a, 'kick', { group: open, member: d.id }); call(d, 'request', { group: open });
  call(a, 'ban', { group: open, member: b.id });
  assert.throws(() => call(b, 'request', { group: open }), /banned/);
  call(a, 'update', { group: open, name: 'Discoverable', locked: true });
  assert.throws(() => call(a, 'approve', { group: open, member: d.id }), /locked/);
  assert.throws(() => call(c, 'request', { group: open }), /locked/);
  // Leaving the site clears pending requests.
  store.removeUser(d.id); assert.equal(store.get(open).requests.size, 0);
});

test('room settings validate, limit and lock joins, and shorten room lifetime', () => {
  const { store, users: [a,b,c,d], call, join, advance } = setup();
  for (const invalid of [{ limit: 1 }, { limit: 21 }, { limit: '5' }, { slowMode: 7 }, { lifetime: 48 }, { disappear: 1 }, { locked: 'yes' }])
    assert.throws(() => call(a, 'create', { name: 'Bad', ...invalid }), /setting|limit/);
  const room = call(a, 'create', { name: 'Small', limit: 2, lifetime: 1 });
  assert.equal(room.expiresAt, store.get(room.id).updated + 3600000);
  join(b, room.id);
  assert.throws(() => call(c, 'request', { group: room.id }), /full \(2 members\)/);
  call(a, 'update', { group: room.id, name: 'Small', limit: 4, locked: true });
  assert.equal(store.get(room.id).lifetime, 1);
  assert.throws(() => call(c, 'request', { group: room.id }), /locked/);
  call(a, 'update', { group: room.id, name: 'Small', locked: false });
  join(c, room.id);
  advance(3600000);
  assert.throws(() => call(d, 'join', { group: room.id }), /expired/);
});

test('invite links admit people to invite-only rooms within their expiry and use limits', () => {
  const { users: [a,b,c,d], call, join, advance } = setup();
  const group = call(a, 'create', { name: 'Linked', access: 'invite' }).id;
  assert.throws(() => call(a, 'link-create', { group, hours: 2, uses: 1 }), /listed/);
  const token = call(a, 'link-create', { group, hours: 1, uses: 1 }).links[0].token;
  assert.ok(token.length >= 20);
  assert.throws(() => call(b, 'invite-preview', { group }, 'GET'), /invalid or has expired/);
  assert.throws(() => call(b, 'invite-preview', { group, invite: 'wrong' }, 'GET'), /invalid or has expired/);
  const preview = call(b, 'invite-preview', { group, invite: token }, 'GET');
  assert.equal(preview.name, 'Linked'); assert.equal(preview.members, undefined); assert.equal(preview.owner, undefined);
  assert.throws(() => call(b, 'join', { group }), /invitation/);
  call(b, 'join', { group, invite: token });
  assert.throws(() => call(c, 'join', { group, invite: token }), /invalid or has expired/);
  assert.deepEqual(call(a, 'state', { group }, 'GET').links, []);
  const reusable = call(a, 'link-create', { group, hours: 1, uses: 0 }).links[0].token;
  call(a, 'ban', { group, member: b.id });
  assert.throws(() => call(b, 'join', { group, invite: reusable }), /banned/);
  call(a, 'update', { group, name: 'Linked', access: 'invite', locked: true });
  assert.throws(() => call(c, 'join', { group, invite: reusable }), /locked/);
  call(a, 'update', { group, name: 'Linked', access: 'invite', locked: false });
  call(c, 'join', { group, invite: reusable });
  assert.equal(call(a, 'state', { group }, 'GET').links[0].uses, 1);
  call(a, 'link-revoke', { group, token: reusable });
  assert.throws(() => call(d, 'join', { group, invite: reusable }), /invalid or has expired/);
  for (let i = 0; i < 10; i++) call(a, 'link-create', { group, hours: 1, uses: 5 });
  assert.throws(() => call(a, 'link-create', { group, hours: 1, uses: 5 }), /Revoke/);
  advance(3600001);
  assert.equal(call(a, 'state', { group }, 'GET').links.length, 0);
});

test('disappearing messages are removed for everyone and from history', () => {
  const { store, users: [a,b], events, call, join, send, advance } = setup();
  const group = call(a, 'create', { name: 'Fleeting', disappear: 5 }).id;
  join(b, group);
  const old = call(a, 'message', send(a, group));
  advance(4 * 60000); const recent = call(b, 'message', send(b, group));
  advance(60001);
  assert.deepEqual(call(b, 'history', { group }, 'GET').map(m => m.id), [recent.id]);
  assert.ok(events.some(e => e.user === b.id && e.event === 'message-removed' && e.data.id === old.id));
  advance(4 * 60000); store.sweep();
  assert.equal(store.get(group).history.length, 0); assert.equal(store.bytes, 0);
});

test('history sharing lets later members read messages sent while it was on, verified by the author signature', async () => {
  const { store, attachments, users: [a,b,c,d], events, call, join, send } = setup();
  const open = (m, u) => m.shared ? crypto.decryptGroupShare(m, u.id, u.identity, m.shared.sharerKey, m.senderSignKey) : crypto.decryptGroupMessage(m, u.id, u.identity, m.senderKey, m.senderSignKey);
  // What a member's browser does: re-encrypt every message it can read for the members who cannot.
  const shareFrom = (sharer, group) => {
    const work = call(sharer, 'history-share-state', { group }, 'GET');
    const views = new Map(call(sharer, 'history', { group }, 'GET').map(m => [m.id, m])), keys = new Map(work.members.map(m => [m.id, m]));
    const shares = work.messages.flatMap(item => {
      const view = views.get(item.id), plain = open(view, sharer);
      return item.members.map(id => ({ id: item.id, member: id, encrypted: crypto.encryptGroupShare(view, plain, plain.history, sharer.id, sharer.identity, keys.get(id)) }));
    });
    return call(sharer, 'history-share', { group, shares });
  };
  const consistent = group => { assert.equal(store.bytes, store.get(group).bytes); assert.equal(store.bytes, store.get(group).history.reduce((sum, m) => sum + m.bytes, 0)); };
  const group = call(a, 'create', { name: 'Shared' }).id; join(b, group);
  const before = call(a, 'message', send(a, group, 'before sharing'));
  assert.throws(() => call(a, 'create', { name: 'Bad', shareHistory: 'yes' }), /setting/);
  call(a, 'update', { group, name: 'Shared', shareHistory: true });
  const unflagged = send(a, group, 'unflagged'); delete unflagged.shareable;
  assert.throws(() => call(a, 'message', unflagged), /history setting changed/);
  assert.throws(() => call({ ...a, signKey: undefined }, 'message', send(a, group)), /Reload/);
  const m1 = call(a, 'message', send(a, group, 'shared hello'));
  assert.equal(m1.shareable, true); assert.equal(m1.senderSignKey, a.signKey); assert.equal(m1.shares, undefined);
  const m2 = call(b, 'message', send(b, group, 'reply from b', m1.id));
  // Original recipients check the signature and the shareable flag.
  assert.equal(open(m1, a).text, 'shared hello');
  assert.throws(() => crypto.decryptGroupMessage(m1, a.id, a.identity, a.publicKey, c.signKey), /could not be verified/);
  assert.throws(() => crypto.decryptGroupMessage({ ...m1, shareable: false }, a.id, a.identity, a.publicKey, a.signKey), /metadata/);
  assert.throws(() => crypto.decryptGroupMessage({ ...before, shareable: true }, a.id, a.identity, a.publicKey, a.signKey), /metadata/);

  join(c, group);
  assert.equal(call(c, 'state', { group }, 'GET').pendingHistory, true);
  assert.deepEqual(call(c, 'history', { group }, 'GET'), []);
  assert.deepEqual(call(c, 'history-share-state', { group }, 'GET').messages, []);
  const work = call(b, 'history-share-state', { group }, 'GET');
  assert.deepEqual(work.messages.map(m => m.id), [m1.id, m2.id]); assert.deepEqual(work.members.map(m => m.id), [c.id]);
  assert.throws(() => call(b, 'history-share', { group, shares: [{ id: before.id, member: c.id, encrypted: m1.encrypted }] }), /sent while sharing was on/);
  assert.throws(() => call(c, 'history-share', { group, shares: [{ id: m1.id, member: c.id, encrypted: m1.encrypted }] }), /you can read/);
  assert.throws(() => call(b, 'history-share', { group, shares: [{ id: m1.id, member: c.id, encrypted: m1.encrypted, text: 'plain' }] }), /Invalid/);

  // A member who changes the text cannot produce a valid author signature.
  const plain = open(call(b, 'history', { group }, 'GET').find(m => m.id === m1.id), b);
  const forged = crypto.encryptGroupShare(m1, { ...plain, text: 'forged' }, plain.history, b.id, b.identity, c);
  const view = { ...m1, encrypted: undefined, shared: { by: b.id, sharerKey: b.publicKey, encrypted: forged } };
  assert.throws(() => crypto.decryptGroupShare(view, c.id, c.identity, b.publicKey, a.signKey), /could not be verified/);
  assert.throws(() => crypto.decryptGroupShare({ ...view, shared: { ...view.shared, by: a.id } }, c.id, c.identity, b.publicKey, a.signKey), /metadata/);

  assert.equal(shareFrom(b, group).stored, 2);
  assert.equal(shareFrom(a, group).stored, 0);
  assert.ok(events.some(e => e.user === c.id && e.event === 'history-shared'));
  assert.equal(call(c, 'state', { group }, 'GET').pendingHistory, false);
  const seen = call(c, 'history', { group }, 'GET');
  assert.deepEqual(seen.map(m => open(m, c).text), ['shared hello', 'reply from b']);
  assert.ok(seen.every(m => m.shared?.by === b.id && m.encrypted === undefined && m.shares === undefined));
  assert.ok(!JSON.stringify(call(b, 'history', { group }, 'GET')).includes(c.id));
  call(c, 'message', send(c, group, 'replying to history', m1.id));
  consistent(group);

  // Edits replace shared copies, which members then share again.
  const editState = call(a, 'message-edit-state', { group, id: m1.id }, 'GET');
  assert.deepEqual(editState.members.map(m => m.id).sort(), [a.id, b.id].sort());
  call(a, 'message-edit', { group, id: m1.id, membershipVersion: editState.membershipVersion, editVersion: 1,
    envelopes: crypto.encryptGroupMessage({ id: m1.id, group, version: m1.version, sender: a.id, text: 'edited hello', editVersion: 1, shareable: true }, a.identity, editState.members, a.signing) });
  assert.equal(call(c, 'state', { group }, 'GET').pendingHistory, true);
  assert.ok(!call(c, 'history', { group }, 'GET').some(m => m.id === m1.id));
  shareFrom(a, group);
  assert.equal(open(call(c, 'history', { group }, 'GET').find(m => m.id === m1.id), c).text, 'edited hello');
  consistent(group);

  // Shared attachments become downloadable for the later member.
  const upload = await attachments.upload(Readable.from([new Uint8Array(64)]), a.id, null, { group, version: store.get(group).version });
  const file = { id: upload.id, kind: 'file', type: 'application/octet-stream', size: 48, key: crypto.base64(nacl.randomBytes(32)), nonce: crypto.base64(nacl.randomBytes(24)), name: 'notes.bin' };
  const state = call(a, 'state', { group }, 'GET'), fileId = randomUUID();
  call(a, 'message', { group, id: fileId, version: state.version, attachmentId: upload.id, shareable: true,
    envelopes: crypto.encryptGroupMessage({ id: fileId, group, version: state.version, sender: a.id, text: '', file, shareable: true }, a.identity, state.members, a.signing) });
  join(d, group);
  assert.throws(() => attachments.get(upload.id, d.id), /unavailable/);
  shareFrom(c, group);
  assert.deepEqual(open(call(d, 'history', { group }, 'GET').find(m => m.id === fileId), d).file, file);
  store.checkAttachment(attachments.get(upload.id, d.id), d);

  // Leaving drops a member's shared copies; rejoining makes them pending again.
  call(d, 'leave', { group }); consistent(group);
  assert.ok(store.get(group).history.every(m => !m.shares || !Object.hasOwn(m.shares, d.id)));
  assert.throws(() => store.checkAttachment(attachments.items.get(upload.id), d), /unavailable/);
  join(d, group);
  assert.equal(call(d, 'state', { group }, 'GET').pendingHistory, true);
  // Turning sharing off keeps earlier shareable messages shareable but stops new ones.
  call(a, 'update', { group, name: 'Shared', shareHistory: false });
  const after = call(a, 'message', send(a, group, 'after sharing'));
  assert.equal(after.shareable, undefined);
  shareFrom(b, group);
  assert.deepEqual(call(d, 'history', { group }, 'GET').map(m => m.id), [m1.id, m2.id, call(c, 'history', { group }, 'GET')[2].id, fileId, after.id]);
  consistent(group);
});

test('members who are away leave their rooms, hand over ownership and keep room bans', () => {
  const { store, users: [a, b, c], call, join } = setup();
  const group = call(a, 'create', { name: 'Away' }).id;
  join(b, group); join(c, group);
  call(a, 'ban', { group, member: c.id });
  const solo = call(a, 'create', { name: 'Solo' }).id;
  store.leaveAll(a.id);
  assert.equal(store.get(group).owner, b.id);
  assert.equal(store.get(group).members.has(a.id), false);
  assert.equal(store.rooms.has(solo), false, 'a room emptied by leaving is removed');
  assert.ok(store.get(group).banned.has(c.id));
  assert.throws(() => call(c, 'join', { group }), /banned/);
});
