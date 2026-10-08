import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// A small DOM double exercises composer state and event handlers without dependencies.
async function composer() {
  class Node {
    constructor() { this.value = ''; this.children = []; this.style = {}; this.attributes = {}; this.hidden = true; this.selectionStart = this.selectionEnd = 0; this.maxLength = 2000; this.scrollHeight = 38; this.classList = { toggle() {}, contains: () => false }; }
    append(...nodes) { this.children.push(...nodes); }
    after() {}
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    focus() {}
    addEventListener() {}
    setRangeText(value, start, end) { this.value = this.value.slice(0, start) + value + this.value.slice(end); this.selectionStart = this.selectionEnd = start + value.length; }
  }
  const nodes = new Map(), calls = [];
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: () => [], createElement: () => new Node(), createTextNode: text => ({ textContent: text }), addEventListener() {} },
    fetch: (url, options) => { calls.push({ url, options }); return new Promise(() => {}); }, URLSearchParams,
    window: { addEventListener() {} }, matchMedia: () => ({ matches: false, addEventListener() {} })
  });
  vm.runInContext(await readFile(new URL('../public/groups.js', import.meta.url), 'utf8'), context);
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  run("me = { id: 'me', alias: 'Quiet Fox abcd', admin: false }; people = [me, { id: 'other', alias: 'Amber Owl 1234' }]; current = { room: 'living' };");
  const draft = text => { const input = node('#message'); input.value = text; input.selectionStart = input.selectionEnd = text.length; return input; };
  return { node, run, draft, calls };
}

test('mention autocomplete supports keyboard choice, replacement, and dismissal', async () => {
  const { node, run, draft } = await composer();
  const input = draft('Hi @Amb'); input.oninput();
  assert.equal(node('#suggestions').hidden, false);
  assert.equal(node('#suggestions').children[0].textContent, 'Amber Owl 1234');
  input.onkeydown({ key: 'Tab', preventDefault() {} });
  assert.equal(input.value, 'Hi @Amber Owl 1234 ');
  assert.equal(node('#suggestions').hidden, true);
  draft('@'); input.oninput(); input.onkeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(node('#suggestions').children[1].attributes['aria-selected'], 'true');
  input.onkeydown({ key: 'Escape' }); assert.equal(node('#suggestions').hidden, true);
  run("current = { peer: 'someone-else' }"); draft('@Amb'); input.oninput();
  assert.equal(node('#suggestions').hidden, true);
});

test('emoji search inserts at the saved selection and respects the message limit', async () => {
  const { node, draft } = await composer();
  const input = draft('Hello world'); input.selectionStart = 6; input.selectionEnd = 11;
  node('#emoji-toggle').onclick(); node('#emoji-search').value = 'wave'; node('#emoji-search').oninput();
  assert.equal(node('#emoji-grid').children.length, 1);
  node('#emoji-grid').children[0].onclick(); assert.equal(input.value, 'Hello 👋');
  assert.equal(node('#emoji-toggle').attributes['aria-expanded'], 'false');
  draft('x'.repeat(2000)); node('#emoji-toggle').onclick(); node('#emoji-grid').children[0].onclick();
  assert.equal(input.value.length, 2000); assert.match(node('#error').textContent, /2,000/);
});

test('commands stay out of chat and reject unauthorized moderation', async () => {
  const { node, run, draft, calls } = await composer();
  draft('/help'); await node('#composer').onsubmit({ preventDefault() {} });
  assert.match(node('#command-status').textContent, /\/ban/);
  assert.equal(node('#message').value, '');
  draft('/ban @Amber Owl 1234'); await node('#composer').onsubmit({ preventDefault() {} });
  assert.match(node('#error').textContent, /Unlock Room management/);
  assert.equal(node('#message').value, '/ban @Amber Owl 1234');
  draft('/unknown'); await node('#composer').onsubmit({ preventDefault() {} });
  assert.match(node('#error').textContent, /Unknown command/);
  assert.equal(calls.length, 1); // Only the initial session request; no message was posted.
  run("me.admin = true; api = async (route, data) => { globalThis.lastCall = {route, data}; if (route === 'admin/state') return {people, bans: []}; return {ok: true}; }; refreshAdminState = async () => {};");
  await run("runCommand('/ban @Amber Owl 1234')");
  assert.equal(run('lastCall.route'), 'admin/ban'); assert.equal(run('lastCall.data.id'), 'other');
  await assert.rejects(run("runCommand('/remove')"), /Select Reply/);
  await run("runCommand('/remove', {id: 'original'})");
  assert.equal(run('lastCall.route'), 'admin/remove-message');
});
