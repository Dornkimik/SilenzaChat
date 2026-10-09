import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { AntiSpam, fold, obfuscation, destinations, randomToken, signature, similarity } from '../lib/antispam.mjs';

test('disguised text folds to the same skeleton', () => {
  const plain = fold('free crypto').skeleton;
  for (const disguised of ['FREE CRYPTO', 'frее сrурtо', '𝐟𝐫𝐞𝐞 𝐜𝐫𝐲𝐩𝐭𝐨', 'ｆｒｅｅ ｃｒｙｐｔｏ', '🅵🆁🅴🅴 🅲🆁🆈🅿🆃🅾', 'fr​ee cr‍ypto',
    'f r e e  c r y p t o', 'f.r.e.e c-r-y-p-t-o', 'fr33 crypt0', 'frèé ćrÿptö', 'f̷r̸e̵e̶ crypto', 'freeeeee cryyyypto', 'ꜰʀᴇᴇ ᴄʀʏᴘᴛᴏ'.replace('ꜰ', 'f')]) {
    assert.equal(fold(disguised).skeleton, plain, disguised);
  }
});

test('destinations are found in their disguised forms', () => {
  const cases = { 'visit example.com': 'domain', 'visit example dot com': 'domain', 'visit example(.)com': 'domain', 'visit example [dot] com': 'domain',
    'visit example . com': 'domain', 'go to bit.ly/abc': 'domain', 'c1ick s1te.c0m now': 'domain', 'ехаmple.соm': 'domain', 'join t . m e / x': 'domain',
    'join t.me/cryptoclub': 'invite', 'discord gg/abcdef': 'invite', 'https://x.y': 'link', 'hxxps :// thing': 'link', 'www . thing': 'link',
    'call +1 555 123 4567': 'phone', 'wallet 0x52908400098527886E0F7030069857D2E4169EE7': 'wallet', 'btc bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq': 'wallet' };
  for (const [text, kind] of Object.entries(cases)) assert.ok(destinations(text).strong.includes(kind), `${text} → ${kind}`);
  assert.equal(destinations('add me on snap @bob123').weak, true);
  assert.equal(destinations('dm me on insta').weak, true);
  // Random-looking codes are contact details when glued onto or right after a messaging app.
  for (const text of ['such TgrD__RMQDc4FQF', 'tg: rD__RMQDc4FQF', 'telegram rD__RMQDc4FQF', 'snap_xK7qPz9mW']) assert.ok(destinations(text).strong.includes('handle'), text);
  assert.deepEqual(destinations('hot stuff rD__RMQDc4FQF'), { strong: [], weak: true, code: true });
  for (const word of ['McDonalds', 'YouTube', 'ThisIsCamelCase', 'Schwarzschild', 'cool_cat_99', 'RTX4090']) assert.equal(randomToken(word), false, word);
});

test('teasers with heavy disguises and app codes are muted, while the same tricks used lightly are not', () => {
  const fresh = text => { const spam = new AntiSpam(); return spam.review({ id: 'x', alias: 'guest', clientKey: 'k', connectedAt: Date.now() }, text, { id: 'm', established: false }); };
  const teaser = "I'hav G0t(h0t🔥Content and filz Lnkz F0lderz such";
  // On its own the teaser is suspicious but goes nowhere, so it needs one more signal before muting.
  assert.equal(fresh(teaser).action, 'allow');
  assert.ok(fresh(teaser).score >= 5, fresh(teaser).reasons.join('; '));
  assert.equal(fresh(`${teaser} TgrD__RMQDc4FQF`).action, 'shadow');
  assert.equal(fresh('Hеy cutie, add me on snap @bob123 😘').action, 'shadow');
  for (const text of ['gg2 lol', 'l33t h4x0r here', 'my iPhone13 and Win10 laptop', 'friend(s) are coming', 'love❤️you', 'McDonalds tonight?',
    'the WiFi password is Kx7mQ2pZ', 'my discord is cool_cat_99', 'add me on snap if you want', 'commit 3f2a9b1c4d broke it', 'f(x) = 2x', 'what a g00d day']) {
    const verdict = fresh(text);
    assert.equal(verdict.action, 'allow', text); assert.ok(verdict.score <= 3, `${text}: ${verdict.reasons}`);
  }
});

test('ordinary chat is not treated as spam', () => {
  const normal = ['Hello. How are you?', 'ok. me too', 'see you at 10.30', 'version 1.2.3 is out', 'I am at the shop.', 'I live in the uk', 'e.g. this',
    'oatmeal sometimes', 'Привет, как дела? ok', 'Γεια σου! all good', '👨‍👩‍👧 family!', 'I love the 2000s, mp3 era', 'covid19 was rough', 'gg2 lol',
    'my number is 12', 'Ich höre gern Musik', 'Café crème, s’il vous plaît', 'snap decisions are hard', 'the signal was weak', 'من خوبم‌ام'];
  for (const text of normal) {
    assert.deepEqual(destinations(text), { strong: [], weak: false }, text);
    assert.ok(obfuscation(text).score <= 1, `${text}: ${obfuscation(text).reasons}`);
  }
});

test('disguises raise the obfuscation score', () => {
  assert.ok(obfuscation('frее money').reasons.includes('mixed alphabets in a word'));
  assert.ok(obfuscation('fr​ee money').reasons.includes('hidden characters'));
  assert.ok(obfuscation('free ‮money').reasons.includes('hidden characters'));
  assert.ok(obfuscation('get 𝐟ree money').reasons.includes('styled letters mixed into words'));
  assert.ok(obfuscation('f r e e money').reasons.includes('spaced-out letters'));
  assert.ok(obfuscation('z̷̢̛a̸̡l̵̨g̶o text').reasons.includes('stacked accents'));
  assert.ok(obfuscation('fr33 m0ney').reasons.includes('digits in place of letters'));
});

test('near-duplicates survive padding and disguises', () => {
  const base = signature(fold('Earn five hundred dollars a day working from home, message me now').skeleton);
  assert.ok(similarity(base, signature(fold('xq7 €arn fiv3 hundr3d dollars a day w0rking from h0me, message me now 9kz').skeleton)) >= 0.5);
  assert.ok(similarity(base, signature(fold('Did anyone watch the football game last night? It was great').skeleton)) < 0.2);
});

function harness(probation = 180000) {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const spam = new AntiSpam({ now: () => now, probation });
  let n = 0;
  const session = (clientKey = `client-${++n}`) => ({ id: `s${++n}`, alias: `user${n}`, clientKey, connectedAt: now });
  return { spam, session, advance: ms => { now += ms; }, review: (s, text) => spam.review(s, text, { id: `m${++n}`, established: spam.established(s) }) };
}

test('new visitors cannot post destinations until probation ends or someone vouches for them', () => {
  const { spam, session, advance, review } = harness();
  const fresh = session(), other = session(), veteran = session();
  advance(180000);
  const newcomer = session();
  assert.equal(review(newcomer, 'Hello everyone!').action, 'allow');
  assert.equal(review(newcomer, 'check example.com').action, 'reject');
  assert.equal(review(fresh, 'check example.com').action, 'allow');
  // A reply from someone established on another network ends probation early; one from the same network does not.
  const sameNetwork = session(newcomer.clientKey); sameNetwork.connectedAt = 0;
  spam.vouch(sameNetwork, newcomer, true); assert.equal(spam.established(newcomer), false);
  spam.vouch(other, newcomer, false); assert.equal(spam.established(newcomer), false);
  spam.vouch(veteran, newcomer, true); assert.equal(spam.established(newcomer), true);
  // Accounts older than a day, or created before ages were recorded, are trusted at once.
  const member = session(); delete member.connectedAt;
  assert.equal(spam.established(member, { createdAt: '2025-12-30T00:00:00Z' }), true);
  assert.equal(spam.established(member, {}), true);
  assert.equal(spam.established(member, { createdAt: '2025-12-31T12:00:00Z' }), false);
});

test('disguised or repeated spam is muted silently, and muting sticks and flags the network', () => {
  const { spam, session, advance, review } = harness();
  const bot = session('bot-net');
  assert.equal(review(bot, 'Get frее crypto at example dot com').action, 'shadow');
  assert.equal(review(bot, 'just a normal message').action, 'shadow');
  // A new session from the flagged network waits longer and starts with a higher score.
  const sibling = session('bot-net');
  advance(180000);
  assert.equal(spam.established(sibling), false);
  advance(180000);
  assert.equal(spam.established(sibling), true);

  // A farm that waits out probation is still caught once the same link repeats across sessions.
  const farm = Array.from({ length: 4 }, (_, i) => session(`farm-${i}`));
  advance(400000);
  const verdicts = farm.map((s, i) => review(s, `${'abcd'[i]} Best crypto signals, 10x guaranteed, join cryptoclub.xyz today ${i}`).action);
  assert.deepEqual(verdicts.slice(0, 2), ['allow', 'allow']);
  assert.ok(verdicts.slice(2).every(action => action === 'shadow'), verdicts.join());
  assert.ok(spam.strikeCount('farm-0') > 0, 'earlier senders of the same link are flagged too');
});

test('links split across messages and repeated messages are caught', () => {
  const { session, review } = harness();
  const fresh = session();
  assert.equal(review(fresh, 'join my group t.').action, 'allow');
  assert.notEqual(review(fresh, 'me/cryptoclub').action, 'allow');
  const { session: session2, advance, review: review2 } = harness();
  const repeater = session2(); advance(180000);
  const text = 'Is anyone here interested in a really amazing business opportunity?';
  assert.equal(review2(repeater, text).action, 'allow');
  assert.equal(review2(repeater, text).action, 'allow');
  assert.equal(review2(repeater, text + '!').action, 'allow');
  assert.equal(review2(repeater, text + '!!').action, 'allow');
  assert.ok(review2(repeater, 'again ' + text).score >= 6);
});

test('ordinary conversation from new visitors stays visible', () => {
  const { session, review } = harness();
  const people = Array.from({ length: 5 }, () => session());
  for (const text of ['hi', 'hello!', 'good morning everyone', 'how is everyone doing today?', 'lol same', 'good morning everyone']) {
    for (const person of people) assert.equal(review(person, text).action, 'allow', text);
  }
});

test('new visitors can only start a few private conversations at a time', () => {
  const { spam, session, advance } = harness();
  const fresh = session();
  for (let i = 0; i < 3; i++) spam.newConversation(fresh, false);
  assert.throws(() => spam.newConversation(fresh, false), { status: 429 });
  advance(600000);
  assert.doesNotThrow(() => spam.newConversation(fresh, false));
  const veteran = session();
  for (let i = 0; i < 20; i++) spam.newConversation(veteran, true);
  assert.throws(() => spam.newConversation(veteran, true), { status: 429 });
});

test('main rooms reject links from new visitors and hide muted messages from everyone else', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'silenzachat-antispam-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`, controllers = [];
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`Server exited: ${code}`))); });
    const visitor = async () => { const res = await fetch(`${origin}/api/session`); return { cookie: res.headers.get('set-cookie').split(';')[0], ...(await res.json()) }; };
    const request = async (user, route, body) => {
      const res = await fetch(`${origin}/api/${route}`, { method: body ? 'POST' : 'GET', headers: { cookie: user.cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, data: await res.json() };
    };
    const listen = async user => {
      const controller = new AbortController(); controllers.push(controller);
      const res = await fetch(`${origin}/api/events`, { headers: { cookie: user.cookie }, signal: controller.signal });
      const seen = []; let buffer = '';
      (async () => { try { for await (const chunk of res.body) { buffer += new TextDecoder().decode(chunk); let end; while ((end = buffer.indexOf('\n\n')) !== -1) { const part = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (part.startsWith('event: message\n')) seen.push(JSON.parse(part.split('\ndata: ')[1]).id); } } } catch {} })();
      return seen;
    };
    const [a, b] = await Promise.all([visitor(), visitor()]);
    const [aSeen, bSeen] = await Promise.all([listen(a), listen(b)]);
    const room = a.rooms[0].id;
    const link = await request(a, 'message', { room, text: 'my site is example.com' });
    assert.equal(link.status, 403); assert.match(link.data.error, /after a few minutes/);
    const hello = await request(a, 'message', { room, text: 'Hello there' });
    assert.equal(hello.status, 200);
    const edit = await request(a, 'message/edit', { id: hello.data.id, editVersion: 1, text: 'Hello there, see example.com' });
    assert.equal(edit.status, 403);
    const muted = await request(a, 'message', { room, text: 'Get frее crypto at example dot com' });
    assert.equal(muted.status, 200);
    const after = await request(a, 'message', { room, text: 'anyone there?' });
    assert.equal(after.status, 200);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(aSeen.includes(muted.data.id) && aSeen.includes(after.data.id), 'the sender sees their own muted messages');
    assert.ok(bSeen.includes(hello.data.id) && !bSeen.includes(muted.data.id) && !bSeen.includes(after.data.id), 'nobody else does');
    const history = await request(b, `history?room=${room}`);
    assert.deepEqual(history.data.map(m => m.id), [hello.data.id]);
  } finally {
    for (const controller of controllers) controller.abort();
    if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    await rm(data, { recursive: true, force: true });
  }
});
