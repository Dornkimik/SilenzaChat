import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const invalid = (status, message) => { throw Object.assign(new Error(message), { status }); };
export class Accounts {
  constructor(directory) {
    this.file = path.join(directory, 'accounts.json'); this.items = []; this.queue = Promise.resolve();
    // At most 4 scrypt derivations run at once; others wait in a bounded queue. Each network
    // client may have only one derivation running or waiting, so a few clients cannot hog it.
    this.busy = 0; this.waiting = []; this.clients = new Map();
  }
  async load() {
    try { this.items = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async digest(password, salt, client = null) {
    if (client && this.clients.has(client)) invalid(429, 'Another sign-in from this network is still in progress. Please try again shortly.');
    if (this.busy >= 4 && this.waiting.length >= 64) invalid(429, 'Sign-in is busy. Please try again shortly.');
    if (client) this.clients.set(client, true);
    try {
      // A finishing derivation hands its slot directly to the next waiter.
      if (this.busy >= 4) await new Promise(resolve => this.waiting.push(resolve));
      else this.busy++;
      try { return await derive(password, salt, 64, options); }
      finally { const next = this.waiting.shift(); if (next) next(); else this.busy--; }
    } finally { if (client) this.clients.delete(client); }
  }
  validate(username, password) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(username)) invalid(400, 'Use 3–24 letters, numbers or underscores for your username.');
    if (typeof password !== 'string' || password.length < 15 || password.length > 128) invalid(400, 'Use a password between 15 and 128 characters.');
  }
  async create(username, password, role = 'member', client = null) {
    this.validate(username, password);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await this.digest(password, salt, client)).toString('hex');
    const job = this.queue.then(async () => {
      if (this.items.some(a => a.username.toLowerCase() === username.toLowerCase())) invalid(409, 'That username is unavailable.');
      if (this.items.length >= 50000) invalid(503, 'Account registration is full.');
      const account = { id: randomUUID(), username, role, salt, passwordHash, algorithm: 'scrypt-N32768-r8-p3', createdAt: new Date().toISOString() };
      const next = [...this.items, account];
      await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file); this.items = next;
      return account;
    });
    this.queue = job.catch(() => {}); return job;
  }
  async authenticate(username, password, client = null) {
    if (typeof username !== 'string' || username.length > 24 || typeof password !== 'string' || password.length > 128) invalid(403, 'Incorrect username or password.');
    const account = this.items.find(a => a.username.toLowerCase() === username.toLowerCase());
    const calculated = await this.digest(password, account?.salt || '00000000000000000000000000000000', client);
    if (!account || !timingSafeEqual(calculated, Buffer.from(account.passwordHash, 'hex'))) invalid(403, 'Incorrect username or password.');
    return account;
  }
  get(id) { return this.items.find(a => a.id === id); }
  save(transform) {
    const job = this.queue.then(async () => {
      const next = transform(this.items);
      await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file); this.items = next;
    });
    this.queue = job.catch(() => {}); return job;
  }
  async verify(id, password, client = null) {
    const account = this.get(id);
    if (!account || typeof password !== 'string' || password.length > 128) invalid(403, 'Your current password is incorrect.');
    const calculated = await this.digest(password, account.salt, client);
    if (!timingSafeEqual(calculated, Buffer.from(account.passwordHash, 'hex'))) invalid(403, 'Your current password is incorrect.');
    return account;
  }
  async changePassword(id, current, password, client = null) {
    const account = await this.verify(id, current, client);
    this.validate(account.username, password);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await this.digest(password, salt, client)).toString('hex');
    await this.save(items => {
      if (!items.some(a => a.id === id)) invalid(404, 'This account no longer exists.');
      return items.map(a => a.id === id ? { ...a, salt, passwordHash, algorithm: 'scrypt-N32768-r8-p3' } : a);
    });
  }
  async remove(id, password, client = null) {
    const account = await this.verify(id, password, client);
    if (account.role === 'admin' && this.items.filter(a => a.role === 'admin').length <= 1) invalid(400, 'The last admin account cannot be deleted.');
    await this.save(items => items.filter(a => a.id !== id));
  }
}
