import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { enterGuest } from './auth-browser-helper.mjs';

const dir = await mkdtemp(path.join(tmpdir(), 'silenza-account-browser-'));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'a long host password' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await once(server.stdout, 'data');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext(), other = await browser.newContext();
  const page = await context.newPage(), guest = await other.newPage(), errors = [];
  for (const p of [page, guest]) p.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/chat/'); await page.waitForURL(origin + '/#entry');
  await page.locator('#account-mode').selectOption('register');
  await page.locator('#account-username').fill('Alice');
  await page.locator('#account-password').fill('my long test password');
  if (process.env.ACCOUNT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.ACCOUNT_SCREENSHOT_DIR, 'account-entry.png'), fullPage: true });
  await page.locator('#account-submit').click(); await page.waitForURL(origin + '/chat/');
  await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
  await page.waitForFunction(() => document.querySelector('#my-alias').textContent === 'Alice');
  assert.equal(await page.locator('#open-admin').isVisible(), false);
  await enterGuest(guest, origin);
  await guest.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
  const secondContext = await browser.newContext(), second = await secondContext.newPage();
  second.on('pageerror', e => errors.push(e.message));
  await second.goto(origin);
  await second.locator('#account-username').fill('Alice');
  await second.locator('#account-password').fill('my long test password');
  await second.locator('#account-submit').click(); await second.waitForURL(origin + '/chat/');
  await second.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
  for (const viewer of [page, second, guest]) {
    await viewer.waitForFunction(() => document.querySelector('#online-count').textContent === '2');
    assert.equal(await viewer.locator('#people .person').filter({ hasText: 'Alice' }).count(), 1);
    assert.equal(await viewer.locator('#rooms .count').first().textContent(), '2');
    const data = await viewer.evaluate(() => fetch('/api/session').then(r => r.json()));
    assert.equal(data.people.filter(person => person.alias === 'Alice').length, 1);
    if (viewer !== guest) {
      assert.equal(data.people.find(person => person.alias === 'Alice').id, data.me.id);
      assert.equal(await viewer.locator('#people .person').filter({ hasText: 'Alice' }).isDisabled(), true);
    }
  }
  await guest.locator('#message').fill('Hello from the room'); await guest.locator('.send-button').click();
  await page.locator('.room-preview').filter({ hasText: 'Hello from the room' }).waitFor();
  await page.locator('#emoji-toggle').click(); await page.locator('#emoji-search').fill('grinning');
  await page.locator('#emoji-grid button').first().click();
  assert.equal(await page.locator('#message').inputValue(), '😀');
  await page.locator('#message').fill('');
  await page.locator('#open-settings').click(); await page.locator('#settings-tab-notifications').click();
  for (const key of ['private', 'groups', 'rooms']) assert.equal(await page.locator('#sound-' + key).isChecked(), false);
  await page.locator('#sound-private').check();
  await page.locator('#test-sound').click();
  await page.getByText('Sound is enabled in this tab.', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.testSounds = 0;
    const original = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (...args) { window.testSounds++; return original.apply(this, args); };
    notifyMessage({ id: 'test-room', sender: 'someone', room: 'main' });
    notifyMessage({ id: 'test-group', sender: 'someone', group: 'temp' });
    notifyMessage({ id: 'test-own', sender: me.id, recipient: 'someone' });
  });
  assert.equal(await page.evaluate(() => window.testSounds), 0);
  await page.evaluate(() => notifyMessage({ id: 'test-private', sender: 'someone', recipient: me.id }));
  await page.waitForFunction(() => window.testSounds === 1);
  if (process.env.ACCOUNT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.ACCOUNT_SCREENSHOT_DIR, 'chat-settings.png') });
  await page.reload(); await page.locator('#open-settings').click();
  assert.equal(await page.locator('#sound-private').isChecked(), true);
  assert.equal(await page.locator('#sound-groups').isChecked(), false);
  await page.locator('#account-signout').click(); await page.waitForURL(origin + '/#entry');
  // Signing out the initially selected session must leave the account visible
  // and route new private conversations to its remaining encrypted session.
  await guest.waitForFunction(async () => {
    const data = await fetch('/api/session').then(r => r.json());
    return people.find(person => person.alias === 'Alice')?.id === data.people.find(person => person.alias === 'Alice')?.id;
  });
  assert.equal(await guest.locator('#people .person').filter({ hasText: 'Alice' }).count(), 1);
  await guest.locator('#people .person').filter({ hasText: 'Alice' }).click();
  await guest.locator('#message').fill('Hello remaining session');
  await guest.locator('.send-button').click();
  await second.locator('#dms .dm-room').first().click();
  await second.locator('#messages').getByText('Hello remaining session', { exact: true }).waitFor();
  await secondContext.close();
  await guest.waitForFunction(() => document.querySelector('#online-count').textContent === '1');
  await page.locator('#account-username').fill('ALICE'); await page.locator('#account-password').fill('my long test password');
  await page.locator('#account-submit').click(); await page.waitForURL(origin + '/chat/');
  await page.waitForFunction(() => document.querySelector('#my-alias').textContent === 'Alice');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.goto(origin); await page.locator('#continue-account').waitFor();
  assert.equal(await page.locator('#account-form').isVisible(), false);
  await page.locator('#entry-signout').click(); await page.locator('#guest-enter').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.ACCOUNT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.ACCOUNT_SCREENSHOT_DIR, 'account-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: entry gate, registration, login/logout, guest access, previews, native emojis, sound filtering and persistence, desktop/mobile layout');
} finally {
  await browser?.close(); const ended = once(server, 'exit'); server.kill(); await ended;
  assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true });
}
