import { enterGuest, enterAccount } from './auth-browser-helper.mjs';
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
const data = await mkdtemp(path.join(tmpdir(), 'silenzachat-social-'));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'social-browser-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const shots = process.env.SCREENSHOT_DIR;
let browser; const errors = [];
const send = async (page, text) => { await page.locator('#message').fill(text); await page.locator('.send-button').click(); await page.locator('#messages').getByText(text, { exact: true }).waitFor(); };
const ownRow = (page, text) => page.locator('.chat-message').filter({ has: page.getByText(text, { exact: true }) });
// Drops a PNG onto the conversation the way a file manager would.
const dropImage = (page, size) => page.evaluate(async size => {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  canvas.getContext('2d').fillRect(0, 0, size, size);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
  const main = document.querySelector('.app > main');
  main.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  const shown = !document.querySelector('#drop-zone').hidden;
  main.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  return shown;
}, size);
try {
  await once(server.stdout, 'data');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const [a, b] = await Promise.all([0, 1].map(async () => (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()));
  for (const page of [a, b]) page.on('pageerror', e => errors.push(e.message));
  await Promise.all([a, b].map(page => enterGuest(page, origin)));
  for (const page of [a, b]) await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
  const [ua, ub] = await Promise.all([a, b].map(page => page.evaluate(() => ({ id: me.id, alias: me.alias }))));

  // Profile: optional gender and age, visible next to the name for others.
  await a.locator('#open-settings').click();
  await a.locator('#profile-gender input[value="woman"]').check(); await a.locator('#profile-age').fill('29');
  await a.locator('#profile-form button[type="submit"]').click(); await a.locator('#profile-status').filter({ hasText: 'Profile saved' }).waitFor();
  await a.locator('#settings-dialog .close-dialog').click();
  await b.locator('.person').filter({ hasText: ua.alias }).locator('.person-profile').filter({ hasText: '29 · Woman' }).waitFor();
  // "Not shown" clears a saved age again.
  await a.locator('#open-settings').click();
  assert.equal(await a.locator('#profile-age-hide').getAttribute('aria-pressed'), 'false');
  await a.locator('#profile-age-hide').click(); assert.equal(await a.locator('#profile-age').inputValue(), '');
  assert.equal(await a.locator('#profile-age-hide').getAttribute('aria-pressed'), 'true');
  await a.locator('#profile-form button[type="submit"]').click();
  await b.locator('.person').filter({ hasText: ua.alias }).locator('.person-profile').filter({ hasText: /^Woman$/ }).waitFor();
  await a.locator('#profile-age').fill('29'); await a.locator('#profile-form button[type="submit"]').click();
  await b.locator('.person').filter({ hasText: ua.alias }).locator('.person-profile').filter({ hasText: '29 · Woman' }).waitFor();
  await a.locator('#settings-dialog .close-dialog').click();

  // Read receipts: one check until the other person opens the chat, then two.
  await a.locator('.person').filter({ hasText: ub.alias }).click();
  await a.waitForFunction(() => !document.querySelector('#message').disabled);
  await send(a, 'Are you there?');
  await ownRow(a, 'Are you there?').locator('.read-receipt:not(.seen)').waitFor();
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(await ownRow(a, 'Are you there?').locator('.read-receipt.seen').count(), 0);
  await b.locator('#dms .dm-room').filter({ hasText: ua.alias }).click();
  await b.locator('#messages').getByText('Are you there?', { exact: true }).waitFor();
  await ownRow(a, 'Are you there?').locator('.read-receipt.seen').waitFor();
  assert.match(await b.locator('#room-description').textContent(), /^29 · Woman · /);
  if (shots) await a.screenshot({ path: path.join(shots, 'read-receipts.png') });

  // Drag and drop attaches an encrypted image; clicking it opens the viewer.
  assert.equal(await dropImage(a, 120), true);
  await a.locator('#attachment-preview').waitFor({ state: 'visible' });
  await send(a, 'Dropped picture');
  await b.waitForFunction(() => [...document.querySelectorAll('.private-image')].some(img => img.complete && img.naturalWidth === 120));
  await b.locator('.image-open').last().click();
  await b.waitForFunction(() => document.querySelector('#image-viewer').open && document.querySelector('#image-viewer img').naturalWidth === 120);
  if (shots) await b.screenshot({ path: path.join(shots, 'image-viewer.png') });
  await b.locator('#image-viewer .close-dialog').click();
  assert.equal(await b.evaluate(() => document.querySelector('#image-viewer').open), false);

  // Click-to-show: images stay hidden and are not downloaded until asked for.
  await b.locator('#open-settings').click(); await b.locator('#settings-tab-privacy').click(); await b.locator('#click-to-show').check(); await b.locator('#settings-dialog .close-dialog').click();
  const downloads = [];
  b.on('request', request => { if (request.url().includes('/api/attachments/')) downloads.push(request.url()); });
  await dropImage(a, 90); await a.locator('#attachment-preview').waitFor({ state: 'visible' });
  await send(a, 'Second picture');
  const reveal = ownRow(b, 'Second picture').locator('.image-reveal');
  await reveal.waitFor();
  assert.equal(await ownRow(b, 'Second picture').locator('.private-image').count(), 0); assert.equal(downloads.length, 0);
  if (shots) await b.screenshot({ path: path.join(shots, 'click-to-show.png') });
  await reveal.click();
  await b.waitForFunction(() => [...document.querySelectorAll('.private-image')].some(img => img.complete && img.naturalWidth === 90));
  assert.equal(downloads.length, 1);

  // With read receipts off, the sender keeps seeing a single check.
  await b.locator('#open-settings').click(); await b.locator('#settings-tab-privacy').click(); await b.locator('#read-receipts').uncheck(); await b.locator('#settings-dialog .close-dialog').click();
  await send(a, 'Quietly read');
  await b.locator('#messages').getByText('Quietly read', { exact: true }).waitFor();
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await ownRow(a, 'Quietly read').locator('.read-receipt.seen').count(), 0);
  // An admin removing someone's public message leaves a notice for everyone in the room.
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  admin.on('pageerror', e => errors.push(e.message)); await enterAccount(admin, origin, 'social-browser-test');
  for (const page of [a, b, admin]) await page.locator('#rooms .nav-room').first().click();
  await send(b, 'Rude public message');
  await admin.locator('#messages').getByText('Rude public message', { exact: true }).waitFor();
  await ownRow(admin, 'Rude public message').locator('.message-remove').click();
  await a.locator('.removed-notice').filter({ hasText: 'This message was removed by an admin.' }).waitFor();
  await b.locator('.removed-notice').filter({ hasText: 'Your message was removed by an admin.' }).waitFor();
  assert.equal(await a.getByText('Rude public message', { exact: true }).count(), 0);
  await a.reload(); await a.locator('.removed-notice').filter({ hasText: 'This message was removed by an admin.' }).waitFor();
  await a.locator('#rooms .room-preview').filter({ hasText: 'Message removed by an admin' }).waitFor();
  if (shots) await a.screenshot({ path: path.join(shots, 'admin-removal.png') });
  // An admin can clear the notice itself, which removes it for everyone.
  await admin.locator('.removed-message .message-remove').click();
  await a.locator('.removed-notice').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('PASS: profile gender/age shown to others, read receipts (and opting out), drag-and-drop attachments, image viewer, click-to-show images, admin removal notices');
} finally {
  await browser?.close(); server.kill(); await once(server, 'exit').catch(() => {});
  await rm(data, { recursive: true, force: true });
}
