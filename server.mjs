import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import nacl from 'tweetnacl';
import { Attachments } from './lib/attachments.mjs';
import { Groups } from './lib/groups.mjs';
import { Accounts } from './lib/accounts.mjs';
import { Blocks, userKey } from './lib/blocks.mjs';
import { Announcements, announcementRoom } from './lib/announcements.mjs';
import { Security, sessionCapacity, validateOrigin, trustedProxyList } from './lib/security.mjs';
import { Histories } from './lib/histories.mjs';
import { randomAlias } from './lib/aliases.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const configuredOrigin = validateOrigin(process.env.ORIGIN, process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT_ID));
const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(root, 'data'));
if (process.env.RAILWAY_ENVIRONMENT_ID) {
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const relative = mount ? path.relative(path.resolve(mount), dataDir) : null;
  if (relative === null || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    console.warn('Persistent storage is not configured: attach a Railway volume and unset DATA_DIR, or set DATA_DIR inside its mount path. Main rooms, bans, and feedback may be lost on redeploy.');
  }
}
await mkdir(dataDir, { recursive: true });
let rooms;
try { rooms = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; rooms = [
  { id: 'the-living-room', name: 'The living room', description: 'A little company. A good conversation.' },
  { id: 'after-hours', name: 'After hours', description: 'For night owls and wandering thoughts.' },
  { id: 'creative-corner', name: 'Creative corner', description: 'Ideas, works in progress, and happy accidents.' }
];
  // Seed once, then preserve the saved list, including an intentionally empty list.
  await writeFile(path.join(dataDir, 'rooms.tmp'), JSON.stringify(rooms, null, 2), { mode: 0o600 });
  await rename(path.join(dataDir, 'rooms.tmp'), path.join(dataDir, 'rooms.json'));
}
let bans;
try { bans = new Map(JSON.parse(await readFile(path.join(dataDir, 'bans.json'), 'utf8')).map(ban => [ban.key, ban])); }
catch (e) { if (e.code !== 'ENOENT') throw e; bans = new Map(); }
let feedback;
try { feedback = JSON.parse(await readFile(path.join(dataDir, 'feedback.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; feedback = []; }
const attachmentTTL = Number(process.env.ATTACHMENT_TTL_SECONDS || 86400) * 1000;
if (!Number.isFinite(attachmentTTL) || attachmentTTL < 1000 || attachmentTTL > 86400000) throw new Error('ATTACHMENT_TTL_SECONDS must be between 1 and 86400.');
const attachmentStorage = Number(process.env.ATTACHMENT_STORAGE_MB || 256) * 1024 * 1024;
if (!Number.isFinite(attachmentStorage) || attachmentStorage < 16 * 1024 * 1024) throw new Error('ATTACHMENT_STORAGE_MB must be at least 16.');
const attachmentMax = Number(process.env.ATTACHMENT_MAX_MB || 16) * 1024 * 1024;
if (!Number.isSafeInteger(attachmentMax) || attachmentMax < 1024 * 1024 || attachmentMax > 64 * 1024 * 1024) throw new Error('ATTACHMENT_MAX_MB must be a whole number between 1 and 64.');
if (attachmentStorage < attachmentMax) throw new Error('ATTACHMENT_STORAGE_MB must be at least ATTACHMENT_MAX_MB.');
const attachments = new Attachments({ ttl: attachmentTTL, maxBytes: attachmentStorage, maxItem: attachmentMax });
// Sessions are keyed by their secret cookie token and also indexed by public ID, so looking up
// a peer costs O(1) instead of scanning every session on each request.
class SessionMap extends Map {
  ids = new Map();
  set(token, session) { const previous = super.get(token); if (previous && previous !== session && this.ids.get(previous.id) === previous) this.ids.delete(previous.id); this.ids.set(session.id, session); return super.set(token, session); }
  delete(token) { const session = super.get(token); if (session && this.ids.get(session.id) === session) this.ids.delete(session.id); return super.delete(token); }
  clear() { this.ids.clear(); super.clear(); }
}
const sessions = new SessionMap();
const sessionById = id => sessions.ids.get(id);
const histories = new Histories({ attachments, clientOf: id => sessionById(id)?.clientKey });
const streamClients = new Map();
const security = new Security({ trustedProxies: trustedProxyList(process.env.TRUSTED_PROXY_ADDRESSES || '', process.env.TRUSTED_PROXY_PRESET || ''),
  clientIpHeader: process.env.CLIENT_IP_HEADER || '' });
if ((process.env.RAILWAY_ENVIRONMENT_ID || process.env.NODE_ENV === 'production') && !security.configured) {
  console.warn('TRUSTED_PROXY_ADDRESSES is not set. Behind a hosting proxy or CDN every visitor shares one address, so per-visitor limits become site-wide. ' +
    'On Railway set TRUSTED_PROXY_ADDRESSES=100.64.0.0/10 and CLIENT_IP_HEADER=X-Real-IP. LOG_CLIENT_ADDRESS_ONCE=true prints one request\'s addresses to help.');
}
let logClientAddress = process.env.LOG_CLIENT_ADDRESS_ONCE === 'true';
const announcements = new Announcements(dataDir);
await announcements.load();
const allRooms = () => [...rooms, announcementRoom];
const accounts = new Accounts(dataDir);
await accounts.load();
const blocks = new Blocks(dataDir);
await blocks.load();
// Bootstrap only a new installation. Never promote an existing user by name.
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && !accounts.items.length) {
  await accounts.create(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD, 'admin');
}
const isAdmin = s => accounts.get(s.accountId)?.role === 'admin';
const hash = value => createHash('sha256').update(value).digest();
// Guest aliases must not match anyone online or any registered username.
const aliasTaken = alias => { const lower = alias.toLowerCase();
  return [...sessions.values()].some(s => s.alias.toLowerCase() === lower) || accounts.items.some(a => a.username.toLowerCase() === lower); };
const online = s => s.streams.size > 0;
const displaysAsAdmin = s => s.displayAsAdmin === true && isAdmin(s);
// Optional, self-described profile details that everyone can see. Ages start at 18.
const GENDERS = ['woman', 'man', 'nonbinary', 'other'];
const profileOf = source => ({ ...(GENDERS.includes(source?.gender) ? { gender: source.gender } : {}), ...(Number.isInteger(source?.age) && source.age >= 18 && source.age <= 99 ? { age: source.age } : {}) });
const safeUser = s => ({ id: s.id, alias: s.alias, online: online(s), displayAsAdmin: displaysAsAdmin(s), ...profileOf(s) });
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const write = (s, text) => { for (const stream of s.streams) {
  if (stream.writableLength > 256000) { stream.destroy(); continue; }
  stream.write(text);
} };
const emit = (s, event, data) => { if (s.streams.size) write(s, frame(event, data)); };
// A broadcast is serialized once, not once per connected stream.
const broadcast = (event, data) => { const text = frame(event, data); for (const s of sessions.values()) if (s.streams.size) write(s, text); };
const presenceKey = s => s.accountId || s.id;
function onlinePeople(viewer) {
  const people = new Map();
  for (const session of sessions.values()) {
    if (!online(session)) continue;
    const key = presenceKey(session);
    // Keep one reachable session per account, preferring the viewer's own
    // session so every device correctly labels its single entry as "you".
    if (!people.has(key) || session.id === viewer.id) people.set(key, session);
  }
  return [...people.values()].map(safeUser);
}
// Presence and room lists go to every online session, so one fan-out costs O(online²).
// Fan-outs are coalesced: at most one per interval, and the interval grows with the number
// of online sessions (2 ms each, up to 5 s), so connection churn cannot multiply that cost.
let onlineCount = 0;
function throttled(run) {
  let last = 0, timer = null;
  return () => {
    if (timer) return;
    const interval = Math.min(5000, onlineCount * 2), wait = last + interval - Date.now();
    if (wait <= 0) { last = Date.now(); run(); return; }
    timer = setTimeout(() => { timer = null; last = Date.now(); run(); }, wait);
  };
}
const presence = throttled(() => { for (const session of sessions.values()) if (online(session)) emit(session, 'people', onlinePeople(session)); });
function roomList() {
  // One pass over sessions for every room's head count, instead of one pass per room.
  const present = new Map();
  for (const s of sessions.values()) if (online(s)) { if (!present.has(s.room)) present.set(s.room, new Set()); present.get(s.room).add(presenceKey(s)); }
  const previewOf = message => message?.removedBy ? 'Message removed by an admin' : message?.text?.slice(0, 100) || '';
  return allRooms().map(r => ({ ...r, preview: previewOf((r.persistent ? announcements.messages : histories.get(`room:${r.id}`) || []).at(-1)), count: present.get(r.id)?.size || 0 }));
}
const publishRooms = throttled(() => broadcast('rooms', roomList()));
const privatePreferences = s => ({
  blocks: blocks.list(s).map(item => ({ ...item, peers: [...sessions.values()].filter(peer => userKey(peer) === item.key).map(peer => peer.id) })),
  hiddenChats: [...(s.hiddenChats || [])]
});
const publishPrivatePreferences = s => {
  for (const user of sessions.values()) if (user === s || (s.accountId && user.accountId === s.accountId)) emit(user, 'private-preferences', privatePreferences(user));
};
const ensurePrivateAllowed = (s, peer) => { if (blocks.between(s, peer)) fail(403, 'Private chat is unavailable because one of you has blocked the other.'); };
// Blocking deletes the stored private history between the two people, so a blocked
// sender cannot keep occupying the other person's private storage.
function dropPrivateHistories(user, peer) {
  const mine = [...sessions.values()].filter(s => userKey(s) === userKey(user)), theirs = [...sessions.values()].filter(s => userKey(s) === userKey(peer));
  for (const a of mine) for (const b of theirs) {
    const key = `dm:${[a.id, b.id].sort().join(':')}`;
    if (histories.has(key)) histories.delete(key);
  }
}
const publicSession = s => ({ ...safeUser(s), admin: isAdmin(s), account: Boolean(s.accountId) });
const publishAppearance = s => { emit(s, 'session', publicSession(s)); broadcast('appearance', safeUser(s)); presence(); };
const groups = new Groups({ isAdmin, emit, broadcast, safeUser, attachments, findUser: id => sessionById(id) });
const keyFor = (s, room, peer) => peer ? `dm:${[s.id, peer].sort().join(':')}` : `room:${room}`;
function removeSession(token, session) {
  sessions.delete(token); histories.removeUser(session.id);
  groups.removeUser(session.id); attachments.removeUser(session.id);
  for (const stream of session.streams) stream.end();
}
function publicMentions(text) {
  const mentions = [];
  const candidates = [...sessions.values()];
  for (const person of candidates) {
    const tag = `@${person.alias}`;
    let start = text.indexOf(tag);
    while (start !== -1) {
      const end = start + tag.length;
      if ((start === 0 || /\s/.test(text[start - 1])) && (end === text.length || /[\s.,!?;:()]/.test(text[end]))) mentions.push({ id: person.id, alias: person.alias, start, end });
      start = text.indexOf(tag, end);
    }
  }
  mentions.sort((a, b) => a.start - b.start);
  return mentions.slice(0, 20); // Bound mention highlighting/notifications per message.
}
let saveQueue = Promise.resolve();
function saveBans() {
  const job = saveQueue.then(async () => {
    await writeFile(path.join(dataDir, 'bans.tmp'), JSON.stringify([...bans.values()], null, 2), { mode: 0o600 });
    await rename(path.join(dataDir, 'bans.tmp'), path.join(dataDir, 'bans.json'));
  });
  saveQueue = job.catch(() => {});
  return job;
}
function saveRooms(transform) {
  const job = saveQueue.then(async () => {
    const next = transform(rooms);
    await writeFile(path.join(dataDir, 'rooms.tmp'), JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(path.join(dataDir, 'rooms.tmp'), path.join(dataDir, 'rooms.json'));
    rooms = next;
  });
  saveQueue = job.catch(() => {});
  return job;
}
function saveFeedback(transform) {
  const job = saveQueue.then(async () => {
    const next = transform(feedback);
    await writeFile(path.join(dataDir, 'feedback.tmp'), JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(path.join(dataDir, 'feedback.tmp'), path.join(dataDir, 'feedback.json'));
    feedback = next;
  });
  saveQueue = job.catch(() => {});
  return job;
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function base64Bytes(value, length, maximum = length) {
  if (typeof value !== 'string' || value.length > 24000) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== null ? bytes.length !== length : bytes.length < 17 || bytes.length > maximum)) return null;
  return bytes;
}
function contentLength(req) {
  const value = req.headers['content-length'];
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) fail(411, 'Attachment uploads need a Content-Length.');
  return Number(value);
}
async function body(req, maximum = 32768) {
  // Collect raw bytes and decode once: decoding chunk by chunk corrupts a multi-byte character
  // split across chunks, and re-measuring the growing string made large bodies quadratic.
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maximum) fail(413, 'That request is too large.'); chunks.push(chunk); }
  try { const parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Invalid request.'); return parsed; } catch { fail(400, 'Invalid request.'); }
}
// Static files are read, hashed and compressed once per change, so slow connections download them
// compressed and only when they changed. The modification time is checked so frontend edits still apply on refresh.
const staticAssets = new Map();
async function staticAsset(file) {
  const { mtimeMs } = await stat(file), cached = staticAssets.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached;
  const bytes = await readFile(file);
  const asset = { mtimeMs, bytes, gzip: gzipSync(bytes, { level: 9 }), etag: `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"` };
  staticAssets.set(file, asset); return asset;
}
const staticFiles = { '/': ['about.html', 'text/html'], '/chat/': ['index.html', 'text/html'], '/robots.txt': ['robots.txt', 'text/plain'], '/sitemap.xml': ['sitemap.xml', 'application/xml'], '/about.css': ['about.css', 'text/css'], '/feedback.js': ['feedback.js', 'text/javascript'], '/auth.js': ['auth.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/groups.js': ['groups.js', 'text/javascript'], '/crypto.js': ['crypto.js', 'text/javascript'], '/attachments.js': ['attachments.js', 'text/javascript'], '/vendor/nacl.js': ['../node_modules/tweetnacl/nacl-fast.min.js', 'text/javascript'], '/theme.js': ['theme.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const publicAsset = route => staticAsset(path.join(root, 'public', staticFiles[route][0]));
const assetVersion = asset => asset.etag.slice(1, 13);
// CDNs such as Cloudflare weaken ETags (W/"…") when they compress, and If-None-Match may list several.
const etagMatches = (header, etag) => String(header || '').split(',').some(tag => tag.trim().replace(/^W\//, '') === etag);
// Pages link their scripts and styles with a content version (/app.js?v=…), so a browser, proxy or
// CDN can never combine a new page with old code. A changed file gets a new URL; an unchanged one
// may be cached for a year. The page also carries a build ID that open tabs use to notice updates.
const pages = new Map();
async function versionedPage(file) {
  const html = await staticAsset(path.join(root, 'public', file)), text = html.bytes.toString('utf8');
  const refs = [...new Set([...text.matchAll(/(?:src|href)="(\/[^"?#]+\.(?:js|css|svg))"/g)].map(match => match[1]))].filter(ref => staticFiles[ref]);
  const versions = new Map(await Promise.all(refs.map(async ref => [ref, assetVersion(await publicAsset(ref))])));
  const build = createHash('sha256').update(html.etag + JSON.stringify([...versions])).digest('base64url').slice(0, 16);
  const cached = pages.get(file);
  if (cached?.build === build) return cached;
  const bytes = Buffer.from(text.replace(/((?:src|href)=")(\/[^"?#]+\.(?:js|css|svg))"/g, (match, attribute, ref) => versions.has(ref) ? `${attribute}${ref}?v=${versions.get(ref)}"` : match)
    .replace('<head>', `<head>\n  <meta name="silenza-build" content="${build}">`));
  const page = { build, bytes, gzip: gzipSync(bytes, { level: 9 }), etag: `"${build}"` };
  pages.set(file, page); return page;
}
const devHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.HOST && !['0.0.0.0', '::'].includes(process.env.HOST) ? [process.env.HOST.includes(':') ? `[${process.env.HOST}]` : process.env.HOST] : [])].map(x => x.toLowerCase()));
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (configuredOrigin?.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && ['/about', '/about/', '/chat'].includes(url.pathname)) { res.writeHead(301, { Location: url.pathname === '/chat' ? '/chat/' : '/' }); res.end(); return; }
      if (req.method !== 'GET' || !staticFiles[url.pathname]) fail(404, 'Not found.');
      const [file, type] = staticFiles[url.pathname], page = type === 'text/html';
      const asset = page ? await versionedPage(file) : await publicAsset(url.pathname);
      // Pages and unversioned URLs revalidate every load (an unchanged file costs a 304, not a download).
      // A URL carrying the file's current version never changes, so it is cached for a year.
      const immutable = !page && url.searchParams.get('v') === assetVersion(asset);
      const headers = { 'Content-Type': type, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ETag: asset.etag, Vary: 'Accept-Encoding' };
      if (etagMatches(req.headers['if-none-match'], asset.etag)) { res.writeHead(304, headers); res.end(); return; }
      const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, gzip ? { ...headers, 'Content-Encoding': 'gzip' } : headers); res.end(gzip ? asset.gzip : asset.bytes); return;
    }
    if (logClientAddress) {
      // Opt-in, one-time diagnostic for configuring TRUSTED_PROXY_ADDRESSES. Disable it again afterwards.
      logClientAddress = false;
      console.log('Client address diagnostic:', JSON.stringify({ socket: req.socket.remoteAddress, forwardedFor: req.headers['x-forwarded-for'] || null, realIp: req.headers['x-real-ip'] || null, cfConnectingIp: req.headers['cf-connecting-ip'] || null }));
    }
    // Without a configured ORIGIN (local development), only loopback host names are accepted,
    // so a DNS-rebinding page cannot pass the same-origin check below.
    if (!configuredOrigin && !devHosts.has(String(req.headers.host).toLowerCase().replace(/:\d+$/, ''))) fail(403, 'Set ORIGIN to serve SilenzaChat on this host name.');
    const origin = configuredOrigin || `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== origin) fail(403, 'Request origin is not allowed.');
    if (req.method !== 'GET' && req.headers.origin !== origin) fail(403, 'Request origin is not allowed.');
    const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('silenza='))?.slice(8);
    if (token && bans.has(hash(token).toString('hex'))) fail(403, 'This anonymous session has been banned.');
    let session = sessions.get(token);
    const cookie = secret => res.setHeader('Set-Cookie', `silenza=${secret}; HttpOnly; SameSite=Strict; Path=/${process.env.SECURE_COOKIES === 'true' || origin.startsWith('https:') ? '; Secure' : ''}`);
    if (url.pathname === '/api/auth/status' && req.method === 'GET') { json({ me: session ? publicSession(session) : null }); return; }
    if (url.pathname === '/api/version' && req.method === 'GET') { json({ build: (await versionedPage('index.html')).build }); return; }
    if (['/api/auth/login', '/api/auth/register'].includes(url.pathname) && req.method === 'POST') {
      const input = await body(req, 4096);
      const clientKey = security.client(req);
      security.auth(clientKey, input.username);
      sessionCapacity(sessions, session?.accountId || 'pending-account', session, clientKey);
      if (session?.accountId && url.pathname.endsWith('/register')) fail(409, 'Sign out before creating another account.');
      if (url.pathname.endsWith('/register')) {
        if (security.clientBanned(clientKey)) fail(403, 'New accounts cannot be created from this network right now.');
        security.register(clientKey);
      }
      const account = url.pathname.endsWith('/register') ? await accounts.create(input.username, input.password, 'member', clientKey) : await accounts.authenticate(input.username, input.password, clientKey);
      if ([...bans.values()].some(ban => ban.accountId === account.id)) fail(403, 'This account is banned.');
      if (session && sessions.get(token) !== session) fail(401, 'Your session changed. Please try again.');
      if (session?.accountId && session.accountId !== account.id) fail(409, 'Sign out before switching accounts.');
      sessionCapacity(sessions, account.id, session, clientKey);
      // Crossing from a guest identity to an account must not broadcast a link
      // from the guest's public sender ID or retain its encryption identity.
      if (session && !session.accountId) { removeSession(token, session); session = null; }
      if (!session) session = { id: randomUUID(), streams: new Set(), room: rooms[0]?.id, seen: Date.now(), sent: [], clientKey };
      security.authenticated(clientKey, input.username);
      session.seen = Date.now();
      session.accountId = account.id; session.alias = account.username; session.displayAsAdmin = false;
      delete session.gender; delete session.age; Object.assign(session, profileOf(account));
      sessions.delete(token);
      const secret = randomBytes(32).toString('hex'); sessions.set(secret, session); cookie(secret);
      publishAppearance(session); publishRooms();
      for (const stream of session.streams) stream.end();
      json(publicSession(session)); return;
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      if (session) {
        removeSession(token, session);
        presence(); publishRooms();
      }
      res.setHeader('Set-Cookie', 'silenza=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      json({ ok: true }); return;
    }
    if (url.pathname === '/api/session' && req.method === 'GET') {
      if (!session) {
        const clientKey = security.client(req);
        if (security.clientBanned(clientKey)) fail(403, 'New guest sessions cannot be started from this network right now.');
        security.guest(clientKey); sessionCapacity(sessions, undefined, undefined, clientKey);
        const secret = randomBytes(32).toString('hex');
        session = { id: randomUUID(), alias: randomAlias(aliasTaken), streams: new Set(), room: rooms[0]?.id, seen: Date.now(), sent: [], clientKey };
        sessions.set(secret, session);
        cookie(secret);
      }
      session.seen = Date.now();
      const conversations = [...sessions.values()].filter(s => s.id !== session.id && histories.has(keyFor(session, null, s.id)) && !session.hiddenChats?.has(s.id) && !blocks.between(session, s)).map(safeUser);
      json({ me: publicSession(session), attachmentLimit: attachments.maxItem, attachmentLifetime: attachments.ttl, rooms: roomList(), groups: groups.list(session), people: onlinePeople(session), conversations, ...privatePreferences(session) }); return;
    }
    if (!session) fail(401, 'Your anonymous session expired. Refresh to rejoin.');
    session.seen = Date.now();
    if (url.pathname === '/api/groups' || url.pathname.startsWith('/api/groups/')) {
      const action = url.pathname.slice('/api/groups'.length).replace(/^\//, '');
      if (req.method === 'POST' && ['message', 'message-edit'].includes(action)) security.message(session.clientKey);
      const input = req.method === 'POST' ? await body(req, ['message', 'message-edit', 'history-share'].includes(action) ? 512000 : 32768) : Object.fromEntries(url.searchParams);
      // Recheck after reading the request, since a ban may occur during a slow upload.
      if (sessions.get(token) !== session) fail(403, 'This session is no longer available.');
      json(groups.handle(req.method, action, session, input)); return;
    }
    if (url.pathname === '/api/private/preferences' && req.method === 'GET') { json(privatePreferences(session)); return; }
    if (url.pathname === '/api/identity' && req.method === 'GET') {
      const peer = sessionById(url.searchParams.get('peer'));
      if (peer) ensurePrivateAllowed(session, peer);
      if (!peer?.publicKey) fail(409, 'This person has not enabled private encryption yet. They need to open or refresh SilenzaChat.');
      json({ id: peer.id, publicKey: peer.publicKey, ...(peer.signKey ? { signKey: peer.signKey } : {}) }); return;
    }
    if (url.pathname === '/api/attachments' && req.method === 'POST') {
      if (url.searchParams.has('group')) {
        const group = groups.get(url.searchParams.get('group')), version = Number(url.searchParams.get('version'));
        groups.member(group, session);
        if (!session.publicKey || version !== group.version) fail(409, 'Room membership changed. Try sending again.');
        if (req.headers['content-type'] !== 'application/octet-stream') fail(415, 'Upload encrypted attachment bytes only.');
        const uploaded = await attachments.upload(req, session.id, null, { group: group.id, version }, session.clientKey, contentLength(req));
        if (sessions.get(token) !== session || groups.rooms.get(group.id) !== group || groups.expired(group) || !group.members.has(session.id) || group.version !== version) {
          attachments.remove(uploaded.id); fail(409, 'Room membership changed during upload. Try sending again.');
        }
        json(uploaded); return;
      }
      const peer = sessionById(url.searchParams.get('peer'));
      if (!peer || peer.id === session.id) fail(404, 'That person is no longer available.');
      ensurePrivateAllowed(session, peer);
      if (!session.publicKey || !peer.publicKey) fail(409, 'Both people need encryption identities before uploading.');
      if (req.headers['content-type'] !== 'application/octet-stream') fail(415, 'Upload encrypted attachment bytes only.');
      const uploaded = await attachments.upload(req, session.id, peer.id, {}, session.clientKey, contentLength(req));
      // A ban or session expiry may have happened while reading the upload.
      if (sessions.get(token) !== session || sessionById(peer.id) !== peer) { attachments.remove(uploaded.id); fail(403, 'This private session is no longer available.'); }
      if (blocks.between(session, peer)) { attachments.remove(uploaded.id); ensurePrivateAllowed(session, peer); }
      json(uploaded); return;
    }
    if (url.pathname.startsWith('/api/attachments/')) {
      const id = url.pathname.slice('/api/attachments/'.length), item = attachments.get(id, session.id);
      if (item.group && req.method === 'GET') groups.checkAttachment(item, session);
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': item.bytes.length, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment' }); res.end(item.bytes); return;
      }
      if (req.method === 'DELETE' && item.owner === session.id && !item.message) { attachments.remove(id); json({ ok: true }); return; }
      fail(403, 'That attachment cannot be removed here.');
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (session.streams.size >= 6) fail(429, 'Too many open tabs.');
      const clientKey = security.client(req);
      security.events(clientKey);
      const clientStreams = [...streamClients.values()].filter(key => key === clientKey).length;
      if (streamClients.size >= 2000 || clientStreams >= 30) fail(429, 'Too many active connections. Try again shortly.');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n: connected\n\n'); session.connected = true; session.streams.add(res); streamClients.set(res, clientKey); onlineCount = streamClients.size;
      // The new stream gets an immediate, current snapshot; everyone else gets the coalesced fan-out.
      emit(session, 'people', onlinePeople(session)); emit(session, 'rooms', roomList()); presence(); publishRooms(); emit(session, 'groups-changed', {});
      // A named event rather than a comment, so the browser can notice a connection that silently stopped delivering.
      const timer = setInterval(() => { session.seen = Date.now(); res.write('event: ping\ndata: {}\n\n'); }, 15000);
      res.on('close', () => { clearInterval(timer); session.streams.delete(res); streamClients.delete(res); onlineCount = streamClients.size; presence(); publishRooms(); }); return;
    }
    if (url.pathname === '/api/history' && req.method === 'GET') {
      const peer = url.searchParams.get('peer'), room = url.searchParams.get('room');
      if (peer ? !sessionById(peer) : !allRooms().some(r => r.id === room)) fail(404, 'Conversation is no longer available.');
      json(!peer && room === announcementRoom.id ? announcements.messages : histories.get(keyFor(session, room, peer)) || []); return;
    }
    if (url.pathname === '/api/admin/feedback' && req.method === 'GET') {
      if (!isAdmin(session)) fail(403, 'Unlock admin controls first.');
      json(feedback); return;
    }
    if (url.pathname === '/api/admin/state' && req.method === 'GET') {
      if (!isAdmin(session)) fail(403, 'Unlock admin controls first.');
      json({ people: onlinePeople(session), bans: [...bans.values()].map(({ id, alias, bannedAt }) => ({ id, alias, bannedAt })), groups: groups.moderate('list', session) }); return;
    }
    if (req.method !== 'POST') fail(404, 'Not found.');
    if (['/api/message', '/api/message/edit'].includes(url.pathname)) security.message(session.clientKey);
    const input = await body(req);
    if (sessions.get(token) !== session) fail(401, 'Your session has ended.');
    if (['/api/auth/password', '/api/auth/logout-all', '/api/auth/delete'].includes(url.pathname)) {
      const account = accounts.get(session.accountId);
      if (!account) fail(403, 'Sign in to an account first.');
      const clientKey = security.client(req);
      const signOutOthers = () => { for (const [secret, s] of sessions) if (s !== session && s.accountId === account.id) removeSession(secret, s); };
      if (url.pathname === '/api/auth/logout-all') {
        signOutOthers(); presence(); publishRooms(); json({ ok: true }); return;
      }
      security.auth(clientKey, account.username);
      if (url.pathname === '/api/auth/password') {
        if (typeof input.password !== 'string' || input.password === input.current) fail(400, 'Choose a new password that differs from the current one.');
        await accounts.changePassword(account.id, input.current, input.password, clientKey);
        security.authenticated(clientKey, account.username);
        // A password change ends every other session and rotates this session's cookie.
        if (sessions.get(token) === session) {
          signOutOthers(); sessions.delete(token);
          const secret = randomBytes(32).toString('hex'); sessions.set(secret, session); cookie(secret);
        }
        presence(); publishRooms(); json({ ok: true }); return;
      }
      await accounts.remove(account.id, input.password, clientKey);
      await blocks.removeAccount(account.id);
      for (const [secret, s] of sessions) if (s.accountId === account.id) removeSession(secret, s);
      res.setHeader('Set-Cookie', 'silenza=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      presence(); publishRooms(); json({ ok: true }); return;
    }
    if (url.pathname === '/api/profile') {
      if (Object.keys(input).some(key => !['gender', 'age'].includes(key))) fail(400, 'Invalid profile.');
      if (input.gender != null && input.gender !== '' && !GENDERS.includes(input.gender)) fail(400, 'Choose one of the listed genders, or leave it empty.');
      if (input.age != null && (!Number.isInteger(input.age) || input.age < 18 || input.age > 99)) fail(400, 'Enter an age between 18 and 99, or leave it empty.');
      const profile = profileOf(input);
      if (JSON.stringify(profileOf(session)) === JSON.stringify(profile)) { json(publicSession(session)); return; }
      session.profileSaves = (session.profileSaves || []).filter(t => Date.now() - t < 60000);
      if (session.profileSaves.length >= 5) fail(429, 'You changed your profile several times. Try again in a minute.');
      session.profileSaves.push(Date.now());
      // An account keeps its profile across logins; a guest's lasts for the session.
      if (session.accountId) await accounts.save(items => items.map(a => {
        if (a.id !== session.accountId) return a;
        const { gender, age, ...rest } = a; return { ...rest, ...profile };
      }));
      for (const s of sessions.values()) if (s === session || (session.accountId && s.accountId === session.accountId)) {
        delete s.gender; delete s.age; Object.assign(s, profile); publishAppearance(s);
      }
      json(publicSession(session)); return;
    }
    if (url.pathname === '/api/private/block') {
      if (typeof input.blocked !== 'boolean') fail(400, 'Choose block or unblock.');
      const peer = sessionById(input.peer);
      const existing = blocks.list(session).find(item => item.key === input.key);
      if (input.blocked && (!peer || userKey(peer) === userKey(session))) fail(400, 'Choose another user to block.');
      if (!input.blocked && !existing) fail(404, 'Blocked user not found.');
      if (input.blocked && blocks.list(session).length >= 500 && !blocks.has(session, peer)) fail(400, 'Your blocked list is full.');
      await blocks.update(session, input.blocked ? userKey(peer) : existing.key, input.blocked ? peer.alias : existing.alias, input.blocked);
      if (input.blocked) dropPrivateHistories(session, peer);
      publishPrivatePreferences(session); json(privatePreferences(session)); return;
    }
    // Read receipts: the recipient marks everything the peer sent up to a message as seen, and the
    // sender's sessions are told which messages were read. Only the server-held times change.
    if (url.pathname === '/api/private/read') {
      const peer = sessionById(input.peer);
      if (!peer || peer.id === session.id || typeof input.id !== 'string') fail(404, 'That conversation is no longer available.');
      ensurePrivateAllowed(session, peer);
      const history = histories.get(keyFor(session, null, peer.id)) || [];
      const index = history.findIndex(m => m.id === input.id && m.sender === peer.id);
      if (index < 0) fail(404, 'That message is no longer available.');
      const readAt = new Date().toISOString(), ids = [];
      for (const message of history.slice(0, index + 1)) if (message.sender === peer.id && !message.readAt) { message.readAt = readAt; ids.push(message.id); }
      if (ids.length) { const read = { sender: peer.id, recipient: session.id, ids, readAt }; emit(peer, 'messages-read', read); emit(session, 'messages-read', read); }
      json({ ids }); return;
    }
    if (url.pathname === '/api/private/hide' || url.pathname === '/api/private/show') {
      if (typeof input.peer !== 'string' || !/^[0-9a-f-]{36}$/.test(input.peer) || input.peer === session.id) fail(400, 'Choose a private conversation.');
      if (url.pathname.endsWith('/show') && !sessionById(input.peer)) fail(404, 'Conversation is no longer available.');
      session.hiddenChats ||= new Set();
      if (url.pathname.endsWith('/hide') && session.hiddenChats.size >= 5000 && !session.hiddenChats.has(input.peer)) fail(400, 'Too many hidden conversations.');
      if (url.pathname.endsWith('/hide')) session.hiddenChats.add(input.peer);
      else session.hiddenChats.delete(input.peer);
      publishPrivatePreferences(session); json({ ok: true }); return;
    }
    if (url.pathname === '/api/feedback') {
      if (sessions.get(token) !== session) fail(403, 'This session is no longer available.');
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!title || title.length > 120 || !text || text.length > 5000) fail(400, 'Add a title (up to 120 characters) and feedback (up to 5,000 characters).');
      session.feedbackSent = (session.feedbackSent || []).filter(time => Date.now() - time < 600000);
      if (session.feedbackSent.length >= 3) fail(429, 'You have sent several messages. Please wait 10 minutes before sending more feedback.');
      // New guest sessions are cheap, so feedback is also limited per network.
      security.feedback(security.client(req));
      const attempt = Date.now(); session.feedbackSent.push(attempt);
      const item = { id: randomUUID(), title, text, createdAt: new Date().toISOString(), reviewed: false };
      try {
        await saveFeedback(items => {
          if (items.length >= 1000) fail(503, 'The feedback inbox is full. Please try again later.');
          return [item, ...items];
        });
      } catch (e) { session.feedbackSent.splice(session.feedbackSent.indexOf(attempt), 1); throw e; }
      json({ ok: true }, 201); return;
    }
    if (url.pathname === '/api/identity') {
      const bytes = base64Bytes(input.publicKey, 32);
      if (!bytes || nacl.scalarMult(new Uint8Array(32).fill(42), bytes).every(x => x === 0)) fail(400, 'Invalid public encryption key.');
      if (session.publicKey && session.publicKey !== input.publicKey) fail(409, 'Your local encryption key does not match this session. Start a new browser session to chat privately.');
      // The signing key (for shareable room history) is optional for older clients and fixed once set.
      if (input.signKey !== undefined && !base64Bytes(input.signKey, 32)) fail(400, 'Invalid public signing key.');
      if (session.signKey && input.signKey !== undefined && session.signKey !== input.signKey) fail(409, 'Your local encryption key does not match this session. Start a new browser session to chat privately.');
      if (input.signKey !== undefined) session.signKey = input.signKey;
      const first = !session.publicKey; session.publicKey = input.publicKey;
      if (first) broadcast('identity-ready', { id: session.id });
      json({ ok: true }); return;
    }
    if (url.pathname === '/api/join') {
      if (!allRooms().some(r => r.id === input.room)) fail(404, 'Room no longer exists.');
      session.room = input.room; publishRooms(); json({ ok: true }); return;
    }
    const announcementSend = url.pathname === '/api/message' && !input.peer && input.room === announcementRoom.id;
    const announcementEdit = url.pathname === '/api/message/edit';
    const announcementDelete = ['/api/message/delete', '/api/admin/remove-message'].includes(url.pathname);
    if (announcementSend || ((announcementEdit || announcementDelete) && announcements.messages.some(m => m.id === input.id))) {
      if (!isAdmin(session)) fail(403, 'Only admins can post or change announcements.');
      if (!announcementDelete) {
        session.sent = session.sent.filter(t => Date.now() - t < 10000);
        if (session.sent.length >= 8) fail(429, 'Take a breath. Try again in a few seconds.');
      }
      const allowed = announcementSend ? ['room', 'text', 'replyTo'] : announcementEdit ? ['id', 'text', 'editVersion'] : ['id'];
      if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Invalid announcement.');
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!announcementDelete && (!text || text.length > 2000)) fail(400, 'Use between 1 and 2,000 characters.');
      if (!announcementDelete) session.sent.push(Date.now());
      const result = await announcements.update(items => {
        if (sessions.get(token) !== session || !isAdmin(session)) fail(403, 'Your admin session has ended.');
        if (announcementSend) {
          const original = input.replyTo == null ? null : items.find(m => m.id === input.replyTo);
          if (input.replyTo != null && !original) fail(400, 'That announcement is no longer available.');
          const message = { id: randomUUID(), sender: session.id, alias: session.alias, displayAsAdmin: true,
            text, time: new Date().toISOString(), room: announcementRoom.id, recipient: null, mentions: [],
            reply: original ? { id: original.id, alias: original.alias, text: original.text.slice(0, 200) } : null };
          items.push(message); return message;
        }
        const index = items.findIndex(m => m.id === input.id);
        if (index < 0) fail(404, 'That announcement is no longer available.');
        const message = items[index];
        if (announcementEdit) {
          if (input.editVersion !== (message.editVersion || 0) + 1) fail(409, 'This announcement changed. Reopen the editor and try again.');
          message.text = text; message.editVersion = input.editVersion; message.editedAt = new Date().toISOString();
          for (const reply of items) if (reply.reply?.id === message.id) reply.reply.text = text.slice(0, 200);
          return message;
        }
        items.splice(index, 1);
        for (const reply of items) if (reply.reply?.id === message.id) reply.reply = { id: message.id, removed: true };
        return { id: message.id, room: message.room, sender: message.sender, recipient: null };
      });
      broadcast(announcementSend ? 'message' : announcementEdit ? 'message-edited' : 'message-removed', result);
      publishRooms(); json(result); return;
    }
    if (url.pathname === '/api/message/edit') {
      if (sessions.get(token) !== session) fail(403, 'This session is no longer available.');
      let message, history, conversation;
      histories.sweep(new Set([...sessions.values()].map(s => s.id)));
      for (const [key, items] of histories) {
        const found = items.find(m => m.id === input.id && m.sender === session.id && !m.removedBy);
        if (found) { message = found; history = items; conversation = key; break; }
      }
      if (!message) fail(404, 'Your message is no longer available to edit.');
      if (input.editVersion !== (message.editVersion || 0) + 1) fail(409, 'This message changed. Reopen the editor and try again.');
      session.sent = session.sent.filter(t => Date.now() - t < 10000);
      if (session.sent.length >= 8) fail(429, 'Take a breath. Try again in a few seconds.');
      if (message.encrypted) {
        const peer = sessionById(message.recipient);
        if (!peer) fail(404, 'That person is no longer available.');
        ensurePrivateAllowed(session, peer);
        if (Object.keys(input).some(k => !['id', 'editVersion', 'encrypted'].includes(k))) fail(400, 'Private edits must contain ciphertext only.');
        const box = input.encrypted;
        if (!box || box.v !== 1 || Object.keys(box).some(k => !['v', 'nonce', 'ciphertext'].includes(k)) ||
            !base64Bytes(box.nonce, 24) || !base64Bytes(box.ciphertext, null, 18000)) fail(400, 'Invalid encrypted private message.');
        const next = { ...message, encrypted: box, editVersion: input.editVersion, editedAt: new Date().toISOString() };
        histories.set(conversation, history.map(m => m === message ? next : m));
        message = next;
      } else {
        if (Object.keys(input).some(k => !['id', 'editVersion', 'text'].includes(k))) fail(400, 'Invalid message edit.');
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (!text || text.length > 2000) fail(400, 'Use between 1 and 2,000 characters.');
        message.text = text; message.mentions = publicMentions(text);
        for (const reply of history) if (reply.reply?.id === message.id) reply.reply.text = text.slice(0, 200);
      }
      message.editVersion = input.editVersion; message.editedAt = new Date().toISOString();
      session.sent.push(Date.now());
      if (message.room) { broadcast('message-edited', message); publishRooms(); }
      else for (const person of sessions.values()) if ([message.sender, message.recipient].includes(person.id)) emit(person, 'message-edited', message);
      json(message); return;
    }
    if (url.pathname === '/api/message') {
      session.sent = session.sent.filter(t => Date.now() - t < 10000);
      if (session.sent.length >= 8) fail(429, 'Take a breath. Try again in a few seconds.');
      if (input.peer) {
        const peer = sessionById(input.peer);
        if (!peer || peer.id === session.id) fail(404, 'That person is no longer available.');
        ensurePrivateAllowed(session, peer);
        if (!session.publicKey || !peer.publicKey) fail(409, 'Private encryption is not ready.');
        if (Object.keys(input).some(key => !['peer', 'id', 'encrypted', 'replyTo', 'attachmentId'].includes(key))) fail(400, 'Private messages must contain ciphertext only.');
        const box = input.encrypted;
        if (!box || box.v !== 1 || Object.keys(box).some(k => !['v', 'nonce', 'ciphertext'].includes(k)) ||
            !base64Bytes(box.nonce, 24) || !base64Bytes(box.ciphertext, null, 18000) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.id || '')) fail(400, 'Invalid encrypted private message.');
        const key = keyFor(session, null, peer.id), history = histories.get(key) || [];
        const duplicate = history.find(m => m.id === input.id);
        if (duplicate) {
          if (duplicate.sender !== session.id || JSON.stringify(duplicate.encrypted) !== JSON.stringify(box) || (duplicate.reply?.id || null) !== (input.replyTo || null) || (duplicate.attachment?.id || null) !== (input.attachmentId || null)) fail(409, 'Message ID already used.');
          json(duplicate); return;
        }
        const original = input.replyTo == null ? null : history.find(m => m.id === input.replyTo);
        if (input.replyTo != null && !original) fail(400, 'That reply is no longer available in this conversation.');
        const upload = input.attachmentId == null ? null : attachments.get(input.attachmentId, session.id);
        const attachment = upload ? { id: input.attachmentId, expiresAt: upload.createdAt + attachments.ttl } : null;
        const message = { id: input.id, sender: session.id, alias: session.alias, recipient: peer.id, room: null,
          time: new Date().toISOString(), displayAsAdmin: displaysAsAdmin(session), encrypted: box, reply: original ? { id: original.id } : null, attachment };
        const nextHistory = [...history, message].slice(-100);
        histories.check(key, nextHistory);
        if (attachment) attachments.claim(attachment.id, session.id, peer.id, input.id);
        histories.set(key, nextHistory); session.sent.push(Date.now());
        session.hiddenChats?.delete(peer.id); peer.hiddenChats?.delete(session.id);
        emit(session, 'message', message); emit(peer, 'message', message); json(message); return;
      }
      if (input.encrypted || input.attachmentId) fail(400, 'Encrypted attachments belong in private conversations.');
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 2000) fail(400, 'Use between 1 and 2,000 characters.');
      const peer = input.peer && sessionById(input.peer);
      if (input.peer && (!peer || peer.id === session.id)) fail(404, 'That person is no longer available.');
      if (!input.peer && !allRooms().some(r => r.id === input.room)) fail(404, 'Room no longer exists.');
      const key = keyFor(session, input.room, peer?.id);
      const original = input.replyTo == null ? null : (histories.get(key) || []).find(m => m.id === input.replyTo && !m.removedBy);
      if (input.replyTo != null && !original) fail(400, 'That reply is no longer available in this conversation.');
      const mentions = publicMentions(text);
      session.sent.push(Date.now());
      const message = { id: randomUUID(), sender: session.id, alias: session.alias, displayAsAdmin: displaysAsAdmin(session), text, time: new Date().toISOString(), room: peer ? null : input.room, recipient: peer?.id || null, mentions,
        reply: original ? { id: original.id, alias: original.alias, text: original.text.slice(0, 200) } : null };
      histories.set(key, [...(histories.get(key) || []), message].slice(-100));
      if (peer) { emit(session, 'message', message); emit(peer, 'message', message); }
      else { broadcast('message', message); publishRooms(); }
      json(message); return;
    }
    if (url.pathname.startsWith('/api/admin/') && !isAdmin(session)) fail(403, 'Unlock admin controls first.');
    if (url.pathname === '/api/admin/groups/update' || url.pathname === '/api/admin/groups/delete') {
      json(groups.moderate(url.pathname.split('/').pop(), session, input)); return;
    }
    if (url.pathname === '/api/admin/feedback/update' || url.pathname === '/api/admin/feedback/delete') {
      const removing = url.pathname.endsWith('/delete');
      if (!removing && typeof input.reviewed !== 'boolean') fail(400, 'Choose a feedback status.');
      await saveFeedback(items => {
        if (!items.some(item => item.id === input.id)) fail(404, 'Feedback no longer exists.');
        return removing ? items.filter(item => item.id !== input.id) : items.map(item => item.id === input.id ? { ...item, reviewed: input.reviewed } : item);
      });
      json({ ok: true }); return;
    }
    if (url.pathname === '/api/admin/appearance') {
      if (typeof input.displayAsAdmin !== 'boolean') fail(400, 'Choose whether to display as admin.');
      session.displayAsAdmin = input.displayAsAdmin;
      publishAppearance(session); json(publicSession(session)); return;
    }
    if (url.pathname === '/api/admin/create') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      if (!name || name.length > 40 || description.length > 120) fail(400, 'Room names must be 1–40 characters; descriptions up to 120.');
      const room = { id: randomUUID(), name, description };
      await saveRooms(existing => {
        if (existing.length >= 30) fail(400, 'Maximum of 30 rooms reached.');
        if (existing.some(r => r.name.toLowerCase() === name.toLowerCase())) fail(400, 'That room name is already in use.');
        return [...existing, room];
      }); publishRooms(); json(room); return;
    }
    if (url.pathname === '/api/admin/delete') {
      if (input.id === announcementRoom.id) fail(403, 'The Announcements room cannot be removed.');
      await saveRooms(existing => {
        if (!existing.some(r => r.id === input.id)) fail(404, 'Room no longer exists.');
        return existing.filter(r => r.id !== input.id);
      }); histories.delete(`room:${input.id}`);
      for (const s of sessions.values()) if (s.room === input.id) s.room = rooms[0]?.id;
      publishRooms(); json({ ok: true }); return;
    }
    if (url.pathname === '/api/admin/ban') {
      const target = [...sessions.entries()].find(([, s]) => s.id === input.id);
      if (!target) fail(404, 'That person is no longer available.');
      if (target[1].id === session.id || (session.accountId && target[1].accountId === session.accountId)) fail(400, 'You cannot ban your own session.');
      const [targetToken, person] = target;
      const key = hash(targetToken).toString('hex');
      bans.set(key, { key, id: person.id, alias: person.alias, accountId: person.accountId, bannedAt: new Date().toISOString() });
      try { await saveBans(); } catch (error) { bans.delete(key); throw error; }
      // Stop a banned guest from immediately returning with a fresh cookie. This is a
      // 24-hour, memory-only block of the network key (never written to disk). Skip it
      // when anyone else, including the admin, is currently using that network key (shared Wi-Fi, CGNAT or a misconfigured proxy).
      const shared = [...sessions.values()].some(s => s.clientKey === person.clientKey && userKey(s) !== userKey(person));
      const networkBlocked = Boolean(person.clientKey) && !shared && person.clientKey !== session.clientKey;
      if (networkBlocked) security.banClient(person.clientKey, person.id);
      for (const stream of person.streams) stream.end();
      for (const [secret, s] of sessions) if (secret === targetToken || (person.accountId && s.accountId === person.accountId)) {
        removeSession(secret, s);
      } presence(); publishRooms(); broadcast('moderation', {});
      json({ ok: true, networkBlocked }); return;
    }
    if (url.pathname === '/api/admin/unban') {
      const entries = [...bans.entries()].filter(([, ban]) => ban.id === input.id);
      if (!entries.length) fail(404, 'That ban no longer exists.');
      for (const [key] of entries) bans.delete(key);
      try { await saveBans(); } catch (error) { for (const [key, ban] of entries) bans.set(key, ban); throw error; }
      security.unbanClient(input.id);
      broadcast('moderation', {});
      json({ ok: true }); return;
    }
    if (url.pathname === '/api/message/delete' || url.pathname === '/api/admin/remove-message') {
      const adminRemoval = url.pathname === '/api/admin/remove-message';
      histories.sweep(new Set([...sessions.values()].map(s => s.id)));
      let found, conversation;
      for (const [key, history] of histories) {
        // Admins moderate public rooms only. Private message IDs are chosen by clients, so a private
        // message reusing a public message's ID must never shadow it and defeat an admin removal.
        if (adminRemoval && !key.startsWith('room:')) continue;
        const message = history.find(m => m.id === input.id && (adminRemoval || (m.sender === session.id && !m.removedBy)));
        if (message) { found = message; conversation = key; break; }
      }
      if (!found) fail(404, 'That message is unavailable or does not belong to you.');
      attachments.remove(found.attachment?.id);
      // When an admin removes someone else's message, a notice without the text takes its place, so the
      // room can see that moderation happened. Removing that notice again deletes it entirely.
      const notice = adminRemoval && found.sender !== session.id && !found.removedBy ? { id: found.id, sender: found.sender, alias: found.alias,
        displayAsAdmin: found.displayAsAdmin, time: found.time, room: found.room, recipient: null, text: '', mentions: [], reply: null, removedBy: 'admin' } : null;
      const remaining = histories.get(conversation).flatMap(message => message.id !== found.id ? [message] : notice ? [notice] : []);
      for (const message of remaining) if (message.reply?.id === found.id) message.reply = { id: found.id, removed: true };
      histories.set(conversation, remaining);
      const removed = { id: found.id, room: found.room, sender: found.sender, recipient: found.recipient, ...(notice ? { notice } : {}) };
      if (found.room) { broadcast('message-removed', removed); publishRooms(); }
      else for (const s of sessions.values()) if (s.id === found.sender || s.id === found.recipient) emit(s, 'message-removed', removed);
      json(removed); return;
    }
    fail(404, 'Not found.');
  } catch (error) { if (!res.headersSent) json({ error: error.status ? error.message : 'Something went wrong. Please try again.' }, error.status || 500); else res.end(); }
});
// Slow request bodies cannot hold upload reservations or sockets for Node's 5-minute default.
// (Event streams are unaffected: these limits apply only while the request itself is received.)
server.requestTimeout = 180000; // Three minutes lets a maximum-size attachment finish on a slower connection.
server.headersTimeout = 20000;
setInterval(() => {
  // Sessions that never opened the chat stream (abandoned or scripted) expire after 10 minutes.
  for (const [token, s] of sessions) if (!online(s) && Date.now() - s.seen > (s.connected ? 86400000 : 600000)) {
    removeSession(token, s);
  }
  // Open streams refresh `seen` with every heartbeat, so this only ends memberships after 15 minutes away.
  for (const s of sessions.values()) if (!online(s) && Date.now() - s.seen > 900000) groups.leaveAll(s.id);
  histories.sweep(new Set([...sessions.values()].map(s => s.id)));
  attachments.sweep();
  groups.sweep();
  security.sweep();
}, 60000).unref();
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`SilenzaChat is running at ${process.env.ORIGIN || `http://localhost:${process.env.PORT || 3000}`}`);
});
