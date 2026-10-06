import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

test('HTTPS origins send HSTS on static/API/error responses and secure cookies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'silenza-headers-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const local = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
    ORIGIN: 'https://chat.example.test', TRUSTED_PROXY_ADDRESSES: '', ADMIN_USERNAME: '', ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    for (const route of ['/', '/crypto.js', '/missing', '/api/auth/status', '/api/session']) {
      const response = await fetch(local + route);
      assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
      assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.match(response.headers.get('permissions-policy'), /camera=\(\), microphone=\(\), geolocation=\(\)/);
      if (route === '/api/session') {
        assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /; Secure/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      await response.body.cancel();
    }
  } finally {
    const ended = once(child, 'exit'); child.kill(); await ended;
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
  }
});

test('static files are compressed and revalidate with ETags, keeping security headers on 304s', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'silenza-static-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const local = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
    TRUSTED_PROXY_ADDRESSES: '', ADMIN_USERNAME: '', ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    // fetch() sends Accept-Encoding: gzip and transparently decompresses.
    const first = await fetch(`${local}/app.js`);
    assert.equal(first.status, 200); assert.equal(first.headers.get('content-encoding'), 'gzip');
    assert.match(await first.text(), /function connect\(\)/);
    const etag = first.headers.get('etag'); assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
    const again = await fetch(`${local}/app.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304); assert.equal(await again.text(), '');
    assert.equal(again.headers.get('x-content-type-options'), 'nosniff');
    assert.match(again.headers.get('content-security-policy'), /default-src 'self'/);
    const other = await fetch(`${local}/style.css`, { headers: { 'If-None-Match': etag } });
    assert.equal(other.status, 200); await other.body.cancel();
    // Pages link versioned scripts and styles that may be cached long-term; plain URLs revalidate.
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const page = await fetch(`${local}/chat/`), html = await page.text();
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const build = html.match(/<meta name="silenza-build" content="([\w-]+)">/)?.[1]; assert.ok(build);
    const script = html.match(/src="(\/app\.js\?v=[\w-]+)"/)?.[1]; assert.ok(script);
    assert.ok(html.includes('href="/style.css?v=')); assert.ok(html.includes('src="/vendor/nacl.js?v='));
    const versioned = await fetch(local + script);
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable'); await versioned.body.cancel();
    const stale = await fetch(`${local}/app.js?v=outdated`);
    assert.equal(stale.headers.get('cache-control'), 'no-cache'); await stale.body.cancel();
    assert.equal((await (await fetch(`${local}/api/version`)).json()).build, build);
    assert.equal((await fetch(`${local}/chat/`, { headers: { 'If-None-Match': page.headers.get('etag') } })).status, 304);
    // Links to pages are not versioned.
    const landing = await (await fetch(`${local}/`)).text();
    assert.ok(!/href="\/(?:chat\/)?\?v=/.test(landing)); assert.ok(landing.includes('href="/about.css?v='));
  } finally {
    const ended = once(child, 'exit'); child.kill(); await ended;
    await rm(directory, { recursive: true, force: true });
  }
});
