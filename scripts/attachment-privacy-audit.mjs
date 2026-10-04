import assert from 'node:assert/strict';
import crypto from '../public/crypto.js';

// Test-only instrumentation. Secrets stay in the test process and are never logged or uploaded.
export async function auditAttachments(page) {
  const requests = [], uploads = [], roundTrips = [], errors = [];
  page.on('request', request => {
    const body = request.postDataBuffer();
    const record = { url: request.url(), headers: JSON.stringify(request.headers()), body };
    requests.push(record);
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/attachments') uploads.push(record);
  });
  page.on('response', response => {
    const request = response.request();
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/attachments' || !response.ok()) return;
    roundTrips.push((async () => {
      const { id } = await response.json();
      const downloaded = await page.request.get(new URL(`/api/attachments/${id}`, response.url()).href);
      assert.equal(downloaded.status(), 200);
      assert.deepEqual(await downloaded.body(), request.postDataBuffer(), 'The server must return the exact encrypted bytes it received.');
    })().catch(error => { errors.push(error); }));
  });
  const identitySecrets = await page.evaluate(async () => {
    // Record the local identity secret, to verify it never appears in outbound traffic.
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('silenzachat-private-v1');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, get = db.transaction('identities').objectStore('identities').getAll();
        get.onsuccess = () => { db.close(); resolve(get.result.filter(x => x.secretKey).map(x => SilenzaCrypto.base64(x.secretKey))); };
        get.onerror = () => reject(get.error);
      };
    });
  });
  const snapshots = [];
  // Capture the input and output of the real encryptor, without replacing its implementation.
  await page.exposeFunction('__auditAttachment', sample => snapshots.push(sample));
  await page.evaluate(() => {
    const encrypt = SilenzaCrypto.encryptAttachment;
    SilenzaCrypto.encryptAttachment = bytes => {
      const result = encrypt(bytes);
      window.__auditAttachment({ plain: SilenzaCrypto.base64(bytes), cipher: SilenzaCrypto.base64(result.bytes), key: result.key, nonce: result.nonce });
      return result;
    };
  });
  return {
    // Metadata planted in a test file must already be gone when the bytes reach the encryptor.
    assertNeverEncrypted(value) {
      for (const sample of snapshots) assert.equal(Buffer.from(sample.plain, 'base64').includes(Buffer.from(value)), false, `Encrypted attachment still contained "${value}".`);
    },
    async assertFailsClosed(original) {
      // Attachments start encrypting in the background as soon as they are attached, so break the encryptor first.
      await page.evaluate(() => {
        window.__auditSavedEncryptAttachment = SilenzaCrypto.encryptAttachment;
        SilenzaCrypto.encryptAttachment = () => { throw new Error('Audit: attachment encryption failed'); };
      });
      const before = uploads.length;
      try {
        await page.locator('#file-input').setInputFiles({ name: 'failure-probe.png', mimeType: 'image/png', buffer: original });
        await page.locator('#attachment-preview').waitFor({ state: 'visible' });
        await page.locator('#message').fill('encryption failure must not leak this');
        await page.locator('.send-button').click();
        await page.waitForFunction(() => document.querySelector('#error').textContent === 'Audit: attachment encryption failed');
        assert.equal(uploads.length, before, 'Encryption failure must not fall back to an unencrypted upload.');
        assert.ok(!requests.some(request => request.body?.includes(Buffer.from('encryption failure must not leak this'))));
      } finally {
        await page.evaluate(() => { SilenzaCrypto.encryptAttachment = window.__auditSavedEncryptAttachment; delete window.__auditSavedEncryptAttachment; });
        await page.locator('#cancel-attachment').click(); await page.locator('#message').fill('');
      }
    },
    async verify(original, filename) {
      await Promise.all(roundTrips);
      assert.deepEqual(errors.map(e => e.message), []);
      assert.ok(uploads.length > 0, 'At least one image must cross the network.');
      assert.equal(snapshots.length, uploads.length, 'Every image upload must come from the encryptor.');
      const secrets = identitySecrets.map(value => Buffer.from(value, 'base64'));
      for (let i = 0; i < uploads.length; i++) {
        const sample = snapshots[i], plain = Buffer.from(sample.plain, 'base64'), ciphertext = Buffer.from(sample.cipher, 'base64');
        assert.deepEqual(uploads[i].body, ciphertext, 'Upload must contain the real encryption output.');
        assert.equal(uploads[i].body.length, crypto.paddedSize(plain.length) + 16);
        assert.notDeepEqual(ciphertext, plain);
        assert.deepEqual(Buffer.from(crypto.decryptAttachment(ciphertext, { ...sample, size: plain.length })), plain);
        assert.throws(() => crypto.decryptAttachment(ciphertext, { ...sample, key: Buffer.alloc(32).toString('base64'), size: plain.length }), /authenticated/);
        secrets.push(plain, Buffer.from(sample.key, 'base64'), Buffer.from(sample.nonce, 'base64'));
      }
      const forbidden = [original, Buffer.from(filename), ...secrets, ...secrets.map(bytes => Buffer.from(bytes.toString('base64')))];
      for (const request of requests) for (const part of [Buffer.from(request.url), Buffer.from(request.headers), request.body].filter(Boolean)) {
        for (const value of forbidden) assert.equal(part.includes(value), false, 'An outbound request exposed image plaintext, filename, or a secret key/nonce.');
      }
      return uploads.length;
    }
  };
}
