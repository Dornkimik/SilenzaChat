import { enterGuest } from './auth-browser-helper.mjs';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

// Temporary rooms on a slow, unreliable connection (similar to Tor): every request is delayed,
// several members send at once while membership changes, and one member drops offline and returns.
const root = fileURLToPath(new URL('..', import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'silenzachat-slow-'));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: '', ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
const LATENCY = 1500;
let browser; const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const texts = page => page.locator('#messages .message-text').allTextContents();
const send = async (page, text) => {
  await page.waitForFunction(() => !document.querySelector('#message').disabled && !document.querySelector('.send-button').disabled);
  await page.locator('#message').fill(text); await page.locator('.send-button').click();
  await page.getByText(text, { exact: true }).waitFor({ timeout: 60000 });
};
const askAndApprove = async (page, owner) => {
  await page.locator('#group-join').click(); await page.locator('#group-join').filter({ hasText: 'Cancel join request' }).waitFor({ timeout: 60000 });
  const id = await page.evaluate(() => me.id), group = await page.evaluate(() => groupPanel.id);
  const result = await owner.evaluate(async ({ group, id }) => (await fetch('/api/groups/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group, member: id }) })).status, { group, id });
  if (result !== 200) throw new Error(`Approving the join request failed with ${result}`);
};
const joinRoom = async (page, owner) => {
  await page.locator('#groups .group-room').filter({ hasText: 'Slow lane' }).waitFor({ timeout: 60000 });
  await page.locator('#groups .group-room').click(); await askAndApprove(page, owner);
  await page.waitForFunction(() => !document.querySelector('#message').disabled && document.querySelector('#room-title').textContent === 'Slow lane', null, { timeout: 60000 });
};
try {
  await once(server.stdout, 'data');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext()));
  const [a, b, c, d] = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of [a, b, c, d]) page.on('pageerror', e => errors.push(e.message));
  await Promise.all([a, b, c, d].map(page => enterGuest(page, origin)));
  for (const page of [a, b, c, d]) await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
  // From here on every API request (including the event stream's connection) takes 1.5 seconds longer.
  for (const page of [a, b, c, d]) await page.route('**/api/**', async route => { await delay(LATENCY); await route.continue(); });

  await a.locator('#create-group').click(); await a.locator('#group-name').fill('Slow lane'); await a.locator('#group-save').click();
  await a.waitForFunction(() => document.querySelector('#room-title').textContent === 'Slow lane' && !document.querySelector('#message').disabled, null, { timeout: 60000 });
  await Promise.all([joinRoom(b, a), joinRoom(c, a)]);

  // Three members send at the same time while a fourth person joins, which changes the membership
  // mid-send. Sends must be retried for the new member list instead of failing.
  const burst = page => (async () => { for (let i = 1; i <= 3; i++) await send(page, `${page === a ? 'A' : page === b ? 'B' : 'C'} message ${i}`); })();
  await Promise.all([burst(a), burst(b), burst(c), joinRoom(d, a)]);
  for (const page of [a, b, c]) assert.equal(await page.locator('#error').textContent(), '', 'no send failed during the membership change');
  const expected = ['A', 'B', 'C'].flatMap(who => [1, 2, 3].map(i => `${who} message ${i}`));
  for (const page of [a, b, c]) await page.waitForFunction(list => list.every(text => [...document.querySelectorAll('#messages .message-text')].some(p => p.textContent === text)), expected, { timeout: 60000 });
  const order = await texts(a);
  for (const page of [b, c]) assert.deepEqual(await texts(page), order, 'every member sees the same order');

  // C loses the connection. Meanwhile A posts and B deletes one of its messages. When C is back the
  // chat catches up without being cleared and redrawn.
  await c.evaluate(() => { document.querySelector('#messages .chat-message').dataset.kept = 'yes'; });
  // Offline emulation does not cut an open stream, so refuse C's requests and drop its stream instead.
  const offline = route => route.abort('internetdisconnected');
  await c.route('**/api/**', offline);
  await c.evaluate(() => { stream.close(); stream.onerror(); });
  await c.waitForFunction(() => document.querySelector('#connection').textContent === 'Reconnecting…', null, { timeout: 60000 });
  await send(a, 'sent while C was offline');
  await b.locator('.chat-message').filter({ hasText: 'B message 1' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await b.locator('.chat-message').filter({ hasText: 'B message 1' }).waitFor({ state: 'detached', timeout: 60000 });
  await c.unroute('**/api/**', offline);
  await c.getByText('sent while C was offline', { exact: true }).waitFor({ timeout: 60000 });
  await c.locator('.chat-message').filter({ hasText: 'B message 1' }).waitFor({ state: 'detached', timeout: 60000 });
  assert.equal(await c.locator('#messages .chat-message[data-kept="yes"]').count(), 1, 'existing rows were kept, not rebuilt');
  assert.deepEqual(await texts(c), await texts(a));

  // A stream that stays open but stops delivering (a stalled circuit) is replaced by the watchdog.
  const before = await b.evaluate(() => { window.staleStream = stream; lastEvent = Date.now() - 60000; checkConnection(); return stream !== window.staleStream; });
  assert.ok(before, 'the watchdog opened a new stream');
  await b.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected', null, { timeout: 60000 });
  await send(a, 'after the watchdog reconnect');
  await b.getByText('after the watchdog reconnect', { exact: true }).waitFor({ timeout: 60000 });

  assert.deepEqual(errors, []);
  console.log(`PASS: with ${LATENCY} ms added to every request: concurrent sends during a membership change, identical order for every member, offline catch-up without redraw (new and deleted messages), stalled-stream watchdog`);
} finally {
  await browser?.close(); server.kill(); await rm(data, { recursive: true, force: true });
}
