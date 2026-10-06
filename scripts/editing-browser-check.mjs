import { enterGuest, enterAccount, signOut } from './auth-browser-helper.mjs';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'silenzachat-edits-'));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'groups-browser-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser; const errors = [], sent = [];
const api = (page, route, body) => page.evaluate(async ({ route, body }) => {
  const response = await fetch(`/api/${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}, { route, body });
const closeDetails = page => page.locator('#group-dialog .close-dialog').click();
const send = async (page, text) => { await page.locator('#message').fill(text); await page.locator('.send-button').click(); await page.locator('#messages').getByText(text, { exact: true }).waitFor(); };
const memberRow = (page, alias) => page.locator('.group-member').filter({ hasText: alias });
const editMessage = async (page, before, after) => {
  await page.locator('.chat-message').filter({ has: page.locator('.message-text', { hasText: before }) }).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#edit-message-text').fill(after);
  await page.locator('#edit-message-form button[type="submit"]').click();
  await page.locator('#edit-message-dialog').waitFor({ state: 'hidden' });
  await page.locator('#messages').getByText(after, { exact: true }).waitFor();
};
const askAndApprove = async (page, owner) => {
  await page.locator('#group-join').click(); await page.locator('#group-join').filter({ hasText: 'Cancel join request' }).waitFor({ timeout: 60000 });
  const id = await page.evaluate(() => me.id), group = await page.evaluate(() => groupPanel.id);
  const result = await owner.evaluate(async ({ group, id }) => (await fetch('/api/groups/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group, member: id }) })).status, { group, id });
  if (result !== 200) throw new Error(`Approving the join request failed with ${result}`);
};
try {
  await once(server.stdout, 'data');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [a,b,c] = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of [a,b,c]) {
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', request => { if (request.url().match(/\/(message\/edit|groups\/message-edit)$/)) sent.push(request.postDataJSON()); });
    await enterGuest(page, origin);
    await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
  }
  const [ua,ub] = await Promise.all([a,b].map(async p => (await api(p, 'session')).data.me));
  await send(a, 'Public before'); await b.locator('#messages').getByText('Public before', { exact: true }).waitFor();
  assert.equal(await b.locator('.chat-message').filter({ hasText: 'Public before' }).getByRole('button', { name: 'Edit', exact: true }).count(), 0);
  await a.locator('#message').fill('Unsent draft');
  await a.locator('.chat-message').filter({ hasText: 'Public before' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await a.locator('#edit-message-text').fill('Cancelled change'); await a.locator('#cancel-edit-message').click();
  assert.equal(await a.locator('#message').inputValue(), 'Unsent draft');
  await editMessage(a, 'Public before', 'Public after'); await b.locator('#messages').getByText('Public after', { exact: true }).waitFor();
  assert.match(await b.locator('.chat-message').filter({ hasText: 'Public after' }).textContent(), /edited/);
  await a.locator('#people .person').filter({ hasText: ub.alias }).click();
  await b.locator('#people .person').filter({ hasText: ua.alias }).click();
  await a.waitForFunction(() => !document.querySelector('#message').disabled);
  await send(a, 'Private before'); await b.locator('#messages').getByText('Private before', { exact: true }).waitFor();
  await editMessage(a, 'Private before', 'Private edited sentinel');
  await b.locator('#messages').getByText('Private edited sentinel', { exact: true }).waitFor();
  await b.reload(); await b.locator('#dms .dm-room').click();
  await b.locator('#messages').getByText('Private edited sentinel', { exact: true }).waitFor();
  const image = await a.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10; return canvas.toDataURL('image/png').split(',')[1]; });
  const attach = async () => { await a.locator('#file-input').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') }); await a.locator('#attachment-preview').waitFor({ state: 'visible' }); };
  await attach(); await send(a, 'Private caption'); await editMessage(a, 'Private caption', 'Private caption edited');
  await b.locator('#messages').getByText('Private caption edited', { exact: true }).waitFor();
  await b.waitForFunction(() => [...document.querySelectorAll('.private-image')].some(i => i.complete && i.naturalWidth === 10));
  // Sending and editing share the eight-actions-per-ten-seconds rate limit.
  await new Promise(resolve => setTimeout(resolve, 10050));
  await a.locator('#create-group').click(); await a.locator('#group-name').fill('Editing room'); await a.locator('#group-save').click();
  await b.locator('#groups .group-room').click(); await askAndApprove(b, a);
  await a.waitForFunction(() => !document.querySelector('#message').disabled && document.querySelector('#room-title').textContent === 'Editing room');
  await send(a, 'Group before'); await b.locator('#messages').getByText('Group before', { exact: true }).waitFor();
  await c.locator('#groups .group-room').click(); await askAndApprove(c, a);
  await c.waitForFunction(() => document.querySelector('#room-title').textContent === 'Editing room');
  // A later member must not receive an edited historical message.
  await editMessage(a, 'Group before', 'Group edited sentinel');
  await b.locator('#messages').getByText('Group edited sentinel', { exact: true }).waitFor();
  assert.equal(await c.locator('#messages').getByText('Group edited sentinel', { exact: true }).count(), 0);
  await attach(); await send(a, 'Group caption');
  await a.setViewportSize({ width: 390, height: 844 });
  await editMessage(a, 'Group caption', 'Group caption edited');
  await b.locator('#messages').getByText('Group caption edited', { exact: true }).waitFor();
  await b.waitForFunction(() => [...document.querySelectorAll('.private-image')].some(i => i.complete && i.naturalWidth === 10));
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(!JSON.stringify(sent).includes('Private edited sentinel'));
  assert.ok(!JSON.stringify(sent).includes('Group edited sentinel'));
  assert.deepEqual(errors, []);
  console.log('PASS: own message editing, cancellation, draft preservation, live updates, encrypted private/group edits, history reload, original audience isolation, image captions and mobile layout');
} finally {
  await browser?.close(); server.kill(); await once(server, 'exit');
  if (path.dirname(data) !== path.resolve(tmpdir()) || !path.basename(data).startsWith('silenzachat-edits-')) throw new Error('Unexpected temporary test directory.');
  await rm(data, { recursive: true, force: true });
}
