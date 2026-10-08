const $ = selector => document.querySelector(selector);
let me, rooms = [], people = [], adminBans = [], current, messages = [], stream, revision = 0, deleting, banning;
let editingMessage, editSaving = false, signingOut = false;
let replying, sending = false, suggestions = [], suggestionIndex = 0, completionStart = 0;
let encryptionClient, encryptionError = '', peerIdentity, pendingFile, filePreparing = false, fileRevision = 0, verificationTarget;
let attachmentLimit = 16 * 1024 * 1024;
let attachmentLifetime = 86400000;
const lifetimeText = ms => { const minutes = Math.max(1, Math.round(ms / 60000)), hours = minutes / 60; return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? '' : 's'}` : `${minutes} minute${minutes === 1 ? '' : 's'}`; };
const fileURLs = new Map(), fileLoads = new Map(), filePlayers = new Map();
const fileKinds = { image: 'Image', video: 'Video', audio: 'Audio', file: 'File' };
let blockedUsers = [], hiddenChats = new Set();
const isBlocked = id => blockedUsers.some(user => user.peers.includes(id));
const conversations = new Map(), unread = new Map(), drafts = new Map();
const conversationKey = target => target ? `${target.group ? 'group' : target.peer ? 'peer' : 'room'}:${target.group || target.peer || target.room}` : '';
async function api(url, data) {
  const response = await fetch(`/api/${url}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Could not connect. Try again.'), { status: response.status });
  return result;
}
function error(message = '') { $('#error').textContent = message; $('#error').hidden = !message; }
function element(tag, className, text) { const e = document.createElement(tag); e.className = className; if (text !== undefined) e.textContent = text; return e; }
function username(alias, className, displayAsAdmin) {
  const name = element('span', `${className}${displayAsAdmin ? ' admin-name' : ''}`, alias);
  if (displayAsAdmin) name.append(element('small', 'admin-badge', 'ADMIN'));
  return name;
}
// Optional profile details people chose to show, e.g. "27 · Woman".
const genderLabels = { woman: 'Woman', man: 'Man', nonbinary: 'Non-binary', other: 'Other' };
function profileText(person) { return [person?.age, genderLabels[person?.gender]].filter(Boolean).join(' · '); }
// One-word aliases like "Mistfinch" show their first two letters.
function initials(alias) { const words = alias.split(' ').filter(Boolean); return words.length > 1 ? words.slice(0,2).map(s => s[0]).join('') : alias.slice(0,2); }
function avatar(alias, own = false) { return element('span', `avatar${own ? ' me-avatar' : ''}`, initials(alias)); }
function renderRooms() {
  $('#room-count').textContent = rooms.filter(room => !room.adminOnly).length;
  const roomButton = room => {
    const button = element('button', `nav-room${current?.room === room.id ? ' active' : ''}`);
    const label = element('span', 'room-label'); label.append(element('span', 'name', room.name), element('small', 'room-preview', room.preview || room.description || 'No messages yet'));
    button.append(element('span', 'hash', '#'), label); appendUnread(button, `room:${room.id}`); button.append(element('span', 'count', room.count || 0));
    button.setAttribute('aria-current', current?.room === room.id ? 'true' : 'false');
    button.onclick = () => select({ room: room.id }); return button;
  };
  $('#announcements').replaceChildren(...rooms.filter(room => room.adminOnly).map(roomButton));
  $('#rooms').replaceChildren(...rooms.filter(room => !room.adminOnly).map(roomButton));
  if (!rooms.some(room => !room.adminOnly)) $('#rooms').append(element('p', 'aside-hint', 'No rooms yet. The host can create one.'));
  renderAdminRooms();
  renderGroups();
}
$('#block-private-user').onclick = () => { if (current?.peer) changeBlock({ id: current.peer }, true); };
async function changeBlock(person, blocked) {
  try {
    const prefs = await api('private/block', blocked ? { peer: person.id, blocked: true } : { key: person.key, blocked: false });
    applyPrivatePreferences(prefs);
  } catch (e) { error(e.message); $('#blocked-status').textContent = e.message; }
}
function applyPrivatePreferences(prefs) {
  blockedUsers = prefs.blocks || []; hiddenChats = new Set(prefs.hiddenChats || []);
  for (const id of conversations.keys()) if (hiddenChats.has(id) || isBlocked(id)) { conversations.delete(id); unread.delete(`peer:${id}`); drafts.delete(`peer:${id}`); }
  if (current?.peer && (hiddenChats.has(current.peer) || isBlocked(current.peer))) select(rooms[0] ? { room: rooms[0].id } : null);
  renderPeople(); renderDMs(); renderBlockedUsers();
}
function renderBlockedUsers() {
  $('#blocked-count').textContent = blockedUsers.length || '';
  $('#settings-tab-blocked').setAttribute('aria-label', blockedUsers.length ? `Blocked users, ${blockedUsers.length} blocked` : 'Blocked users');
  $('#blocked-users').replaceChildren(...blockedUsers.map(person => {
    const row = element('div', 'blocked-user'), button = element('button', 'text-button', 'Unblock');
    button.type = 'button'; button.setAttribute('aria-label', `Unblock ${person.alias}`);
    button.onclick = () => changeBlock(person, false);
    row.append(avatar(person.alias), element('span', 'blocked-name', person.alias), button); return row;
  }));
  if (!blockedUsers.length) $('#blocked-users').append(element('p', 'aside-hint blocked-empty', 'No blocked users.'));
}
async function removePrivateChat(id) {
  try {
    await api('private/hide', { peer: id }); hiddenChats.add(id);
    conversations.delete(id); unread.delete(`peer:${id}`); drafts.delete(`peer:${id}`); updateUnreadTitle();
    if (current?.peer === id) await select(rooms[0] ? { room: rooms[0].id } : null);
    renderDMs();
  } catch (e) { error(e.message); }
}
function renderPeople() {
  $('#online-count').textContent = people.length;
  $('#people').replaceChildren(...people.map(person => {
    const own = person.id === me.id, blocked = isBlocked(person.id);
    const row = element('div', 'person-row'), button = element('button', 'person'); button.disabled = own || blocked;
    const name = username(person.alias, 'person-name', person.displayAsAdmin);
    if (profileText(person)) name.append(element('small', 'person-profile', profileText(person)));
    button.append(avatar(person.alias, own), name, element(own || blocked ? 'small' : 'span', own || blocked ? '' : 'person-arrow', own ? 'you' : blocked ? 'blocked' : '↗'));
    button.title = own ? 'This is you' : blocked ? 'Unblock in settings to chat privately' : `Chat privately with ${person.alias}`;
    button.onclick = () => { hiddenChats.delete(person.id); conversations.set(person.id, person.alias); select({ peer: person.id }); api('private/show', { peer: person.id }).catch(e => error(e.message)); };
    row.append(button);
    if (!own && !blocked) {
      const block = element('button', 'person-block', 'Block'); block.type = 'button';
      block.setAttribute('aria-label', `Block ${person.alias}`); block.onclick = () => changeBlock(person, true); row.append(block);
    }
    return row;
  }));
}
function renderDMs() {
  $('#dm-hint').hidden = conversations.size > 0;
  $('#dms').replaceChildren(...[...conversations].map(([id, alias]) => {
    const row = element('div', 'dm-row');
    const button = element('button', `dm-room${current?.peer === id ? ' active' : ''}`);
    button.append(element('span', '', '↗'), username(alias, 'name', people.find(p => p.id === id)?.displayAsAdmin));
    appendUnread(button, `peer:${id}`);
    button.onclick = () => select({ peer: id });
    const remove = element('button', 'dm-remove', '×'); remove.type = 'button';
    remove.setAttribute('aria-label', `Remove private chat with ${alias}`);
    remove.title = 'Remove from sidebar. A new message will bring it back.';
    remove.onclick = () => removePrivateChat(id);
    row.append(button, remove); return row;
  }));
}
// The public-room notice stays dismissed on this browser once closed.
let publicNoteDismissed = false;
try { publicNoteDismissed = localStorage.getItem('silenza-public-note') === 'dismissed'; } catch {}
$('#dismiss-public-note').onclick = () => {
  publicNoteDismissed = true; $('#public-note').hidden = true; $('#message').focus();
  try { localStorage.setItem('silenza-public-note', 'dismissed'); } catch {}
};
function updateHeading() {
  const privateChat = Boolean(current?.peer), groupChat = Boolean(current?.group), room = groupChat ? groupState || groupRooms.find(g => g.id === current.group) : rooms.find(r => r.id === current?.room);
  $('.app').classList.toggle('group-chat', groupChat);
  $('.app').classList.toggle('announcements-readonly', Boolean(room?.adminOnly && !me.admin));
  $('#room-title').textContent = privateChat ? conversations.get(current.peer) || 'Private conversation' : room?.name || 'A little quiet for now';
  const peerProfile = privateChat ? profileText(people.find(p => p.id === current.peer)) : '';
  $('#room-description').textContent = privateChat ? `${peerProfile ? `${peerProfile} · ` : ''}A conversation just between the two of you.` : room?.description || (groupChat ? '' : 'Choose a room or someone to talk to.');
  $('#room-description').hidden = groupChat && !room?.description;
  $('#room-symbol').textContent = privateChat ? '↗' : '#';
  $('#conversation-type').textContent = room?.adminOnly ? 'OFFICIAL COMMUNITY UPDATES' : groupChat ? [`Temporary room · ${accessLabel(room)}`, room?.count && `${room.count} ${room.count === 1 ? 'member' : 'members'}`,
    room?.locked && 'Locked', room?.readOnly && 'Staff posts only', room?.slowMode && `Slow mode ${room.slowMode < 60 ? `${room.slowMode}s` : `${room.slowMode / 60} min`}`,
    room?.disappear && `Messages disappear after ${room.disappear < 60 ? `${room.disappear} min` : `${room.disappear / 60} h`}`, room?.shareHistory && 'History shared with new members'].filter(Boolean).join(' · ') : privateChat ? 'JUST BETWEEN YOU TWO' : 'COME AS YOU ARE';
  $('#announcement-note').hidden = !room?.adminOnly;
  $('#announcement-note').textContent = me.admin ? 'Only admins can post here. Announcements are saved until an admin removes them.' : 'Read-only: admins post updates here. Announcements are saved between restarts.';
  $('#room-badge').textContent = room?.adminOnly ? 'ANNOUNCEMENTS' : groupChat ? 'ENCRYPTED ROOM' : privateChat ? 'PRIVATE CHAT' : 'OPEN ROOM';
  $('#private-note').hidden = !privateChat && !groupChat;
  $('#public-note').hidden = publicNoteDismissed || privateChat || groupChat || !room || room.adminOnly;
  $('#block-private-user').hidden = !privateChat;
  $('#group-details').hidden = !groupChat;
  $('#group-details').disabled = !groupState;
  $('#room-rules').hidden = !groupChat || !room?.rules;
  $('#room-rules p').textContent = groupChat && room?.rules ? room.rules : '';
  $('#message').placeholder = room?.adminOnly ? (me.admin ? 'Write an announcement…' : 'Only admins can post announcements') : groupChat ? 'Message this room…' : privateChat ? 'Say something, just to them…' : 'Leave a little thought…';
  updateComposerState();
  $('#welcome h2').textContent = room?.adminOnly ? 'News from the admins.' : privateChat ? 'A little more personal.' : 'Make yourself at home.';
  $('#welcome p').textContent = room?.adminOnly ? 'Updates, changes, and important information for the community.' : privateChat ? 'One conversation. Just the two of you.\nA simple hello is a good place to start.' : 'Join a public room without an account or email. Choose someone online for an encrypted private chat.';
}
function matches(message, target = current) { return target && (target.group ? message.group === target.group : message.group ? false : target.peer ? !message.room && ((message.sender === me.id && message.recipient === target.peer) || (message.sender === target.peer && message.recipient === me.id)) : message.room === target.room); }
function validMessageRoute(message) {
  if (!message || typeof message.id !== 'string' || typeof message.sender !== 'string') return false;
  if (message.group) return typeof message.group === 'string' && !message.room && !message.recipient;
  if (message.room) return typeof message.room === 'string' && !message.recipient && !message.encrypted;
  return typeof message.recipient === 'string' && (message.sender === me.id || message.recipient === me.id);
}
async function select(target) {
  $('#edit-message-dialog').close(); editingMessage = null;
  setReply(null); closeSuggestions(); toggleEmoji(false);
  if (conversationKey(target) !== conversationKey(current)) {
    if (current) drafts.set(conversationKey(current), $('#message').value);
    $('#message').value = drafts.get(conversationKey(target)) || ''; resizeComposer();
    clearPendingFile(); status('');
  }
  clearFileURLs(); peerIdentity = null; groupState = null;
  current = target; const version = ++revision; messages = []; error();
  $('#room-rules').open = false;
  unread.delete(conversationKey(target)); updateUnreadTitle();
  renderRooms(); renderDMs(); updateHeading(); renderMessages();
  if (!target) return;
  try {
    if (target.group) {
      if (!encryptionClient) throw new Error(encryptionError || 'Room encryption is unavailable.');
      const state = await api(`groups/state?group=${encodeURIComponent(target.group)}`);
      if (version !== revision) return;
      groupState = state; updateHeading();
      if (state.pendingHistory) shareGroupHistory(state.id);
    }
    if (target.peer) {
      if (!encryptionClient) throw new Error(encryptionError || 'Private encryption is unavailable.');
      const person = await encryptionClient.peer(target.peer);
      if (version !== revision) return;
      peerIdentity = person; updateComposerState();
    }
    if (target.room) await api('join', target);
    await syncHistory(target, version);
  } catch (e) { if (version === revision) { error(e.message); if (target.peer || target.group) { peerIdentity = null; groupState = null; updateComposerState(e.message); } } }
}
const byTime = list => list.sort((a, b) => a.time.localeCompare(b.time)).slice(rooms.find(r => r.id === current?.room)?.persistent ? 0 : -100);
// Loads the server's history and merges it with what is shown. Messages already decrypted are kept
// as they are (no second decryption or redraw), messages missed while offline are added, and messages
// removed meanwhile disappear. Messages that arrived live during the request are kept.
async function syncHistory(target, version) {
  const before = new Set(messages.map(m => m.id));
  const known = new Map(messages.filter(m => !m.locked).map(m => [m.id, m]));
  const unchanged = (local, remote) => local && (local.editVersion || 0) === (remote.editVersion || 0) && Boolean(local.shared) === Boolean(remote.shared) &&
    Boolean(local.reply?.removed) === Boolean(remote.reply?.removed) && (local.attachment?.id || null) === (remote.attachment?.id || null);
  const list = (await api(`${target.group ? 'groups/history' : 'history'}?${new URLSearchParams(target)}`)).filter(message => validMessageRoute(message) && matches(message, target));
  const history = await Promise.all(list.map(m => {
    const local = known.get(m.id);
    // Public messages are plaintext, so the server copy is always current. Read times are server metadata.
    return target.room ? m : unchanged(local, m) ? (!m.readAt || local.readAt === m.readAt ? local : { ...local, readAt: m.readAt }) : decodePrivate(m).then(decoded => ({ ...decoded, readAt: decoded.readAt || local?.readAt }));
  }));
  if (version !== revision) return;
  const ids = new Set(history.map(m => m.id));
  messages = byTime([...history, ...messages.filter(m => !ids.has(m.id) && !before.has(m.id))]);
  renderMessages();
}
// After a reconnect, catch up on what happened while the connection was down without clearing the chat.
async function resync() {
  const target = current, version = revision;
  if (!target) return;
  try {
    if (target.group) {
      const state = await api(`groups/state?group=${encodeURIComponent(target.group)}`);
      if (version !== revision) return;
      groupState = state; updateHeading();
    }
    if (target.peer && !peerIdentity) { await select(target); return; }
    await syncHistory(target, version);
  } catch (e) { if (version === revision && e.status !== 403) error(e.message); }
}
// Adds room messages that another member shared with this member after they joined.
async function loadSharedHistory(group) {
  const version = revision;
  try {
    const known = new Set(messages.filter(m => !m.locked).map(m => `${m.id}:${m.editVersion || 0}`));
    const fresh = (await api(`groups/history?${new URLSearchParams({ group })}`)).filter(m => validMessageRoute(m) && matches(m) && !known.has(`${m.id}:${m.editVersion || 0}`));
    const decoded = await Promise.all(fresh.map(decodePrivate));
    if (version !== revision || !decoded.length) return;
    messages = [...new Map([...messages, ...decoded].map(m => [m.id, m])).values()].sort((a,b) => a.time.localeCompare(b.time)).slice(-100);
    renderMessages();
  } catch(e) { error(e.message); }
}
// Rendered rows are reused while nothing they show has changed, so a new message in a busy room adds
// one row instead of rebuilding the whole conversation (and re-requesting its invite cards).
const renderedRows = new Map();
let stickToBottom = false;
function renderMessages() {
  const scroll = $('#chat-scroll'), list = $('#messages'), atBottom = stickToBottom || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  stickToBottom = false;
  const rows = messages.map(message => {
    const persistent = Boolean(rooms.find(r => r.id === message.room)?.persistent), adminOnly = Boolean(rooms.find(r => r.id === message.room)?.adminOnly);
    const original = message.reply && message.encrypted ? messages.find(m => m.id === message.reply.id && !m.locked) : null;
    const key = [me.id, me.admin, persistent, adminOnly, message.group ? Boolean(groupState && canManage(groupState, message.sender)) : ''].join('|');
    const cached = renderedRows.get(message.id);
    if (cached?.message === message && cached.key === key && cached.original === original) return cached.row;
    const row = renderMessage(message);
    // Only a message appearing for the first time in a conversation that is already shown animates in;
    // redrawn rows (decrypted, edited) and freshly loaded history appear without replaying the animation.
    if (cached || !list.children.length) row.classList.add('settled');
    renderedRows.set(message.id, { message, key, original, row });
    return row;
  });
  const shown = new Set(messages.map(m => m.id));
  for (const id of renderedRows.keys()) if (!shown.has(id)) renderedRows.delete(id);
  // Patch the list in place: rows that stay keep their DOM node (no relayout, no replayed animation,
  // media keeps playing), and only new, changed or removed rows are inserted or detached.
  const wanted = new Set(rows);
  for (const child of [...list.children]) if (!wanted.has(child)) child.remove();
  let next = list.firstElementChild;
  for (const row of rows) {
    if (row === next) next = next.nextElementSibling;
    else list.insertBefore(row, next);
  }
  $('#empty-chat').hidden = messages.length > 0 || !current;
  $('#empty-chat').textContent = current?.group ? 'No messages yet. Start the conversation below.' : 'It’s quiet in here. Be the first to say hello.';
  $('#welcome').hidden = Boolean(current?.group) || messages.length > 3;
  $('.day-divider').hidden = Boolean(current?.group) && messages.length === 0;
  // Keep reading position when someone is scrolled up; follow new messages otherwise.
  if (atBottom) scroll.scrollTop = scroll.scrollHeight;
  scheduleReadReceipt();
}
// Tells the other person which of their private messages were seen, while this chat is open and the
// tab is visible. Turning read receipts off in settings stops sending them.
let readTimer = 0; const readRequested = new Set();
function scheduleReadReceipt() { clearTimeout(readTimer); readTimer = setTimeout(sendReadReceipt, 400); }
function sendReadReceipt() {
  if (!current?.peer || !privacySettings.readReceipts || document.visibilityState !== 'visible') return;
  const last = messages.findLast(m => m.sender === current.peer && !m.locked && !m.readAt);
  if (!last || readRequested.has(last.id)) return;
  readRequested.add(last.id);
  api('private/read', { peer: current.peer, id: last.id }).catch(() => readRequested.delete(last.id));
}
function applyRead({ sender, recipient, ids, readAt }) {
  if (!current?.peer || ![sender, recipient].includes(current.peer) || ![sender, recipient].includes(me.id)) return;
  const read = new Set(ids);
  messages = messages.map(m => read.has(m.id) && !m.readAt ? { ...m, readAt } : m); renderMessages();
}
function renderMessage(message) {
  const own = message.sender === me.id;
  const row = element('article', 'chat-message'), content = element('div', 'message-content'), meta = element('div', 'message-meta');
  const displayAsAdmin = message.displayAsAdmin;
  meta.append(username(message.alias, 'message-name', displayAsAdmin));
  if (own) meta.append(element('span', 'you-tag', 'YOU'));
  meta.append(element('time', 'message-time', rooms.find(r => r.id === message.room)?.persistent ? new Date(message.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  row.id = `message-${message.id}`;
  if (message.removedBy === 'admin') {
    row.classList.add('removed-message');
    if (me?.admin) {
      const clear = element('button', 'message-remove', 'Remove'); clear.type = 'button'; clear.title = 'Remove this notice for everyone';
      clear.onclick = async () => { clear.disabled = true; try { applyRemoval(await api('admin/remove-message', { id: message.id })); } catch(e) { error(e.message); clear.disabled = false; } };
      meta.append(clear);
    }
    content.append(meta, element('p', 'message-text removed-notice', own ? 'Your message was removed by an admin.' : 'This message was removed by an admin.'));
    row.append(avatar(message.alias, own), content); return row;
  }
  if (message.mentions?.some(person => person.id === me.id)) row.classList.add('mentioned');
  // Read receipts sit next to the time on your own private messages: ✓ sent, ✓✓ seen.
  if (own && message.recipient && !message.room && !message.group && !message.locked) {
    const seen = Boolean(message.readAt), receipt = element('span', `read-receipt${seen ? ' seen' : ''}`, seen ? '✓✓' : '✓');
    receipt.title = seen ? `Seen ${new Date(message.readAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Sent · not seen yet';
    receipt.setAttribute('role', 'img'); receipt.setAttribute('aria-label', seen ? 'Seen' : 'Sent, not seen yet');
    meta.append(receipt);
  }
  const replyButton = element('button', 'message-reply', 'Reply');
  replyButton.type = 'button'; replyButton.disabled = Boolean(message.locked) || (rooms.find(r => r.id === message.room)?.adminOnly && !me.admin); replyButton.onclick = () => { setReply(message); $('#message').focus(); };
  meta.append(replyButton);
  if (message.editedAt) meta.append(element('span', 'message-time', '(edited)'));
  if (message.shared && !message.locked) {
    const shared = element('span', 'message-time', '(earlier message)');
    shared.title = 'Sent before you joined. Another member shared it with you, and the author’s signature was verified.';
    meta.append(shared);
  }
  // Encrypted messages carry the sender's own clock. Flag a large gap from the relay's timestamp.
  if (Number.isFinite(message.sentAt) && Math.abs(Date.parse(message.time) - message.sentAt) > 5 * 60000) {
    const skew = element('span', 'message-time', `(sender time ${new Date(message.sentAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })})`);
    skew.title = 'The encrypted sender time differs from the server time by more than 5 minutes. A wrong device clock or a delayed relay can cause this.';
    meta.append(skew);
  }
  if ((own || (me.admin && rooms.find(r => r.id === message.room)?.adminOnly)) && !message.locked) {
    const edit = element('button', 'message-reply', 'Edit'); edit.type = 'button';
    edit.onclick = () => {
      if (editSaving) return;
      editingMessage = { ...message };
      $('#edit-message-text').value = message.text;
      $('#edit-message-text').required = !message.file;
      $('#edit-message-error').textContent = '';
      $('#edit-message-dialog').showModal(); $('#edit-message-text').focus();
    };
    meta.append(edit);
  }
  if (own || (message.group ? groupState && canManage(groupState, message.sender) : me?.admin)) {
    const remove = element('button', 'message-remove', own ? 'Delete' : 'Remove');
    remove.type = 'button'; remove.title = 'Remove this message for everyone';
    remove.onclick = async () => { remove.disabled = true; try { applyRemoval(await api(message.group ? 'groups/message-delete' : own ? 'message/delete' : 'admin/remove-message', { id: message.id, ...(message.group ? { group: message.group } : {}) })); } catch(e) { error(e.message); remove.disabled = false; } };
    meta.append(remove);
  }
  content.append(meta);
  if (message.reply && !message.locked) {
    const original = message.encrypted ? messages.find(m => m.id === message.reply.id && !m.locked) : message.reply;
    const quote = element('button', 'reply-quote', message.reply.removed ? 'Original message removed' : original ? `${original.alias}: ${original.text || fileKinds[original.file?.kind] || 'Attachment'}` : 'Original message unavailable');
    quote.type = 'button'; quote.disabled = message.reply.removed;
    quote.onclick = () => { const original = document.getElementById(`message-${message.reply.id}`); if (original) { original.scrollIntoView({ block: 'center' }); original.tabIndex = -1; original.focus({ preventScroll: true }); } else error('The original message is no longer in the recent history.'); };
    content.append(quote);
  }
  const body = element('p', 'message-text'); let offset = 0;
  for (const mention of message.mentions || []) {
    body.append(document.createTextNode(message.text.slice(offset, mention.start)), element('mark', 'mention', message.text.slice(mention.start, mention.end)));
    offset = mention.end;
  }
  body.append(document.createTextNode(message.text.slice(offset))); content.append(body);
  if (!message.locked && message.text) renderInviteCards(message, content);
  if (message.file && !message.locked) renderAttachment(message, content);
  row.append(avatar(message.alias, own), content); return row;
}
function applyRemoval(removed) {
  if (!matches(removed)) return;
  const { id } = removed;
  // An admin removal leaves a notice in place of the message; other removals take it away.
  const notice = removed.notice?.id === id && removed.notice.removedBy === 'admin' && matches(removed.notice) ? removed.notice : null;
  if (editingMessage?.id === id) { $('#edit-message-dialog').close(); editingMessage = null; }
  revokeFile(id); messages = messages.flatMap(message => message.id === id ? (notice ? [notice] : []) : [message.reply?.id === id ? { ...message, reply: { id, removed: true } } : message]);
  if (replying?.id === id) setReply(null);
  renderMessages();
}
async function receive(message) {
  if (!validMessageRoute(message)) return;
  if (!message.room && !message.group) {
    const peer = message.sender === me.id ? message.recipient : message.sender;
    if (isBlocked(peer)) return;
    hiddenChats.delete(peer);
  }
  notifyMessage(message);
  if (!message.room && !message.group) {
    const peer = message.sender === me.id ? message.recipient : message.sender;
    if (!conversations.has(peer)) conversations.set(peer, people.find(p => p.id === peer)?.alias || message.alias);
    renderDMs();
  }
  countUnread(message);
  if (matches(message) && !messages.some(m => m.id === message.id)) {
    const version = revision;
    const needsAuthentication = !message.room;
    // Messages are ordered by server time, so every member sees the same order even when events arrive out of order.
    if (message.sender === me.id) stickToBottom = true;
    messages = byTime([...messages, needsAuthentication ? { ...message, text: 'Decrypting…', file: null, mentions: [], locked: true } : message]); renderMessages();
    if (needsAuthentication) {
      const decoded = await decodePrivate(message);
      if (version !== revision) return;
      messages = messages.map(m => m.id === message.id && (m.editVersion || 0) === (message.editVersion || 0) ? { ...decoded, reply: m.reply, readAt: decoded.readAt || m.readAt } : m); renderMessages();
    }
    for (const id of new Set([...fileURLs.keys(), ...fileLoads.keys(), ...filePlayers.keys()])) if (!messages.some(m => m.id === id)) revokeFile(id);
  }
}
async function applyEdit(message) {
  if (!validMessageRoute(message)) return;
  if (!matches(message)) return;
  const existing = messages.find(m => m.id === message.id);
  if (!existing || (existing.editVersion || 0) >= message.editVersion) return;
  const version = revision;
  // Reserve the version before decrypting so a slower event cannot overwrite a newer edit.
  messages = messages.map(m => m.id === message.id ? { ...message, text: 'Decrypting…', file: null, mentions: [], locked: true, reply: m.reply } : m);
  const decoded = await decodePrivate(message);
  if (version !== revision) return;
  messages = messages.map(m => m.id === message.id && m.editVersion === message.editVersion ? { ...decoded, reply: m.reply, readAt: decoded.readAt || m.readAt } : m);
  const latest = messages.find(m => m.id === message.id);
  if (!latest || latest.editVersion !== message.editVersion) return;
  if (message.room) messages = messages.map(reply => reply.reply?.id === message.id ? { ...reply, reply: { ...reply.reply, text: message.text.slice(0, 200) } } : reply);
  if (replying?.id === message.id) setReply(latest);
  renderMessages();
}
$('#cancel-edit-message').onclick = () => $('#edit-message-dialog').close();
$('#edit-message-form').onsubmit = async event => {
  event.preventDefault(); if (!editingMessage || editSaving) return;
  const message = editingMessage, text = $('#edit-message-text').value.trim();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  editSaving = true; button.disabled = true; $('#edit-message-error').textContent = '';
  try {
    if ((!text && !message.file) || text.length > 2000) throw new Error('Use between 1 and 2,000 characters, or keep an attachment.');
    const editVersion = (message.editVersion || 0) + 1;
    let result;
    if (message.group) {
      const state = await api(`groups/message-edit-state?${new URLSearchParams({ group: message.group, id: message.id })}`);
      const envelopes = await encryptionClient.encryptGroup({ id: message.id, group: message.group, version: message.version, sender: me.id, text,
        replyTo: message.reply?.id || null, file: message.file || null, editVersion, sentAt: message.sentAt ?? null, shareable: Boolean(message.shareable) }, state.members);
      result = await api('groups/message-edit', { group: message.group, id: message.id, membershipVersion: state.membershipVersion, editVersion, envelopes });
    } else if (message.encrypted) {
      const person = await encryptionClient.peer(message.recipient);
      const encrypted = encryptionClient.encrypt({ id: message.id, sender: me.id, recipient: message.recipient, text,
        replyTo: message.reply?.id || null, file: message.file || null, editVersion, sentAt: message.sentAt ?? null }, person);
      result = await api('message/edit', { id: message.id, editVersion, encrypted });
    } else result = await api('message/edit', { id: message.id, editVersion, text });
    await applyEdit(result);
    if (editingMessage === message) { $('#edit-message-dialog').close(); editingMessage = null; }
  } catch(e) { if (editingMessage === message) $('#edit-message-error').textContent = e.message; }
  finally { editSaving = false; button.disabled = false; }
};
function updateComposerState(problem) {
  const privateChat = Boolean(current?.peer), ready = Boolean(encryptionClient && peerIdentity?.id === current?.peer);
  const groupChat = Boolean(current?.group), groupReady = Boolean(encryptionClient && groupState?.id === current?.group && groupState?.joined);
  const groupBlock = groupChat && groupReady ? groupPostBlock(groupState) : '';
  if (groupChat) scheduleMuteCheck(groupState);
  $('#message').disabled = !current || (rooms.find(r => r.id === current?.room)?.adminOnly && !me.admin) || (privateChat && !ready) || (groupChat && (!groupReady || Boolean(groupBlock)));
  $('#message').required = !pendingFile;
  $('.send-button').disabled = $('#message').disabled || sending || filePreparing;
  $('#emoji-toggle').disabled = $('#message').disabled;
  $('#attach-file').hidden = !privateChat && !groupChat; $('#attach-file').disabled = !(groupChat ? groupReady : ready) || sending || filePreparing;
  $('#verify-identity').disabled = !ready;
  $('#verify-identity').hidden = groupChat;
  if (groupChat) $('#encryption-status').textContent = problem || groupBlock || (groupReady ? `End-to-end encrypted${groupState.shareHistory ? ' · New members can see previous messages' : ''} · Verify members in Room details` : encryptionError || 'Preparing room encryption…');
  if (privateChat) $('#encryption-status').textContent = problem || (ready ? `End-to-end encrypted · ${peerIdentity.verified ? 'Identity verified' : 'Identity not verified'}` : encryptionError || 'Waiting for private encryption…');
}
async function decodePrivate(message) {
  if (!validMessageRoute(message)) return { ...message, text: 'Invalid conversation metadata.', file: null, mentions: [], locked: true };
  if (message.group) {
    try {
      if (!encryptionClient) throw new Error(encryptionError || 'Room encryption is unavailable.');
      const plain = await encryptionClient.decryptGroup(message), mentions = [];
      for (const user of groupState?.members || []) {
        const tag = `@${user.alias}`; let start = plain.text.indexOf(tag);
        while (start !== -1) {
          const end = start + tag.length;
          if ((!start || /\s/.test(plain.text[start - 1])) && (end === plain.text.length || /[\s.,!?;:()]/.test(plain.text[end]))) mentions.push({ id: user.id, start, end });
          start = plain.text.indexOf(tag, end);
        }
      }
      return { ...message, ...plain, mentions: mentions.sort((a, b) => a.start - b.start) };
    } catch(e) { return { ...message, text: e.message, file: null, mentions: [], locked: true }; }
  }
  if (message.room) return message;
  try {
    if (!encryptionClient) throw new Error(encryptionError || 'Private encryption is unavailable.');
    const id = message.sender === me.id ? message.recipient : message.sender;
    const person = peerIdentity?.id === id ? peerIdentity : await encryptionClient.peer(id);
    const plain = encryptionClient.decrypt(message, person);
    const mentions = [];
    for (const user of [me, { id, alias: conversations.get(id) || people.find(p => p.id === id)?.alias }]) {
      if (!user.alias) continue;
      const tag = `@${user.alias}`; let start = plain.text.indexOf(tag);
      while (start !== -1) {
        const end = start + tag.length;
        if ((!start || /\s/.test(plain.text[start - 1])) && (end === plain.text.length || /[\s.,!?;:()]/.test(plain.text[end]))) mentions.push({ id: user.id, start, end });
        start = plain.text.indexOf(tag, end);
      }
    }
    return { ...message, ...plain, mentions: mentions.sort((a, b) => a.start - b.start) };
  } catch(e) { return { ...message, text: e.message, file: null, mentions: [], locked: true }; }
}
const formatBytes = bytes => bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
// QuickTime files are ISO media; browsers that play them expect the MP4 type.
const mediaType = type => type === 'video/quicktime' ? 'video/mp4' : type;
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/wav': 'wav' };
function revokeFile(id) {
  if (fileURLs.has(id) && $('#image-viewer img').getAttribute('src') === fileURLs.get(id)) $('#image-viewer').close();
  if (fileURLs.has(id)) URL.revokeObjectURL(fileURLs.get(id)); fileURLs.delete(id);
  fileLoads.get(id)?.controller.abort(); fileLoads.delete(id);
  const player = filePlayers.get(id)?.querySelector('video, audio');
  if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
  filePlayers.delete(id); downloadProgress.delete(id);
}
function clearFileURLs() { for (const id of new Set([...fileURLs.keys(), ...fileLoads.keys(), ...filePlayers.keys()])) revokeFile(id); }
function clearPendingFile() {
  fileRevision++; filePreparing = false;
  if (pendingFile?.url) URL.revokeObjectURL(pendingFile.url);
  discardUpload(pendingFile?.upload);
  pendingFile = null; $('#attachment-preview').hidden = true; $('#attachment-progress').hidden = true; $('#attachment-preview .attachment-thumb').replaceWith(element('span', 'attachment-thumb'));
  $('#file-input').value = ''; $('#message').required = true;
}
$('#attach-file').onclick = () => $('#file-input').click();
$('#cancel-attachment').onclick = () => { clearPendingFile(); updateComposerState(); };
$('#file-input').onchange = () => attachFile($('#file-input').files[0]);
// Files can also be dragged onto the conversation whenever the attach button is available.
const canAttach = () => !$('#attach-file').hidden && !$('#attach-file').disabled;
const draggingFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
function showDropZone(visible) { $('#drop-zone').hidden = !visible; if (!visible) dragDepth = 0; }
$('.app > main').addEventListener('dragenter', event => {
  if (!draggingFiles(event)) return;
  event.preventDefault(); dragDepth++; showDropZone(true);
  $('#drop-zone').classList.toggle('unavailable', !canAttach());
  $('#drop-zone p').textContent = canAttach() ? 'Drop to attach an encrypted file' : 'Attachments work only in private chats and temporary rooms';
});
$('.app > main').addEventListener('dragover', event => { if (!draggingFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = canAttach() ? 'copy' : 'none'; });
$('.app > main').addEventListener('dragleave', event => { if (draggingFiles(event) && --dragDepth <= 0) showDropZone(false); });
$('.app > main').addEventListener('drop', event => {
  if (!draggingFiles(event)) return;
  event.preventDefault(); showDropZone(false);
  const files = [...event.dataTransfer.files];
  if (!files.length || !canAttach()) return;
  attachFile(files[0]);
  if (files.length > 1) status('Only the first file was attached. Send it, then add the next one.');
});
// A file dropped outside the chat must not make the browser leave the page to open it.
for (const type of ['dragover', 'drop']) window.addEventListener(type, event => { if (draggingFiles(event)) event.preventDefault(); if (type === 'drop') showDropZone(false); });
window.addEventListener('dragend', () => showDropZone(false));
async function attachFile(file) {
  if (!file || (!current?.peer && !current?.group)) return;
  clearPendingFile(); const version = fileRevision;
  filePreparing = true; updateComposerState(); error(); status('Preparing attachment locally…');
  try {
    const prepared = await SilenzaAttachments.prepare(file, size => SilenzaCrypto.paddedSize(size) + 16 <= attachmentLimit);
    if (version !== fileRevision) return;
    pendingFile = { ...prepared, url: URL.createObjectURL(prepared.blob) };
    let thumb;
    if (pendingFile.kind === 'image') { thumb = element('img', 'attachment-thumb'); thumb.alt = 'Image ready to send'; thumb.src = pendingFile.url; }
    else if (pendingFile.kind === 'video') { thumb = element('video', 'attachment-thumb'); thumb.muted = true; thumb.preload = 'metadata'; thumb.setAttribute('aria-label', 'Video ready to send'); thumb.src = pendingFile.url; }
    else thumb = element('span', 'attachment-thumb attachment-icon', pendingFile.kind === 'audio' ? '♪' : '▤');
    $('#attachment-preview .attachment-thumb').replaceWith(thumb);
    $('#attachment-preview .attachment-detail').textContent = pendingFile.kind === 'file'
      ? `${pendingFile.name} · ${formatBytes(pendingFile.size)} · Encrypted before upload. Sent as-is: details stored inside the file are not removed.`
      : `${fileKinds[pendingFile.kind]} · ${formatBytes(pendingFile.size)} · Metadata removed and encrypted before upload · expires within ${lifetimeText(attachmentLifetime)}`;
    $('#attachment-preview').hidden = false;
    preuploadPendingFile(pendingFile);
  } catch(e) { if (version === fileRevision) error(e.tooLarge ? `${e.message} Attachments can be up to ${formatBytes(attachmentLimit - 16)}.` : e.message); }
  finally { if (version === fileRevision) { filePreparing = false; status(''); updateComposerState(); } }
}
// Download progress per message id, so a redrawn message row picks up a download already under way.
// Small attachments finish too quickly for a bar to help, so it only appears from 1 MB.
const downloadProgress = new Map(), PROGRESS_FROM = 1048576;
function renderDownloadProgress(id, box = document.querySelector(`#message-${CSS.escape(id)} .attachment-progress`)) {
  if (!box) return;
  const state = downloadProgress.get(id), bar = box.querySelector('progress'), label = box.querySelector('span');
  box.hidden = !state || state.total < PROGRESS_FROM;
  if (box.hidden) return;
  if (state.decrypting) { bar.value = 1; label.textContent = 'Decrypting…'; return; }
  bar.value = state.loaded / state.total;
  label.textContent = `Downloading encrypted file · ${Math.floor(bar.value * 100)}% · ${formatBytes(state.loaded)} of ${formatBytes(state.total)}`;
}
function downloadProgressBox(id) {
  const box = element('div', 'attachment-progress'); box.setAttribute('role', 'status');
  const bar = element('progress', ''); bar.max = 1; bar.value = 0; bar.setAttribute('aria-label', 'Attachment download progress');
  box.append(bar, element('span', '')); renderDownloadProgress(id, box); return box;
}
// The ciphertext length is known from the encrypted message, so the stream is read into a buffer of
// exactly that size; anything longer is rejected before decryption.
async function readCiphertext(response, message) {
  const id = message.id, total = SilenzaCrypto.paddedSize(message.file.size) + 16;
  if (!response.body?.getReader) return new Uint8Array(await response.arrayBuffer());
  const bytes = new Uint8Array(total), reader = response.body.getReader();
  let loaded = 0, painted = 0;
  downloadProgress.set(id, { loaded, total }); renderDownloadProgress(id);
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (loaded + value.length > total) { reader.cancel().catch(() => {}); throw new Error('Invalid encrypted attachment size.'); }
      bytes.set(value, loaded); loaded += value.length;
      if (loaded - painted >= 65536 || loaded === total) { painted = loaded; downloadProgress.set(id, { loaded, total }); renderDownloadProgress(id); }
    }
    downloadProgress.set(id, { loaded, total, decrypting: true }); renderDownloadProgress(id);
    await new Promise(resolve => setTimeout(resolve)); // paint "Decrypting…" before the decryptor runs
    return loaded === total ? bytes : bytes.subarray(0, loaded);
  } catch (e) { downloadProgress.delete(id); renderDownloadProgress(id); throw e; }
}
async function fetchAttachment(message, signal) {
  const file = message.file, label = fileKinds[file.kind], version = revision;
  const response = await fetch(`/api/attachments/${encodeURIComponent(file.id)}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`${label} expired or unavailable.`);
  let plain;
  try { plain = SilenzaCrypto.decryptAttachment(await readCiphertext(response, message), file); }
  finally { downloadProgress.delete(message.id); renderDownloadProgress(message.id); }
  // Only allow-listed formats whose bytes match the encrypted type are shown, never SVG/HTML or a server-provided MIME type.
  if (!SilenzaAttachments.matches(plain, file.type) || (file.kind === 'image' && !SilenzaAttachments.displayable(plain, file.type))) throw new Error(`Invalid private ${label.toLowerCase()}.`);
  if (version !== revision || signal?.aborted || !messages.some(m => m.id === message.id) || message.attachment.expiresAt <= Date.now()) throw new Error(`${label} no longer available.`);
  return plain;
}
function loadMedia(message) {
  const id = message.id;
  if (fileURLs.has(id)) return Promise.resolve(fileURLs.get(id));
  if (!fileLoads.has(id)) {
    const controller = new AbortController();
    const promise = fetchAttachment(message, controller.signal).then(plain => {
      if (controller.signal.aborted) throw new Error(`${fileKinds[message.file.kind]} no longer available.`);
      const url = URL.createObjectURL(new Blob([plain], { type: mediaType(message.file.type) })); fileURLs.set(id, url); return url;
    });
    fileLoads.set(id, { promise, controller });
    // A failed image stays failed until the conversation reloads; a player can be retried right away.
    if (message.file.kind !== 'image') promise.catch(() => { if (fileLoads.get(id)?.promise === promise) fileLoads.delete(id); });
  }
  return fileLoads.get(id).promise;
}
// Saved attachments are named after the message's date and time, e.g. 2026-10-04_14-05-09.jpg, instead of the sender's filename.
function attachmentName(message) {
  const date = new Date(Number.isNaN(Date.parse(message.time)) ? Date.now() : message.time), pad = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const extension = extensions[message.file.type] || /\.([a-z0-9]{1,10})$/i.exec(message.file.name || '')?.[1]?.toLowerCase();
  return extension ? `${stamp}.${extension}` : stamp;
}
function mediaPlayer(message, url) {
  if (filePlayers.has(message.id)) return filePlayers.get(message.id);
  const file = message.file, wrapper = element('div', 'attachment-player'), media = element(file.kind === 'video' ? 'video' : 'audio', `private-${file.kind}`);
  media.controls = true; media.preload = 'metadata';
  if (file.kind === 'video') { media.playsInline = true; if (file.width) { media.width = file.width; media.height = file.height; } }
  media.onerror = () => { media.hidden = true; wrapper.prepend(element('p', 'attachment-note', `This browser cannot play this ${file.kind}. Save it to open it in another app.`)); };
  const save = element('a', 'attachment-save', `Save ${file.kind}`); save.href = url; save.download = attachmentName(message);
  media.src = url; wrapper.append(media, save);
  filePlayers.set(message.id, wrapper); return wrapper;
}
function showImage(message, content, note) {
  const file = message.file, button = element('button', 'image-open'), img = element('img', 'private-image');
  img.alt = 'Private image'; img.width = file.width; img.height = file.height;
  button.type = 'button'; button.hidden = true; button.title = 'Open image'; button.setAttribute('aria-label', 'Open image in a larger view'); button.append(img);
  const save = element('a', 'attachment-save', 'Save photo'); save.hidden = true;
  content.append(button, save);
  const version = revision;
  loadMedia(message).then(url => {
    if (version !== revision) return;
    img.src = url; button.hidden = false; save.href = url; save.download = attachmentName(message); save.hidden = false;
    button.onclick = () => openImageViewer(url, attachmentName(message));
  }).catch(e => { button.hidden = true; note.textContent = e.message; });
}
function openImageViewer(url, name) {
  $('#image-viewer img').src = url; $('#image-viewer-save').href = url; $('#image-viewer-save').download = name;
  $('#image-viewer').showModal();
}
$('#image-viewer').onclick = event => { if (event.target === $('#image-viewer') || event.target.tagName === 'IMG') $('#image-viewer').close(); };
$('#image-viewer').onclose = () => { $('#image-viewer img').removeAttribute('src'); };
async function downloadFile(message) {
  const plain = await fetchAttachment(message);
  // Generic files are only ever saved, never opened as a page from this site.
  const url = URL.createObjectURL(new Blob([plain], { type: 'application/octet-stream' })), link = element('a', '');
  link.href = url; link.download = attachmentName(message); link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function renderAttachment(message, content) {
  const file = message.file, label = fileKinds[file.kind], note = element('p', 'attachment-note'); content.append(note);
  if (message.fileExpired || message.attachment.expiresAt <= Date.now()) { note.textContent = `${label} expired`; return; }
  note.textContent = `Encrypted ${label.toLowerCase()} · ${formatBytes(file.size)} · expires ${new Date(message.attachment.expiresAt).toLocaleString()}`;
  content.append(downloadProgressBox(message.id));
  if (file.kind === 'image') {
    // With "Show images only when I click them" on, nothing is downloaded until the image is asked for.
    if (mediaSettings.clickToShow && message.sender !== me.id && !fileURLs.has(message.id) && !fileLoads.has(message.id)) {
      const reveal = element('button', 'attachment-button image-reveal', 'Show image'); reveal.type = 'button';
      reveal.onclick = () => { reveal.remove(); showImage(message, content, note); };
      content.append(reveal); return;
    }
    showImage(message, content, note); return;
  }
  if (filePlayers.has(message.id)) { content.append(filePlayers.get(message.id)); return; }
  // Videos, audio and files are only downloaded when asked for.
  const button = element('button', 'attachment-button', file.kind === 'file' ? `Download ${file.name}` : `Load ${label.toLowerCase()}`);
  button.type = 'button';
  if (file.kind === 'file') button.title = 'Only open files from people you trust.';
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (file.kind === 'file') await downloadFile(message);
      else document.querySelector(`#message-${CSS.escape(message.id)} .attachment-button`)?.replaceWith(mediaPlayer(message, await loadMedia(message)));
    } catch (e) { note.textContent = e.message; }
    finally { button.disabled = false; }
  };
  content.append(button);
}
// An attachment is encrypted and uploaded in the background as soon as it is attached, so pressing
// send usually only has to post the message. The encryption itself is unchanged: a fresh key and
// nonce per upload, and only ciphertext leaves the browser. Unsent uploads are deleted on cancel
// and expire on the server after 10 minutes anyway.
const UNSENT_UPLOAD_MS = 9 * 60000;
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
function showUploadProgress(job) {
  if (pendingFile?.upload !== job) return;
  const box = $('#attachment-progress'), bar = box.querySelector('progress'), label = box.querySelector('span');
  box.hidden = false;
  if (job.phase === 'encrypting') { bar.removeAttribute('value'); label.textContent = 'Encrypting…'; }
  else if (job.phase === 'uploading') {
    bar.value = job.total ? job.loaded / job.total : 0;
    label.textContent = `Uploading encrypted file · ${Math.floor(bar.value * 100)}% · ${formatBytes(job.loaded)} of ${formatBytes(job.total)}`;
  } else if (job.phase === 'done') { bar.value = 1; label.textContent = 'Encrypted and uploaded · ready to send'; }
  else { box.hidden = true; }
}
function uploadEncryptedFile(file, target) {
  const job = { key: JSON.stringify(target), phase: 'encrypting', loaded: 0, total: 0, xhr: null, id: null, cancelled: false, claimed: false, uploadedAt: 0 };
  const cancelled = () => Object.assign(new Error('Upload cancelled.'), { cancelled: true });
  job.promise = (async () => {
    showUploadProgress(job);
    await nextFrame(); // let the progress bar paint before the encryptor blocks the page briefly
    if (job.cancelled) throw cancelled();
    const encrypted = SilenzaCrypto.encryptAttachment(file.bytes);
    job.phase = 'uploading'; job.total = encrypted.bytes.length; showUploadProgress(job);
    const result = await new Promise((resolve, reject) => {
      if (job.cancelled) { reject(cancelled()); return; }
      // XMLHttpRequest, because fetch cannot report upload progress.
      const xhr = new XMLHttpRequest(); job.xhr = xhr;
      xhr.open('POST', `/api/attachments?${new URLSearchParams(target)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = event => { job.loaded = event.loaded; showUploadProgress(job); };
      xhr.onload = () => {
        let body = {}; try { body = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && typeof body.id === 'string') resolve(body);
        else reject(Object.assign(new Error(body.error || 'Could not upload attachment.'), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('Could not upload attachment. Check your connection and try again.'));
      xhr.onabort = () => reject(cancelled());
      xhr.send(encrypted.bytes);
    });
    job.id = result.id; job.uploadedAt = Date.now();
    if (job.cancelled) { discardUpload(job); throw cancelled(); }
    job.phase = 'done'; showUploadProgress(job);
    return { id: result.id, key: encrypted.key, nonce: encrypted.nonce, kind: file.kind, type: file.type, size: file.size,
      ...(file.width ? { width: file.width, height: file.height } : {}), ...(file.kind === 'file' ? { name: file.name } : {}) };
  })();
  job.promise.catch(() => { if (pendingFile?.upload === job && !job.cancelled) { job.phase = 'failed'; showUploadProgress(job); } });
  return job;
}
function discardUpload(job) {
  if (!job || job.claimed) return;
  job.cancelled = true; job.xhr?.abort();
  if (job.id) { fetch(`/api/attachments/${encodeURIComponent(job.id)}`, { method: 'DELETE' }).catch(() => {}); job.id = null; }
}
// Starts the background upload for the attachment in the current conversation, when it is ready for one.
function preuploadPendingFile(file) {
  if (current?.peer && encryptionClient) file.upload = uploadEncryptedFile(file, { peer: current.peer });
  else if (current?.group && encryptionClient && groupState?.id === current.group && groupState.joined) file.upload = uploadEncryptedFile(file, { group: groupState.id, version: groupState.version });
}
// Uses the background upload when it went to the same place and is still fresh; otherwise uploads again.
// A claimed upload belongs to one send attempt; if that attempt fails, the send code deletes it.
async function attachmentFor(file, target) {
  const job = file.upload;
  if (job && !job.claimed && job.key === JSON.stringify(target) && !job.cancelled && (!job.uploadedAt || Date.now() - job.uploadedAt < UNSENT_UPLOAD_MS)) {
    try { const result = await job.promise; if (Date.now() - job.uploadedAt < UNSENT_UPLOAD_MS) { job.claimed = true; return result; } } catch (e) { if (e.cancelled) throw e; }
  }
  discardUpload(job);
  file.upload = uploadEncryptedFile(file, target);
  const result = await file.upload.promise; file.upload.claimed = true; return result;
}
async function showVerification(id) {
  if (!id || !encryptionClient) return;
  try {
    const person = await encryptionClient.peer(id);
    verificationTarget = person;
    $('#verification-code').textContent = encryptionClient.code(person);
    $('#verification-detail').textContent = person.verified ? 'You previously marked this identity as verified.' : 'Until you compare this code, this identity is trusted on first use.';
    $('#verification-error').textContent = ''; $('#verify-dialog').showModal();
  } catch(e) { error(e.message); }
}
$('#verify-identity').onclick = () => showVerification(current?.peer);
$('#confirm-verification').onclick = async () => {
  try {
    const fresh = await encryptionClient.peer(verificationTarget.id);
    if (fresh.publicKey !== verificationTarget.publicKey) throw new Error('Encryption identity changed.');
    const verified = await encryptionClient.verify(fresh);
    if (current?.peer === verified.id) { peerIdentity = verified; updateComposerState(); }
    $('#verify-dialog').close();
  } catch(e) { $('#verification-error').textContent = e.message; }
};
function setReply(message) {
  replying = message; $('#reply-preview').hidden = !message;
  $('#reply-preview span').textContent = message ? `Replying to ${message.alias}: ${message.text.slice(0, 120)}` : '';
}
$('#cancel-reply').onclick = () => { setReply(null); $('#message').focus(); };
function status(text) { $('#command-status').textContent = text; $('#command-status').hidden = !text; }
const commands = [
  { name: '/help', description: 'Show commands' }, { name: '/ban', description: 'Ban an account or guest' },
  { name: '/unban', description: 'Restore a banned session' }, { name: '/remove', description: 'Remove the message you are replying to' }
];
async function runCommand(text, reply) {
  const [, command, argument = ''] = text.match(/^(\/\S+)(?:\s+([\s\S]*))?$/);
  if (command === '/help') { status('/ban @Full Alias · /unban @Full Alias · /remove (select Reply first). Unlock Room management to moderate. Use // to send text starting with /.'); return; }
  if (!commands.some(c => c.name === command)) throw new Error('Unknown command. Type /help to see available commands.');
  if (!me.admin) throw new Error('Unlock Room management before using admin commands.');
  if (command === '/remove') {
    if (!reply || argument) throw new Error('Select Reply on a message, then send /remove.');
    await api('admin/remove-message', { id: reply.id }); status('Message removed.'); return;
  }
  if (!argument) throw new Error(`Usage: ${command} @Full Alias`);
  const state = await api('admin/state');
  const query = argument.replace(/^@/, '').trim().toLowerCase();
  const found = (command === '/ban' ? state.people : state.bans).filter(p => p.id === query || p.alias.toLowerCase() === query);
  if (found.length !== 1) throw new Error('Choose one exact alias from autocomplete, or use a session ID.');
  await api(`admin/${command.slice(1)}`, { id: found[0].id });
  status(`${found[0].alias} ${command === '/ban' ? 'banned' : 'unbanned'}.`);
  await refreshAdminState();
}
$('#composer').onsubmit = async event => {
  event.preventDefault(); if (!current || sending) return;
  const draft = $('#message').value, text = draft.trim(); if ((!text && !pendingFile) || filePreparing) return;
  const target = { ...current }, version = revision, reply = replying, pending = pendingFile; sending = true; $('.send-button').disabled = true; error(); status('');
  closeSuggestions(); toggleEmoji(false);
  let uploadId;
  try {
    if (pending && text.startsWith('/') && !text.startsWith('//')) throw new Error('Send the attachment separately from a command.');
    if (text.startsWith('/') && !text.startsWith('//')) await runCommand(text, reply);
    else if (target.group) {
      if (!encryptionClient) throw new Error(encryptionError || 'Room encryption is unavailable.');
      // The room state pushed over the event stream is normally current, which saves a round trip per
      // message. If membership changed in the meantime the server answers 409, and the message is
      // encrypted again for the current members (up to three attempts) instead of failing.
      let state = groupState?.id === target.group && groupState.joined ? groupState : null;
      const id = crypto.randomUUID();
      for (let attempt = 1; ; attempt++) {
        state ||= await api(`groups/state?group=${encodeURIComponent(target.group)}`);
        try {
          const file = pending ? await attachmentFor(pending, { group: state.id, version: state.version }) : null;
          uploadId = file?.id;
          const envelopes = await encryptionClient.encryptGroup({ id, group: state.id, version: state.version, sender: me.id,
            text: text.startsWith('//') ? text.slice(1) : text, replyTo: reply?.id || null, file, shareable: Boolean(state.shareHistory) }, state.members);
          await receive(await api('groups/message', { group: state.id, version: state.version, id, envelopes, replyTo: reply?.id, attachmentId: uploadId, shareable: Boolean(state.shareHistory) }));
          break;
        } catch (e) {
          if (attempt >= 3 || e.status !== 409) throw e;
          if (uploadId) { fetch(`/api/attachments/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {}); uploadId = null; }
          state = null;
        }
      }
      uploadId = null; status('');
      if (pendingFile === pending) clearPendingFile();
    } else if (target.peer) {
      if (!encryptionClient) throw new Error(encryptionError || 'Private encryption is unavailable.');
      const person = await encryptionClient.peer(target.peer);
      const file = pending ? await attachmentFor(pending, { peer: target.peer }) : null;
      uploadId = file?.id;
      const id = crypto.randomUUID();
      const encrypted = encryptionClient.encrypt({ id, sender: me.id, recipient: target.peer, text: text.startsWith('//') ? text.slice(1) : text, replyTo: reply?.id || null, file }, person);
      await receive(await api('message', { peer: target.peer, id, encrypted, replyTo: reply?.id, attachmentId: uploadId }));
      uploadId = null; status('');
      if (pendingFile === pending) clearPendingFile();
    } else {
      if (pending) throw new Error('Attachments can only be sent in encrypted conversations.');
      await receive(await api('message', { ...target, text: text.startsWith('//') ? text.slice(1) : text, replyTo: reply?.id }));
    }
    if (drafts.get(conversationKey(target)) === draft) drafts.delete(conversationKey(target));
    if (version === revision && $('#message').value === draft) { $('#message').value = ''; $('#message').style.height = ''; if (replying === reply) setReply(null); }
  } catch(e) { error(e.message); status(''); if (uploadId) fetch(`/api/attachments/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {}); }
  finally { sending = false; updateComposerState(); $('#message').focus(); }
};
function closeSuggestions() { suggestions = []; $('#suggestions').hidden = true; $('#message').removeAttribute('aria-activedescendant'); }
function renderSuggestions() {
  $('#suggestions').hidden = !suggestions.length;
  $('#suggestions').replaceChildren(...suggestions.map((item, index) => {
    const button = element('button', index === suggestionIndex ? 'selected' : '', item.label);
    button.type = 'button'; button.id = `suggestion-${index}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === suggestionIndex));
    button.onmousedown = event => event.preventDefault(); button.onclick = () => chooseSuggestion(index); return button;
  }));
  if (suggestions.length) $('#message').setAttribute('aria-activedescendant', `suggestion-${suggestionIndex}`);
  else $('#message').removeAttribute('aria-activedescendant');
}
function updateSuggestions() {
  const input = $('#message'), before = input.value.slice(0, input.selectionStart);
  suggestions = []; suggestionIndex = 0;
  if (/^\/[^\s]*$/.test(before)) {
    completionStart = 0; suggestions = commands.filter(c => c.name.startsWith(before)).map(c => ({ label: `${c.name} — ${c.description}`, value: `${c.name} ` }));
  } else {
    const command = before.match(/^\/(ban|unban)\s+(@?)(.*)$/), mention = before.match(/(?:^|\s)@([^@\n]*)$/);
    if (command || mention) {
      const query = (command ? command[3] : mention[1]).toLowerCase();
      completionStart = command ? before.indexOf(' ') + 1 : before.lastIndexOf('@');
      const candidates = command?.[1] === 'unban' ? adminBans : current?.group && !command ? groupState?.members || [] : [...new Map([...(me ? [me] : []), ...people, ...messages.map(m => ({ id: m.sender, alias: m.alias }))].map(p => [p.id, p])).values()];
      suggestions = candidates.filter(p => (!current?.peer || command || p.id === me.id || p.id === current.peer) && p.alias.toLowerCase().includes(query) && (!command || p.id !== me.id)).slice(0, 8).map(p => ({ label: p.alias, value: `@${p.alias} ` }));
    }
  }
  renderSuggestions();
}
function insertText(value, start = $('#message').selectionStart, end = $('#message').selectionEnd) {
  const input = $('#message');
  if (input.value.length - (end - start) + value.length > input.maxLength) { error('Use at most 2,000 characters.'); return; }
  input.setRangeText(value, start, end, 'end'); input.focus(); resizeComposer();
}
function chooseSuggestion(index) { const item = suggestions[index]; if (item) insertText(item.value, completionStart, $('#message').selectionStart); closeSuggestions(); }
function resizeComposer() { $('#message').style.height = 'auto'; $('#message').style.height = `${Math.min($('#message').scrollHeight, 150)}px`; }
$('#message').onkeydown = event => {
  if (event.isComposing) return;
  if (event.key === 'Escape') { closeSuggestions(); toggleEmoji(false); return; }
  if (suggestions.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key) && !event.shiftKey) {
    event.preventDefault();
    if (event.key === 'Enter' || event.key === 'Tab') chooseSuggestion(suggestionIndex);
    else { suggestionIndex = (suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length; renderSuggestions(); }
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!sending) $('#composer').requestSubmit(); }
};
$('#message').oninput = () => { resizeComposer(); updateSuggestions(); };
$('#message').onclick = updateSuggestions;
$('#message').onkeyup = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateSuggestions(); };
const emojis = [
  // Smileys
  ['😀','grinning happy'],['😃','smile big eyes happy'],['😄','smile happy'],['😁','beaming grin'],['😆','laughing squint'],['😅','sweat smile'],['🤣','rolling floor laughing rofl'],['😂','laugh tears joy'],
  ['🙂','slight smile'],['🙃','upside down'],['😉','wink'],['😊','smile blush'],['😇','angel halo innocent'],['🥰','smiling hearts love'],['😍','love heart eyes'],['🤩','star struck excited'],
  ['😘','kiss blow'],['😗','kissing'],['😋','yum tasty'],['😛','tongue out'],['😜','wink tongue silly'],['🤪','zany crazy'],['😝','squint tongue'],['🤑','money mouth'],
  ['🤗','hug hugging'],['🤭','hand over mouth oops'],['🤫','shush quiet'],['🤔','thinking'],['🤐','zipper mouth secret'],['🤨','raised eyebrow skeptical'],['😐','neutral face'],['😑','expressionless'],
  ['😶','no mouth speechless'],['😏','smirk'],['😒','unamused'],['🙄','eye roll'],['😬','grimace awkward'],['😌','relieved calm'],['😔','pensive'],['😪','sleepy'],
  ['🤤','drool'],['😴','sleep tired'],['😷','mask sick'],['🤒','thermometer ill fever'],['🤕','bandage hurt'],['🤢','nauseated'],['🤮','vomit'],['🥵','hot face'],
  ['🥶','cold face freezing'],['🥴','woozy dizzy'],['😵','dizzy face'],['🤯','mind blown exploding head'],['🤠','cowboy'],['🥳','party celebration'],['🥸','disguise'],['😎','cool sunglasses'],
  ['🤓','nerd glasses'],['🧐','monocle'],['😕','confused'],['😟','worried'],['🙁','slight frown'],['😮','open mouth surprised'],['😯','hushed'],['😲','astonished shocked'],
  ['😳','flushed embarrassed'],['🥺','pleading puppy eyes'],['🥹','touched tears'],['😦','frown open mouth'],['😨','fearful scared'],['😰','anxious sweat'],['😥','sad relieved'],['😢','sad cry'],
  ['😭','cry sob'],['😱','scream fear'],['😖','confounded'],['😣','persevere'],['😞','disappointed'],['😓','downcast sweat'],['😩','weary'],['😫','tired exhausted'],
  ['🥱','yawn bored'],['😤','triumph huff'],['😡','pouting angry'],['😠','angry mad'],['🤬','swearing cursing'],['😈','smiling devil'],['💀','skull dead'],['💩','poop'],
  ['🤡','clown'],['👻','ghost'],['👽','alien'],['🤖','robot'],['😺','grinning cat'],['😹','cat tears joy'],['😻','cat heart eyes'],['🙈','see no evil monkey'],
  ['🙉','hear no evil monkey'],['🙊','speak no evil monkey'],
  // Hearts and symbols
  ['❤️','red heart love'],['🧡','orange heart'],['💛','yellow heart'],['💚','green heart'],['💙','blue heart'],['💜','purple heart'],['🖤','black heart'],['🤍','white heart'],
  ['🤎','brown heart'],['💔','broken heart'],['❣️','heart exclamation'],['💕','two hearts'],['💞','revolving hearts'],['💓','beating heart'],['💗','growing heart'],['💖','sparkling heart'],
  ['💘','heart arrow cupid'],['💝','heart ribbon gift'],['💯','hundred'],['💢','anger symbol'],['💥','collision boom'],['💫','dizzy star'],['💦','sweat droplets'],['💨','dash'],
  ['💬','speech bubble'],['💭','thought bubble'],['💤','zzz sleep'],['✅','check mark done'],['❌','cross no'],['❓','question'],['❗','exclamation'],['⚠️','warning'],
  ['🚫','prohibited'],['♻️','recycle'],['➕','plus'],['➖','minus'],['🆗','ok button'],['🆒','cool button'],['🆕','new button'],['🔔','bell'],
  ['🎵','music note'],['🎶','music notes'],['⭐','star'],['🌟','glowing star'],['✨','sparkles'],['⚡','lightning zap'],['🔥','fire'],['💡','idea light bulb'],
  // Hands and people
  ['👍','thumbs up yes'],['👎','thumbs down no'],['👋','wave hello'],['🤚','raised back of hand'],['✋','raised hand stop'],['🖖','vulcan salute'],['👌','ok hand'],['🤌','pinched fingers'],
  ['🤏','pinching small'],['✌️','victory peace'],['🤞','crossed fingers luck'],['🤟','love you gesture'],['🤘','rock on horns'],['🤙','call me'],['👈','point left'],['👉','point right'],
  ['👆','point up'],['👇','point down'],['☝️','index up'],['✊','raised fist'],['👊','fist bump punch'],['🤛','left fist'],['🤜','right fist'],['👏','clap applause'],
  ['🙌','hooray raised hands'],['👐','open hands'],['🤲','palms up'],['🤝','handshake'],['🙏','thanks pray'],['✍️','writing'],['💪','strong muscle flex'],['🧠','brain smart'],
  ['👀','eyes look'],['👁️','eye'],['👅','tongue'],['👄','mouth lips'],['🫶','heart hands'],['🤷','shrug'],['🤦','facepalm'],['🙋','raising hand'],
  ['🙇','bow'],['💁','tipping hand'],['🙅','no gesture'],['🙆','ok gesture'],['🕺','dancing man'],['💃','dancing woman'],['🏃','running'],['🚶','walking'],
  // Animals and nature
  ['🐱','cat'],['🐶','dog'],['🦊','fox'],['🐭','mouse'],['🐹','hamster'],['🐰','rabbit bunny'],['🐻','bear'],['🐼','panda'],
  ['🐨','koala'],['🐯','tiger'],['🦁','lion'],['🐮','cow'],['🐷','pig'],['🐸','frog'],['🐵','monkey'],['🐔','chicken'],
  ['🐧','penguin'],['🐦','bird'],['🐤','chick'],['🦉','owl'],['🦄','unicorn'],['🐝','bee'],['🦋','butterfly'],['🐌','snail'],
  ['🐞','ladybug'],['🐢','turtle'],['🐍','snake'],['🐙','octopus'],['🐳','whale'],['🐬','dolphin'],['🐟','fish'],['🦈','shark'],
  ['🦖','dinosaur t-rex'],['🌸','cherry blossom'],['🌹','rose'],['🌻','sunflower'],['🌷','tulip'],['🌱','seedling sprout'],['🌲','evergreen tree'],['🌴','palm tree'],
  ['🌵','cactus'],['🍀','four leaf clover luck'],['🍁','maple leaf autumn'],['🍄','mushroom'],['🌍','earth globe world'],['🌙','moon night'],['☀️','sun sunny'],['⛅','partly cloudy'],
  ['🌧️','rain'],['❄️','snowflake'],['☃️','snowman'],['🌈','rainbow'],['🌊','ocean water sea'],['☔','umbrella rain'],
  // Food and drink
  ['🍎','apple'],['🍌','banana'],['🍉','watermelon'],['🍓','strawberry'],['🍒','cherries'],['🍑','peach'],['🍍','pineapple'],['🥑','avocado'],
  ['🍆','eggplant'],['🌶️','hot pepper spicy'],['🥕','carrot'],['🌽','corn'],['🥐','croissant'],['🍞','bread'],['🧀','cheese'],['🥚','egg'],
  ['🥞','pancakes'],['🥓','bacon'],['🍔','burger hamburger'],['🍟','fries'],['🍕','pizza'],['🌭','hot dog'],['🌮','taco'],['🌯','burrito'],
  ['🍝','spaghetti pasta'],['🍜','ramen noodles'],['🍣','sushi'],['🍿','popcorn'],['🍩','donut doughnut'],['🍪','cookie'],['🎂','birthday cake'],['🍰','cake slice'],
  ['🧁','cupcake'],['🍫','chocolate'],['🍬','candy'],['🍦','ice cream'],['☕','coffee'],['🍵','tea'],['🧋','bubble tea boba'],['🥤','soda cup'],
  ['🍺','beer'],['🍻','cheers beers'],['🥂','cheers champagne toast'],['🍷','wine'],['🍸','cocktail'],['🧃','juice box'],
  // Activities, objects and travel
  ['🎉','party celebration'],['🎊','confetti'],['🎈','balloon'],['🎁','gift present'],['🏆','trophy winner'],['🥇','gold medal first'],['⚽','soccer football'],['🏀','basketball'],
  ['🏈','american football'],['⚾','baseball'],['🎾','tennis'],['🏐','volleyball'],['🎮','video game controller'],['🕹️','joystick'],['🎲','dice game'],['🧩','puzzle'],
  ['🎯','target bullseye'],['🎨','art palette'],['🎬','movie clapper'],['🎤','microphone karaoke'],['🎧','headphones'],['🎸','guitar'],['🎹','piano keyboard'],['📚','books'],
  ['📖','open book'],['✏️','pencil'],['📝','memo note'],['📌','pushpin'],['📎','paperclip'],['📅','calendar'],['⏰','alarm clock'],['⌛','hourglass'],
  ['💻','laptop computer'],['📱','phone mobile'],['📷','camera'],['📺','tv television'],['🔒','lock locked'],['🔓','unlocked'],['🔑','key'],['🛡️','shield'],
  ['💰','money bag'],['💸','money wings'],['💎','gem diamond'],['🔮','crystal ball'],['🧸','teddy bear'],['🪴','potted plant'],['🛏️','bed'],['🚀','rocket launch'],
  ['✈️','airplane'],['🚗','car'],['🚲','bicycle'],['🚂','train'],['⛵','sailboat'],['🏠','house home'],['🏖️','beach'],['⛰️','mountain'],
  ['🏕️','camping'],['🗺️','map'],['🌋','volcano'],['🎃','jack o lantern halloween pumpkin'],['🎄','christmas tree'],['🏳️‍🌈','rainbow flag pride']
];
let emojiSelection = [0, 0];
function toggleEmoji(open) {
  $('#emoji-picker').hidden = !open; $('#emoji-toggle').setAttribute('aria-expanded', String(open));
  if (open) { emojiSelection = [$('#message').selectionStart, $('#message').selectionEnd]; closeSuggestions(); $('#emoji-search').value = ''; renderEmoji(); $('#emoji-search').focus(); }
}
function renderEmoji() {
  const query = $('#emoji-search').value.toLowerCase().trim();
  const buttons = emojis.filter(([emoji, name]) => name.includes(query) || emoji === query).map(([emoji, name]) => {
    const button = element('button', '', emoji); button.type = 'button'; button.title = name; button.setAttribute('aria-label', name);
    button.onclick = () => { insertText(emoji, ...emojiSelection); toggleEmoji(false); }; return button;
  });
  $('#emoji-grid').replaceChildren(...buttons);
  if (!buttons.length) $('#emoji-grid').append(element('p', '', 'No emoji found.'));
}
$('#emoji-toggle').onclick = () => toggleEmoji($('#emoji-picker').hidden);
$('#emoji-search').oninput = renderEmoji;
$('#emoji-picker').onkeydown = event => { if (event.key === 'Escape') { toggleEmoji(false); $('#emoji-toggle').focus(); } };
document.addEventListener('click', event => { if (!event.target.closest('.composer-wrap')) { closeSuggestions(); toggleEmoji(false); } });
for (const close of document.querySelectorAll('.close-dialog')) close.onclick = () => close.closest('dialog').close();
$('#privacy-button').onclick = $('#faq-button').onclick = () => $('#privacy-dialog').showModal();
const topbarActions = $('.topbar-actions'), moreMenu = $('.topbar-more'), moreToggle = $('#more-toggle'), phoneLayout = matchMedia('(max-width: 600px)');
function toggleMoreMenu(open) { moreMenu.classList.toggle('open', open); moreToggle.setAttribute('aria-expanded', String(open)); }
function placeTopbarActions() {
  toggleMoreMenu(false);
  if (phoneLayout.matches) $('.brand').after(topbarActions); else $('.topbar').append(topbarActions);
}
placeTopbarActions();
phoneLayout.addEventListener('change', placeTopbarActions);
moreToggle.onclick = () => toggleMoreMenu(!moreMenu.classList.contains('open'));
$('#topbar-links').addEventListener('click', event => { if (event.target.closest('.faq-link')) toggleMoreMenu(false); });
document.addEventListener('click', event => { if (!event.target.closest('.topbar-more')) toggleMoreMenu(false); });
moreMenu.addEventListener('keydown', event => { if (event.key === 'Escape' && moreMenu.classList.contains('open')) { toggleMoreMenu(false); moreToggle.focus(); } });
$('#open-admin').onclick = () => { $('#admin-error').textContent = ''; $('#admin-dialog').showModal(); refreshFeedback(); refreshAdminState(); };
let feedbackRequest = 0;
async function refreshFeedback() {
  if (!me?.admin) return;
  const request = ++feedbackRequest;
  $('#feedback-inbox-status').textContent = 'Loading feedback…';
  try {
    const items = await api('admin/feedback');
    if (!me?.admin || request !== feedbackRequest) return;
    $('#feedback-count').textContent = `(${items.filter(item => !item.reviewed).length} new)`;
    $('#feedback-inbox-status').textContent = items.length ? '' : 'No feedback yet.';
    $('#admin-feedback').replaceChildren(...items.map(item => {
      const entry = element('details', 'feedback-entry'), summary = element('summary', '', item.title);
      summary.append(element('span', 'feedback-state', item.reviewed ? 'Reviewed' : 'New'));
      const date = element('time', 'feedback-date', new Date(item.createdAt).toLocaleString()); date.dateTime = item.createdAt;
      const actions = element('div', 'feedback-actions');
      for (const [action, label] of [['update', item.reviewed ? 'Mark as new' : 'Mark reviewed'], ['delete', 'Delete']]) {
        const button = element('button', action === 'delete' ? 'danger-small' : 'text-button', label); button.type = 'button';
        button.onclick = async () => {
          if (action === 'delete' && !confirm('Delete this feedback permanently?')) return;
          button.disabled = true;
          try { await api(`admin/feedback/${action}`, { id: item.id, reviewed: !item.reviewed }); await refreshFeedback(); }
          catch (e) { $('#feedback-inbox-status').textContent = e.message; button.disabled = false; }
        };
        actions.append(button);
      }
      entry.append(summary, date, element('p', 'feedback-text', item.text), actions); return entry;
    }));
  } catch (e) { if (me?.admin && request === feedbackRequest) $('#feedback-inbox-status').textContent = e.message; }
}
$('#refresh-feedback').onclick = refreshFeedback;
function setAdmin(admin) {
  me.admin = admin; $('#open-admin').hidden = !admin;
  if (!admin) me.displayAsAdmin = false;
  $('#admin-login').hidden = admin; $('#admin-controls').hidden = !admin;
  $('#display-as-admin').checked = Boolean(me.displayAsAdmin);
  $('#my-alias').replaceChildren(username(me.alias, '', me.displayAsAdmin));
  if (admin) refreshFeedback();
  else { adminStateRequest++; adminGroups = []; renderAdminGroups(); $('#moderate-group-dialog').close(); feedbackRequest++; $('#admin-feedback').replaceChildren(); $('#feedback-count').textContent = ''; $('#feedback-inbox-status').textContent = ''; }
}
function updateAppearance(person) {
  // Profile fields are omitted when cleared, so replace rather than merge them.
  people = people.map(p => { if (p.id !== person.id) return p; const { gender, age, ...rest } = p; return { ...rest, ...person }; }); lastPeopleData = '';
  renderPeople(); renderDMs(); if (current?.peer === person.id) updateHeading();
}
// Settings: an identity card that previews your profile, and one panel per section.
const chosenGender = () => document.querySelector('input[name="profile-gender"]:checked')?.value || '';
function previewProfile() {
  // Like gender, age has an explicit "Not shown" choice: it is selected whenever the field is empty.
  const hidden = !$('#profile-age').value && !$('#profile-age').validity.badInput;
  $('#profile-age-hide').setAttribute('aria-pressed', String(hidden));
  const age = Number($('#profile-age').value);
  const draft = { gender: chosenGender(), age: Number.isInteger(age) && age >= 18 && age <= 99 ? age : null };
  $('#settings-preview').textContent = [me.account ? 'Persistent account' : 'Guest identity', profileText(draft)].filter(Boolean).join(' · ');
}
function fillProfileForm() {
  for (const input of document.querySelectorAll('input[name="profile-gender"]')) input.checked = input.value === (me.gender || '');
  $('#profile-age').value = me.age || '';
  $('#settings-avatar').textContent = initials(me.alias); $('#settings-alias').replaceChildren(username(me.alias, '', me.displayAsAdmin));
  $('#account-guest-note').hidden = Boolean(me.account); previewProfile();
}
$('#profile-form').oninput = previewProfile;
$('#profile-age-hide').onclick = () => { $('#profile-age').value = ''; previewProfile(); };
let settingsTab = 'profile';
function showSettingsTab(name, focus = false) {
  settingsTab = name;
  for (const tab of document.querySelectorAll('.settings-nav [role="tab"]')) {
    const selected = tab.id === `settings-tab-${name}`;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    $(`#${tab.getAttribute('aria-controls')}`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  $('.settings-panels').scrollTop = 0;
}
for (const tab of document.querySelectorAll('.settings-nav [role="tab"]')) {
  tab.onclick = () => showSettingsTab(tab.id.slice('settings-tab-'.length));
  // Arrow keys move between sections, as in any tab list.
  tab.onkeydown = event => {
    const tabs = [...document.querySelectorAll('.settings-nav [role="tab"]')], index = tabs.indexOf(tab);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const next = step ? tabs[(index + step + tabs.length) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
    if (next) { event.preventDefault(); showSettingsTab(next.id.slice('settings-tab-'.length), true); }
  };
}
$('#profile-form').onsubmit = async event => {
  event.preventDefault(); const button = $('#profile-form button[type="submit"]'); button.disabled = true; $('#profile-status').textContent = '';
  try {
    const age = $('#profile-age').value.trim();
    updateSession(await api('profile', { gender: chosenGender() || null, age: age ? Number(age) : null }));
    $('#profile-status').textContent = 'Profile saved. Others see it next to your name.';
  } catch (e) { $('#profile-status').textContent = e.message; } finally { button.disabled = false; }
};
function updateSession(session) { delete me.gender; delete me.age; Object.assign(me, session); if (!$('#settings-dialog').open) fillProfileForm(); updateComposerState(); $('#identity-kind').textContent = me.account ? 'Persistent account' : 'Guest identity'; $('#account-security').hidden = !me.account; setAdmin(me.admin); updateAppearance(me); renderMessages(); }
$('#display-as-admin').onchange = async event => {
  const toggle = event.target; toggle.disabled = true;
  try { updateSession(await api('admin/appearance', { displayAsAdmin: toggle.checked })); $('#admin-error').textContent = ''; }
  catch(e) { toggle.checked = Boolean(me.displayAsAdmin); $('#admin-error').textContent = e.message; }
  finally { toggle.disabled = false; }
};
let adminStateRequest = 0;
async function refreshAdminState() {
  if (!me?.admin) return;
  try {
    const request = ++adminStateRequest;
    const state = await api('admin/state');
    if (!me?.admin || request !== adminStateRequest) return;
    adminGroups = state.groups || []; renderAdminGroups();
    people = state.people; lastPeopleData = ''; adminBans = state.bans;
    renderPeople(); renderAdminPeople(); renderAdminBans(); renderMessages();
  } catch(e) { $('#admin-error').textContent = e.message; }
}
function renderAdminPeople() {
  const list = $('#admin-people'); if (!list) return;
  list.replaceChildren(...people.map(person => {
    const row = element('div', 'admin-person'), button = element('button', 'danger-small', 'Ban');
    row.append(username(`${person.alias}${person.id === me?.id ? ' (you)' : ''}`, '', person.displayAsAdmin), button);
    button.disabled = person.id === me?.id;
    button.onclick = () => { banning = person; $('#ban-description').textContent = `“${person.alias}” will be disconnected. An account ban blocks all sessions and future logins for that account. A guest ban blocks this browser session.`; $('#ban-error').textContent = ''; $('#ban-dialog').showModal(); };
    return row;
  }));
  if (!people.length) list.append(element('p', 'admin-empty', 'No one is online.'));
}
function renderAdminBans() {
  const list = $('#admin-bans'); if (!list) return;
  list.replaceChildren(...adminBans.map(ban => {
    const row = element('div', 'admin-person'), button = element('button', 'text-button', 'Unban');
    row.append(element('span', '', ban.alias), button);
    button.onclick = async () => { button.disabled = true; try { await api('admin/unban', { id: ban.id }); await refreshAdminState(); } catch(e) { $('#admin-error').textContent = e.message; button.disabled = false; } };
    return row;
  }));
  if (!adminBans.length) list.append(element('p', 'admin-empty', 'No banned users.'));
}
$('#create-room').onsubmit = async event => { event.preventDefault(); const button = $('#create-room button'); button.disabled = true; try { await api('admin/create', { name: $('#new-room').value, description: $('#new-description').value }); $('#create-room').reset(); $('#admin-error').textContent = ''; } catch(e) { $('#admin-error').textContent = e.message; } finally { button.disabled = false; } };
function renderAdminRooms() {
  $('#admin-rooms').replaceChildren(...rooms.filter(room => !room.adminOnly).map(room => { const row = element('div', 'admin-room'), button = element('button', 'delete-room', 'Remove'); row.append(element('span', '', room.name), button); button.onclick = () => { deleting = { id: room.id, group: false }; $('#delete-description').textContent = `“${room.name}” and its message history will be removed for everyone. This cannot be undone.`; $('#delete-error').textContent = ''; $('#delete-dialog').showModal(); }; return row; }));
}
$('#cancel-delete').onclick = () => $('#delete-dialog').close();
$('#confirm-delete').onclick = async () => { $('#confirm-delete').disabled = true; try { await api(deleting.group ? 'admin/groups/delete' : 'admin/delete', deleting.group ? { group: deleting.id } : { id: deleting.id }); await refreshAdminState(); $('#delete-dialog').close(); } catch(e) { $('#delete-error').textContent = e.message; } finally { $('#confirm-delete').disabled = false; } };
$('#cancel-ban').onclick = () => $('#ban-dialog').close();
$('#confirm-ban').onclick = async () => { $('#confirm-ban').disabled = true; try { await api('admin/ban', { id: banning.id }); $('#ban-dialog').close(); await refreshAdminState(); } catch(e) { $('#ban-error').textContent = e.message; } finally { $('#confirm-ban').disabled = false; } };
// The event stream delivers every live update. Slow or anonymising networks (such as Tor) can leave
// it open but silent, or make the browser give up reconnecting, so the server sends a ping every
// 15 seconds and the page reconnects itself when nothing arrives for 45 seconds. Every (re)connect
// catches up on what was missed instead of reloading the conversation.
const seenPeople = new Set();
let lastEvent = 0, lastPeopleData = '', lastRoomsData = '', reconnectTimer = 0, reconnectDelay = 2000, groupsChangedTimer = 0;
function connect() {
  clearTimeout(reconnectTimer); stream?.close();
  if (signingOut || !me) return;
  stream = new EventSource('/api/events'); lastEvent = Date.now();
  stream.onopen = () => { lastEvent = Date.now(); reconnectDelay = 2000; $('#connection').textContent = 'Connected'; $('#connection').classList.add('live'); resync(); checkForUpdate(); };
  stream.onerror = async () => {
    if (signingOut) return;
    $('#connection').textContent = 'Reconnecting…'; $('#connection').classList.remove('live');
    // The browser retries by itself unless the server refused the stream; then retry with a growing delay.
    if (stream.readyState === EventSource.CLOSED) { reconnectTimer = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 30000); }
    try { const auth = await api('auth/status'); if (!signingOut && (!auth.me || auth.me.id !== me.id)) { stream.close(); clearTimeout(reconnectTimer); location.replace('/#entry'); } } catch {}
  };
  stream.addEventListener('ping', () => { lastEvent = Date.now(); });
  stream.addEventListener('private-preferences', event => applyPrivatePreferences(JSON.parse(event.data)));
  stream.addEventListener('identity-ready', event => { const { id } = JSON.parse(event.data); if (current?.peer === id && !peerIdentity) select(current); });
  stream.addEventListener('session', event => updateSession(JSON.parse(event.data)));
  // Several room changes often arrive together; one refresh covers them all.
  stream.addEventListener('groups-changed', () => { clearTimeout(groupsChangedTimer); groupsChangedTimer = setTimeout(() => { refreshGroups(); refreshAdminState(); }, 250); });
  stream.addEventListener('group-state', event => groupStateChanged(JSON.parse(event.data)));
  stream.addEventListener('group-request', event => {
    const { group, name, approved } = JSON.parse(event.data);
    const waiting = groupPanel?.id === group && !groupPanel.joined && $('#group-dialog').open;
    if (groupPanel?.id === group && !groupPanel.joined) { $('#group-dialog').close(); groupPanel = null; }
    if (approved && waiting) refreshGroups().then(() => select({ group }));
    else if (approved) { status(`Your request to join “${name}” was approved. Open it under Temporary rooms.`); refreshGroups(); }
    else { status(`Your request to join “${name}” was declined.`); refreshGroups(); }
  });
  stream.addEventListener('history-shared', event => { const { group } = JSON.parse(event.data); if (current?.group === group) loadSharedHistory(group); });
  stream.addEventListener('group-removed', event => {
    const removed = JSON.parse(event.data); drafts.delete(`group:${removed.group}`); unread.delete(`group:${removed.group}`); updateUnreadTitle();
    if (current?.group === removed.group) closeCurrentGroup(removed.reason);
    if (groupPanel?.id === removed.group) { $('#group-dialog').close(); groupPanel = null; }
    refreshGroups();
  });
  stream.addEventListener('appearance', event => updateAppearance(JSON.parse(event.data)));
  stream.addEventListener('people', event => {
    // Presence fan-outs often repeat an unchanged list; skip rebuilding the sidebar then.
    if (event.data === lastPeopleData) return;
    lastPeopleData = event.data; people = JSON.parse(event.data);
    // A new session of someone you blocked must be hidden too, and only the server knows whose it is.
    // Ask only when you have blocked someone and a session appears that this page has not seen yet.
    const fresh = people.some(person => !seenPeople.has(person.id));
    for (const person of people) seenPeople.add(person.id);
    if (fresh && blockedUsers.length) api('private/preferences').then(applyPrivatePreferences).catch(() => {});
    renderPeople(); renderDMs(); renderAdminPeople();
  });
  stream.addEventListener('rooms', event => { if (event.data === lastRoomsData && current) return; lastRoomsData = event.data; rooms = JSON.parse(event.data); if (current?.room && !rooms.some(r => r.id === current.room)) { select(rooms[0] ? { room: rooms[0].id } : null); error('That room was removed by the host.'); } else if (!current && rooms[0]) select({ room: rooms[0].id }); else { renderRooms(); updateHeading(); } });
  stream.addEventListener('message', event => receive(JSON.parse(event.data)));
  stream.addEventListener('message-edited', event => applyEdit(JSON.parse(event.data)));
  stream.addEventListener('message-removed', event => applyRemoval(JSON.parse(event.data)));
  stream.addEventListener('messages-read', event => applyRead(JSON.parse(event.data)));
  stream.addEventListener('moderation', () => { if (me.admin) refreshAdminState(); });
}
// A tab left open across an update would keep running old code against the new server. The page knows
// the build it was loaded from; after a reconnect, or when the tab is shown again, a newer build on the
// server is offered as a reload instead.
const pageBuild = document.querySelector('meta[name="silenza-build"]')?.content;
let updateChecked = 0;
async function checkForUpdate() {
  if (!pageBuild || !$('#update-banner').hidden || Date.now() - updateChecked < 10000) return;
  updateChecked = Date.now();
  try { const { build } = await api('version'); if (build && build !== pageBuild) $('#update-banner').hidden = false; } catch {}
}
$('#update-reload').onclick = () => location.reload();
function checkConnection() {
  if (stream && !signingOut && stream.readyState !== EventSource.CLOSED && Date.now() - lastEvent > 45000) connect();
}
async function start() {
  try {
    const auth = await api('auth/status');
    if (!auth.me) {
      // Keep a room invite link across sign-in; the entry page returns to /chat/ without the fragment.
      if (location.hash.startsWith('#invite=')) try { sessionStorage.setItem('silenza-invite', location.hash); } catch {}
      location.replace('/#entry'); return;
    }
    const data = await api('session'); me = data.me; rooms = data.rooms; if (Number.isSafeInteger(data.attachmentLimit)) attachmentLimit = data.attachmentLimit; if (Number.isSafeInteger(data.attachmentLifetime) && data.attachmentLifetime > 0) attachmentLifetime = data.attachmentLifetime; people = data.people; blockedUsers = data.blocks || []; hiddenChats = new Set(data.hiddenChats || []); renderBlockedUsers(); groupRooms = data.groups || [];
    $('#identity-kind').textContent = me.account ? 'Persistent account' : 'Guest identity'; $('#account-security').hidden = !me.account; fillProfileForm();
    try { encryptionClient = await SilenzaCrypto.createClient(me.id, api); } catch(e) { encryptionError = e.message; }
    for (const person of data.conversations || []) conversations.set(person.id, person.alias);
    $('#my-alias').textContent = me.alias; $('.me-avatar').textContent = me.alias.split(' ').slice(0,2).map(x => x[0]).join(''); setAdmin(me.admin); renderPeople(); renderAdminPeople();
    if (me.admin) await refreshAdminState();
    await select(rooms[0] ? { room: rooms[0].id } : null);
    openInviteLink();
    connect();
    setInterval(checkConnection, 5000);
    // Phones pause background tabs and switch networks; check the stream as soon as the page is back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { checkConnection(); scheduleReadReceipt(); checkForUpdate(); } });
    setInterval(checkForUpdate, 15 * 60000);
    window.addEventListener('online', () => { if (stream) connect(); });
    setInterval(() => {
      let changed = false;
      messages = messages.map(message => {
        if (!message.file || !(message.attachment?.expiresAt <= Date.now()) || message.fileExpired) return message;
        revokeFile(message.id); changed = true; return { ...message, fileExpired: true };
      });
      if (changed) renderMessages();
    }, 10000);
  } catch(e) { error(e.message); $('#connection').textContent = 'Could not connect'; }
}
let soundSettings = { private: false, groups: false, rooms: false }, audioContext, lastSound = 0;
try { const saved = JSON.parse(localStorage.getItem('silenza-sounds')); for (const key of Object.keys(soundSettings)) soundSettings[key] = saved?.[key] === true; } catch {}
async function playSound() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) throw new Error('Audio notifications are unavailable in this browser.');
  audioContext ||= new Audio();
  await audioContext.resume();
  if (audioContext.state !== 'running') throw new Error('Use Test sound to enable audio in this tab.');
  const oscillator = audioContext.createOscillator(), volume = audioContext.createGain(), now = audioContext.currentTime;
  oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(660, now);
  volume.gain.setValueAtTime(0, now); volume.gain.linearRampToValueAtTime(0.08, now + 0.02); volume.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
  oscillator.connect(volume); volume.connect(audioContext.destination); oscillator.start(now); oscillator.stop(now + 0.25);
  oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };
}
const messageKind = message => message.group ? 'groups' : message.room ? 'rooms' : 'private';
function notifyMessage(message) {
  const kind = messageKind(message);
  if (message.sender === me.id || !soundSettings[kind] || Date.now() - lastSound < 800) return;
  lastSound = Date.now();
  playSound().catch(e => { $('#sound-status').textContent = e.message; });
}
$('#open-settings').onclick = () => { fillProfileForm(); $('#profile-status').textContent = ''; $('#signout-status').textContent = ''; showSettingsTab(settingsTab); $('#settings-dialog').showModal(); };
for (const key of Object.keys(soundSettings)) {
  const input = $(`#sound-${key}`); input.checked = soundSettings[key];
  input.onchange = () => {
    soundSettings[key] = input.checked;
    try { localStorage.setItem('silenza-sounds', JSON.stringify(soundSettings)); } catch { $('#sound-status').textContent = 'This browser could not save your sound preferences.'; }
    if (input.checked) playSound().catch(e => { $('#sound-status').textContent = e.message; });
  };
}
// Visual notifications are unread badges in the sidebar plus a count in the tab title. Main rooms are busy, so they start off.
let visualSettings = { private: true, groups: true, rooms: false };
const baseTitle = document.title;
try { const saved = JSON.parse(localStorage.getItem('silenza-visual')); for (const key of Object.keys(visualSettings)) if (typeof saved?.[key] === 'boolean') visualSettings[key] = saved[key]; } catch {}
const kindPrefix = { private: 'peer:', groups: 'group:', rooms: 'room:' };
function appendUnread(button, key) {
  const count = unread.get(key); if (!count) return;
  const badge = element('span', 'unread', count > 99 ? '99+' : count);
  badge.setAttribute('aria-label', `${count} unread ${count === 1 ? 'message' : 'messages'}`); button.append(badge);
}
function updateUnreadTitle() {
  let total = 0; for (const count of unread.values()) total += count;
  document.title = total ? `(${total > 99 ? '99+' : total}) ${baseTitle}` : baseTitle;
}
function countUnread(message) {
  const key = message.group ? `group:${message.group}` : message.room ? `room:${message.room}` : `peer:${message.sender}`;
  if (message.sender === me.id || !visualSettings[messageKind(message)] || key === conversationKey(current)) return;
  unread.set(key, (unread.get(key) || 0) + 1);
  if (message.room || message.group) renderRooms(); else renderDMs();
  updateUnreadTitle();
}
for (const key of Object.keys(visualSettings)) {
  const input = $(`#visual-${key}`); input.checked = visualSettings[key];
  input.onchange = () => {
    visualSettings[key] = input.checked;
    try { localStorage.setItem('silenza-visual', JSON.stringify(visualSettings)); } catch { $('#sound-status').textContent = 'This browser could not save your notification preferences.'; }
    if (!input.checked) for (const id of [...unread.keys()]) if (id.startsWith(kindPrefix[key])) unread.delete(id);
    renderRooms(); renderDMs(); updateUnreadTitle();
  };
}
// Privacy and media preferences, saved on this browser.
const privacySettings = { readReceipts: true }, mediaSettings = { clickToShow: false };
try { const saved = JSON.parse(localStorage.getItem('silenza-privacy')); if (typeof saved?.readReceipts === 'boolean') privacySettings.readReceipts = saved.readReceipts; } catch {}
try { const saved = JSON.parse(localStorage.getItem('silenza-media')); if (typeof saved?.clickToShow === 'boolean') mediaSettings.clickToShow = saved.clickToShow; } catch {}
$('#read-receipts').checked = privacySettings.readReceipts;
$('#read-receipts').onchange = () => {
  privacySettings.readReceipts = $('#read-receipts').checked;
  try { localStorage.setItem('silenza-privacy', JSON.stringify(privacySettings)); } catch { $('#sound-status').textContent = 'This browser could not save your privacy preferences.'; }
  scheduleReadReceipt();
};
$('#click-to-show').checked = mediaSettings.clickToShow;
$('#click-to-show').onchange = () => {
  mediaSettings.clickToShow = $('#click-to-show').checked;
  try { localStorage.setItem('silenza-media', JSON.stringify(mediaSettings)); } catch { $('#sound-status').textContent = 'This browser could not save your image preferences.'; }
};
$('#test-sound').onclick = () => playSound().then(() => { $('#sound-status').textContent = 'Sound is enabled in this tab.'; }).catch(e => { $('#sound-status').textContent = e.message; });
function clearSignedOutPage() {
  revision++; current = null; groupState = null;
  clearTimeout(reconnectTimer); stream?.close(); encryptionClient?.dispose(); encryptionClient = null; peerIdentity = null; verificationTarget = null;
  messages = []; drafts.clear(); unread.clear(); updateUnreadTitle(); clearPendingFile(); clearFileURLs(); setReply(null);
  editingMessage = null; $('#edit-message-text').value = ''; $('#edit-message-dialog').close();
  $('#message').value = ''; renderMessages(); updateComposerState();
}
window.addEventListener('silenza-signed-out', () => {
  if (signingOut) return;
  signingOut = true; clearSignedOutPage(); location.replace('/#entry');
});
function accountStatus(text) { $('#account-security-status').textContent = text; }
$('#password-form').onsubmit = async event => {
  event.preventDefault(); const button = $('#password-form button'); button.disabled = true; accountStatus('');
  try {
    await api('auth/password', { current: $('#current-password').value, password: $('#new-password').value });
    $('#password-form').reset(); accountStatus('Password changed. Other devices were signed out.');
  } catch (e) { accountStatus(e.message); } finally { button.disabled = false; }
};
$('#logout-all').onclick = async () => {
  $('#logout-all').disabled = true; accountStatus('');
  try { await api('auth/logout-all', {}); accountStatus('All other devices were signed out.'); }
  catch (e) { accountStatus(e.message); } finally { $('#logout-all').disabled = false; }
};
$('#delete-account-form').onsubmit = async event => {
  event.preventDefault(); const button = $('#delete-account-form button'); button.disabled = true; accountStatus('');
  signingOut = true;
  try {
    await api('auth/delete', { password: $('#delete-password').value });
    clearSignedOutPage(); await SilenzaCrypto.clearLocalKeys(); location.assign('/#entry');
  } catch (e) { signingOut = false; accountStatus(e.message); button.disabled = false; }
};
$('#account-signout').onclick = async () => {
  signingOut = true;
  try {
    await api('auth/logout', {}); clearSignedOutPage();
    await SilenzaCrypto.clearLocalKeys(); location.assign('/#entry');
  }
  catch (e) { signingOut = false; $('#signout-status').textContent = e.message; }
};
setupGroups();
start();
