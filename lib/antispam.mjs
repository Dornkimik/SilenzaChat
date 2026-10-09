import { randomBytes } from 'node:crypto';

// Spam defence for the main (public, unencrypted) rooms, plus a soft trust ladder.
// Word lists are easy to dodge, so messages are folded into a "skeleton" that undoes common
// disguises (look-alike letters, leetspeak, invisible characters, spaced-out letters), and the
// disguises themselves count as evidence. Everything here is memory-only and keyed by the
// existing HMAC'd client keys.

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const pairs = text => new Map(Array.from({ length: text.length / 2 }, (_, i) => [text[i * 2], text[i * 2 + 1]]));
// Cyrillic, Greek and small-capital look-alikes (both cases), plus currency and other symbols used as letters.
const CONFUSABLES = pairs('АaВbСcЕeНhІiЈjКkМmОoРpЅsТtХxУyаaвbсcеeһhіiјjкkмmнhоoрpԛqѕsтtуyхxүyԝwьbгrпnӏl' +
  'ΑaΒbΕeΗhΙiΚkΜmΝnΟoΡpΤtΥyΧxΖzαaβbεeηnιiκkνvοoρpτtυuχxγyωwμuϲcσoςs' +
  'ᴀaʙbᴄcᴅdᴇeғfɢgʜhɪiᴊjᴋkʟlᴍmɴnᴏoᴘpǫqʀrꜱsᴛtᴜuᴠvᴡwʏyᴢzøođdłlħhıi€e£l¥y¢c©c®r∂dπn');
// Leetspeak as equivalence classes: 1, l, i, | and ! all become "i", so "1" being an i or an l stops mattering.
const LEET = pairs('0o1ili|i!i¡i3e4a@a5s$s7t+t8b9g6g2z');
// Digit-only leetspeak for finding web addresses, tried with 1 as both "i" and "l" (s1te, 1ink).
const LEET_I = pairs('0o1i3e4a5s$s7t8b9g'), LEET_L = pairs('0o1l3e4a5s$s7t8b9g');
const INVISIBLE = /[­͏᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
const BIDI = /[‪-‮⁦-⁩]/u;
// Mathematical, fullwidth, circled and squared letters (𝐟𝐫𝐞𝐞, ｆｒｅｅ, ⓕⓡⓔⓔ, 🅵🆁🅴🅴).
const STYLED = /[\u{1D400}-\u{1D7FF}Ａ-Ｚａ-ｚⒶ-ⓩ\u{1F130}-\u{1F189}]/u;
const ENCLOSED = /[\u{1F130}-\u{1F149}\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}]/gu;
const mapChars = (text, table) => Array.from(text, c => table.get(c) ?? c).join('');

export function fold(text) {
  let s = String(text).normalize('NFKC').replace(INVISIBLE, '');
  // Squared and negative circled/squared letters have no compatibility mapping.
  s = s.replace(ENCLOSED, c => String.fromCharCode(97 + (c.codePointAt(0) - 0x1F130) % 32));
  s = s.normalize('NFD').replace(/\p{M}+/gu, '');
  const plain = mapChars(mapChars(s, CONFUSABLES).toLowerCase(), CONFUSABLES);
  const skeleton = mapChars(plain, LEET).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
  return { plain, skeleton };
}

// How much effort a message spends on looking different from what it says.
export function obfuscation(text) {
  const raw = String(text), reasons = [];
  let score = 0;
  const add = (points, reason) => { score += points; reasons.push(reason); };
  let mixed = 0, styledMix = 0, styled = 0, leet = 0, leetWords = 0, words = 0, glued = 0;
  for (const word of raw.normalize('NFC').split(/\s+/)) {
    if (/\p{Script=Latin}/u.test(word) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word)) mixed++;
    const fancy = [...word].filter(c => STYLED.test(c)).length;
    styled += fancy;
    if (fancy && /[a-z]/i.test(word)) styledMix++;
    // Digits between letters (G0t, h3llo) are a disguise; digits after a word (mp3, win10) mostly are not.
    let swapped = 0;
    for (const part of word.replace(/^@/, '').split(/[^\p{L}\p{N}$@€¥|]+/u)) {
      if ((part.match(/[a-z]/gi) || []).length < 2) continue;
      if (/[a-z][0134578$@€¥|]+[a-z]/i.test(part)) swapped += 1;
      else if ((part.match(/[0134578$@€¥|]/g) || []).length >= 2) swapped += 0.5;
    }
    leet += swapped;
    if (/\p{L}/u.test(word)) { words++; if (swapped) leetWords++; }
    // Emoji or unbalanced brackets glued between letters split words for filters: h0t🔥Content, G0t(h0t.
    const balanced = [['(', ')'], ['[', ']'], ['{', '}']].every(([open, close]) => word.split(open).length === word.split(close).length);
    glued += (word.match(/[\p{L}\p{N}](?:\p{Extended_Pictographic}|️|‍)+(?=[\p{L}\p{N}])/gu) || []).length;
    if (!balanced) glued += (word.match(/[\p{L}\p{N}][()[\]{}<>]+(?=[\p{L}\p{N}])/gu) || []).length;
  }
  if (mixed) add(Math.min(6, mixed * 3), 'mixed alphabets in a word');
  // Invisible characters inside a word (ZWJ between emoji and ZWNJ in Persian are left alone).
  const hidden = [...raw.matchAll(INVISIBLE)].filter(m => BIDI.test(m[0]) || (/[\p{Script=Latin}\d]/u.test(raw[m.index - 1] || '') && /[\p{Script=Latin}\d]/u.test(raw[m.index + 1] || '')));
  if (hidden.length) add(3, 'hidden characters');
  if (styledMix) add(3, 'styled letters mixed into words');
  else if (styled >= 3) add(1, 'styled letters');
  if (/\p{M}{3,}/u.test(raw.normalize('NFD'))) add(2, 'stacked accents');
  if (/(?<![\p{L}\p{N}])(?:\p{L}[\s._\-*·]+){3,}\p{L}(?![\p{L}\p{N}])/u.test(raw)) add(2, 'spaced-out letters');
  // One "l33t" is a style; a message in which many words are disguised is hiding something.
  const swaps = Math.floor(leet) + (leet >= 2 && leetWords / Math.max(1, words) >= 0.2 ? 1 : 0);
  if (swaps) add(Math.min(5, swaps), 'digits in place of letters');
  if (glued) add(Math.min(2, glued), 'symbols glued inside words');
  return { score, reasons };
}

const TLDS = 'com|net|org|io|gg|me|cc|ru|su|xyz|top|site|online|shop|store|info|biz|link|click|live|app|dev|vip|club|fun|pw|tk|ml|ga|cf|gq|ws|ly|tv|uk|onion';
// Only unambiguous endings are joined across spaces ("example . com"), never common words like "me".
const SPACED_TLDS = 'com|net|org|io|gg|ru|su|xyz|top|site|online|shop|store|info|biz|link|click|vip|club|pw|tk|ml|cf|gq|ws|ly|onion';
const DOMAIN = new RegExp(`(?<![a-z0-9-])[a-z0-9][a-z0-9-]*\\.(?:${TLDS})(?![a-z0-9])`);
const SPACED_DOMAIN = new RegExp(`([a-z0-9-]{2,})\\s*\\.\\s*(${SPACED_TLDS})(?![a-z0-9])`, 'g');
const STRONG = [
  ['link', /\b(?:https?|hxxps?)\s*:\s*\/\/|\bwww\s*\./],
  ['invite', /\b(?:discord(?:app)?\s*\.?\s*(?:gg|com\s*\/\s*invite)|t\s*\.?\s*me|wa\s*\.\s*me|chat\s*\.\s*whatsapp)\s*\/\s*[a-z0-9_+-]{3,}/],
  ['domain', DOMAIN]
];
const CONTACT = /(?:^|\s)@[a-z0-9_.]{3,}|\b(?:add|dm|text|message|msg|hmu|contact|write|hit)\s+me\b|\b(?:schreib|adde?|meld|kontaktier)\w*\s+(?:mir|mich|dich)\b/;
// Messaging apps where sellers move their buyers, Telegram and TeleGuard above all. Names are compared
// after folding, so T3l3gr@m, teIegram and "T e l e g r a m" all match; ✈ is Telegram's logo.
const APP_NAMES = ['telegram', 'telegrm', 'telgram', 'tlgrm', 'tgram', 'tele', 'tg', 'teleguard', 'telegard', 'tguard', 'whatsapp', 'snapchat', 'snap',
  'instagram', 'insta', 'kik', 'discord', 'signal', 'threema', 'wickr', 'session', 'wechat', 'skype', 'onlyfans', 'fansly'];
const APP_WORDS = new Set(APP_NAMES.map(name => fold(name).skeleton));
const isApp = token => token.includes('✈') || APP_WORDS.has(fold(token).skeleton);
// Glued forms: "TG_anna", "telegramAnna", "telegramanna99", "TgrD__RMQDc4FQF".
const APP_PREFIX = /^(telegram|teleguard|tgram|tele|tg|whatsapp|snapchat|snap|insta|kik|discord|wa|sc|ig|dc)([_:.\-@]*)(.+)$/i;
function gluedHandle(token) {
  const [, app, separator, rest] = token.match(APP_PREFIX) || [];
  if (!rest || rest.length < 4) return false;
  return Boolean(separator) || randomToken(rest) || app.length >= 8 || (/[a-z]/.test(app) && /^[A-Z]/.test(rest));
}
// Words between an app and the handle: "my telegram is anna_x", "TeleGuard ID: …".
const FILLER = new Set(['is', 'id', 'me', 'at', 'on', 'my', 'username', 'user', 'name', 'nick', 'via', 'ist', 'unter']);
// Handles and invite codes look random: letters mixed with digits or underscores, or case changing
// mid-word, and few vowels (words in any language have them).
export function randomToken(token) {
  if (!/^[A-Za-z0-9_]{8,40}$/.test(token)) return false;
  const letters = token.match(/[a-z]/gi) || [], vowels = token.match(/[aeiouy]/gi) || [];
  // Two capitals inside the word, so names like McDonalds or YouTube do not count.
  const mixed = ((token.slice(1).match(/[A-Z]/g) || []).length >= 2 && /[a-z]/.test(token)) || /[0-9_]/.test(token);
  return mixed && letters.length >= 4 && vowels.length / letters.length <= 0.25;
}
const PHONE = /(?:\+|\b)\d(?:[\s\-().]{0,3}\d){8,14}\b/;
const CRYPTO = /\b(?:bc1[ac-hj-np-z02-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33})\b/;

function linkForm(plain) {
  return plain
    .replace(/[([{<]\s*(?:\.|dot|d0t|punkt|point)\s*[)\]}>]/g, '.')
    .replace(/\s+(?:dot|d0t)\s+/g, '.')
    .replace(/。/g, '.')
    // Runs of four or more single characters are one word: "t . m e / x" → "t.me/x".
    .replace(/(?<!\S)(?:\S\s+){3,}\S(?!\S)/g, run => run.replace(/\s+/g, ''))
    .replace(SPACED_DOMAIN, '$1.$2');
}

// Somewhere to go: the thing spam is useless without.
export function destinations(text) {
  const { plain } = fold(text), found = new Set();
  for (const form of new Set([plain, mapChars(plain, LEET_I), mapChars(plain, LEET_L)].map(linkForm))) {
    for (const [kind, pattern] of STRONG) if (pattern.test(form)) found.add(kind);
  }
  if (PHONE.test(plain)) found.add('phone');
  if (CRYPTO.test(String(text).normalize('NFKC'))) found.add('wallet');
  // Messaging-app handles. Spaced-out letters are joined first ("T e l e g r a m:"), and colons,
  // arrows and pointing emoji become a ":" token, since they announce what follows.
  const tokens = String(text).normalize('NFKC').replace(INVISIBLE, '')
    .replace(/(?<!\S)(?:\S\s+){3,}\S[:=\-]?(?!\S)/g, run => run.replace(/\s+/g, ''))
    .replace(/\s*(?:[:=]|->|[→➡👉👇⬇✈]️?)\s*/gu, match => match.includes('✈') ? ' ✈ ' : ' : ')
    .split(/\s+/).map(token => token.replace(/^[^\w@✈:]+|[^\w✈:]+$/gu, '')).filter(Boolean);
  let code = false, app = false, named = false;
  tokens.forEach((token, i) => {
    if (gluedHandle(token.replace(/^@/, ''))) { found.add('handle'); return; }
    if (!isApp(token)) { if (token !== ':' && randomToken(token.replace(/^@/, ''))) code = true; return; }
    app = true;
    let j = i + 1, announced = false;
    while (j < tokens.length && j <= i + 4 && (tokens[j] === ':' || FILLER.has(tokens[j].toLowerCase()))) { announced ||= tokens[j] === ':'; j++; }
    const candidate = tokens[j] || '', core = candidate.replace(/^@/, '');
    // TeleGuard IDs are nine capitals and digits, sometimes split into groups: "5KJ 2HA QRT".
    const grouped = tokens.slice(j, j + 4).filter((part, k, parts) => /^[A-Z0-9]+$/.test(part) && parts.slice(0, k).every(p => /^[A-Z0-9]+$/.test(p))).join('');
    if (/^(?=.*\d)(?=.*[A-Z])[A-Z0-9]{9}$/.test(grouped) || (core.length >= 4 && /^[\w.]+$/.test(core) &&
        (candidate.startsWith('@') || announced || /[\d_]/.test(core) || randomToken(core)))) found.add('handle');
    else if (core.length >= 4 && j > i + 1 && /^\w+$/.test(core)) named = true;
  });
  // "Add me on TG" is a contact request; "my telegram is down" only might be one.
  const asks = app && CONTACT.test(plain), maybe = app && named;
  return { strong: [...found], weak: !found.size && (code || asks || maybe), ...(!found.size && asks ? { ask: true } : !found.size && code && !maybe ? { code: true } : {}) };
}

// A username shown next to every message must not advertise an app or account: "TG_annahot", "teleguard5KJ2".
const NAMED_APPS = ['telegram', 'telgram', 'telegrm', 'tlgrm', 'tgram', 'teleguard', 'telegard', 'tguard', 'whatsapp', 'snapchat', 'instagram', 'onlyfans', 'fansly'].map(name => fold(name).skeleton);
export function advertisesContact(name) {
  const token = String(name), skeleton = fold(token).skeleton;
  return gluedHandle(token) || isApp(token) || NAMED_APPS.some(app => skeleton.includes(app));
}

// Selling explicit content is what most spam here is for. These words alone prove nothing ("hot
// weather", "pics or it didn't happen"), so they only add weight once several appear together.
const SELLING = ['content', 'nudes', 'nude', 'pics', 'vids', 'videos', 'menu', 'prices', 'selling', 'premium', 'custom', 'sexting', 'sexy', 'horny',
  'naughty', 'spicy', 'hot', 'onlyfans', 'fansly', 'folders', 'leaks', 'nudz', 'sell'].map(word => fold(word).skeleton);
const SELLING_EMOJI = /[🔞🍑🍆💦👅😈💋🌶]/gu;
export function selling(text) {
  const words = String(text).normalize('NFKC').replace(INVISIBLE, '').split(/[^\p{L}\p{N}@$€¥|+]+/u).map(word => fold(word).skeleton).filter(Boolean);
  const hits = new Set([...words.flatMap(word => SELLING.filter(stem => word === stem || (stem.length >= 5 && word.startsWith(stem)))), ...(String(text).match(SELLING_EMOJI) || [])]);
  return hits.size;
}

// MinHash over 5-character shingles of the skeleton estimates how similar two messages are,
// however they were disguised. Seeds are per process, like the client key secret.
const HASHES = 32, SEEDS = new Uint32Array(randomBytes(HASHES * 4).buffer);
function mix(h) { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; }
export function signature(skeleton) {
  const sig = new Uint32Array(HASHES).fill(0xFFFFFFFF);
  for (let i = 0; i + 5 <= skeleton.length; i++) {
    let h = 0x811c9dc5;
    for (let j = i; j < i + 5; j++) h = Math.imul(h ^ skeleton.charCodeAt(j), 0x01000193);
    for (let k = 0; k < HASHES; k++) { const v = mix(h ^ SEEDS[k]); if (v < sig[k]) sig[k] = v; }
  }
  return sig;
}
export const similarity = (a, b) => { let same = 0; for (let k = 0; k < HASHES; k++) if (a[k] === b[k]) same++; return same / HASHES; };

const WINDOW = 600000, MIN_LENGTH = 16, DAY = 86400000;
export const REJECT_MESSAGE = 'New visitors can share links and contact details after a few minutes in the chat.';

export class AntiSpam {
  constructor({ now = Date.now, probation = 180000, log = () => {} } = {}) {
    this.now = now; this.probation = probation; this.log = log;
    this.recent = []; this.strikes = new Map();
  }
  networkOf(clientKey) { const key = String(clientKey || ''), dot = key.indexOf('.'); return dot === -1 ? key : key.slice(dot + 1); }
  strikeCount(clientKey) {
    const strike = this.strikes.get(this.networkOf(clientKey));
    return strike && strike.expires > this.now() ? strike.count : 0;
  }
  // Strikes lengthen probation and raise scores for the whole network for an hour.
  strike(clientKey) {
    const network = this.networkOf(clientKey);
    if (!network) return;
    this.strikes.set(network, { count: Math.min(5, this.strikeCount(clientKey) + 1), expires: this.now() + 3600000 });
  }
  // Probation starts when the chat stream first opens and lasts longer on networks with strikes.
  // Accounts older than a day (or created before account ages were recorded) are trusted.
  established(session, account) {
    if (session.vouched) return true;
    if (account && (!account.createdAt || this.now() - Date.parse(account.createdAt) >= DAY)) return true;
    const probation = Math.min(900000, this.probation * (1 + this.strikeCount(session.clientKey)));
    return session.connectedAt !== undefined && this.now() - session.connectedAt >= probation;
  }
  // A reply or mention from an established person on another network shows a fresh session is
  // talking with people, so its probation ends early.
  vouch(by, target, byEstablished) {
    if (target && target !== by && byEstablished && !by.shadowed && !target.shadowed && this.networkOf(by.clientKey) !== this.networkOf(target.clientKey)) target.vouched = true;
  }
  // Starting private conversations with many strangers is the encrypted-chat version of spam.
  newConversation(session, established) {
    const times = (session.conversationsStarted || []).filter(t => this.now() - t < WINDOW);
    if (times.length >= (established ? 20 : 3)) fail(429, established ? 'You started many new conversations recently. Try again in a few minutes.' : 'New visitors can start a few private conversations at first. Try again in a few minutes.');
    times.push(this.now()); session.conversationsStarted = times;
  }
  // Scores a main-room message: "allow", "reject" (with a message a person can act on) or "shadow"
  // (shown only to its sender, so automated senders do not learn they were caught).
  review(session, text, { id, established }) {
    const now = this.now(), network = this.networkOf(session.clientKey);
    this.recent = this.recent.filter(entry => now - entry.time < WINDOW && entry.id !== id);
    const own = (session.spamRecent || []).filter(entry => now - entry.time < 120000 && entry.id !== id).slice(-3);
    const { skeleton } = fold(text), { score: disguise, reasons } = obfuscation(text);
    let score = disguise;
    const dest = destinations(text);
    // A link split across messages ("t.me" … "/name") is joined with the sender's previous ones.
    const split = !dest.strong.length && own.length > 0 && ['', ' '].some(glue => destinations(own.map(e => e.text).join(glue) + glue + text).strong.length > 0);
    if (dest.strong.length) { score += 4; reasons.push(`contains ${dest.strong.join(', ')}`); }
    else if (dest.weak && disguise >= 3) { score += 4; reasons.push('disguised contact request'); }
    else if (dest.weak) { score += 2; reasons.push(dest.code ? 'contains a code or handle' : dest.ask ? 'asks to be contacted elsewhere' : 'possible messaging-app handle'); }
    if (split) { score += 6; reasons.push('link split across messages'); }
    // Disguising a message that carries a destination is the clearest sign of an automated sender.
    if ((dest.strong.length || split || dest.weak) && disguise >= 3) { score += 3; reasons.push('disguised link'); }
    // An offer of explicit content plus a way to reach the seller is enough to mute anyone.
    const offers = selling(text);
    if (offers >= 2) { score += offers >= 4 ? 3 : 2; reasons.push('selling explicit content'); }
    if (offers >= 2 && (dest.strong.length || dest.weak || split || CONTACT.test(fold(text).plain))) { score += 8; reasons.push('offer with contact details'); }
    const sig = skeleton.length >= MIN_LENGTH ? signature(skeleton) : null;
    let cluster = [];
    if (sig) {
      const weight = skeleton.length >= 40 ? 1 : 0.5, similar = this.recent.filter(entry => similarity(sig, entry.sig) >= 0.5);
      cluster = similar.filter(entry => entry.session !== session.id);
      const others = new Set(cluster.map(entry => entry.session)).size, repeats = similar.length - cluster.length;
      if (others) { score += Math.round(2 * Math.min(4, others) * weight); reasons.push(`near-identical to ${others} other ${others === 1 ? 'person' : 'people'}`); }
      if (repeats >= 2) { score += Math.round(Math.min(6, 3 * (repeats - 1)) * weight); reasons.push('repeated message'); }
      if ((dest.strong.length || split) && (others >= 2 || repeats >= 2)) { score += 6; reasons.push('repeated link'); }
    }
    const strikes = this.strikeCount(session.clientKey);
    if (strikes) { score += Math.min(4, strikes * 2); reasons.push('network recently flagged'); }
    const threshold = established ? 14 : 8;
    const action = session.shadowed || score >= threshold ? 'shadow' : !established && (dest.strong.length || split || dest.ask) ? 'reject' : 'allow';
    if (action === 'shadow' && !session.shadowed) {
      session.shadowed = true; this.strike(session.clientKey);
      // Other senders of the same link share the blame for an hour.
      if (dest.strong.length || split) for (const key of new Set(cluster.filter(entry => entry.dest).map(entry => entry.clientKey))) if (this.networkOf(key) !== network) this.strike(key);
      this.log({ alias: session.alias, score, reasons });
    }
    if (action !== 'reject') {
      if (sig) { this.recent.push({ id, sig, session: session.id, clientKey: session.clientKey, dest: Boolean(dest.strong.length || split), time: now }); if (this.recent.length > 3000) this.recent.shift(); }
      session.spamRecent = [...own, { id, text, time: now }];
    }
    return { action, score, reasons, ...(action === 'reject' ? { message: REJECT_MESSAGE } : {}) };
  }
  sweep() {
    const now = this.now();
    this.recent = this.recent.filter(entry => now - entry.time < WINDOW);
    for (const [key, value] of this.strikes) if (value.expires <= now) this.strikes.delete(key);
  }
}
