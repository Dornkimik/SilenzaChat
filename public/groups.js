let groupRooms = [], groupState = null, groupPanel = null, groupRefresh = 0, muteTimer = 0;
let adminGroups = [], moderatingGroup = null;
const roleRank = { member: 0, moderator: 1, owner: 2 };
const groupDefaults = { limit: 20, slowMode: 0, lifetime: 24, disappear: 0, readOnly: false, locked: false, shareHistory: false };
const sharingGroups = new Set(), knownRequests = new Map();
// Re-encrypts shareable room history for members who joined later. Every online member may try;
// a random delay spreads the work, and the server skips copies someone else already shared.
async function shareGroupHistory(group) {
  if (!encryptionClient || sharingGroups.has(group)) return;
  sharingGroups.add(group);
  try {
    await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 1500));
    const work = await api(`groups/history-share-state?group=${encodeURIComponent(group)}`);
    if (!work.messages.length) return;
    const history = new Map((await api(`groups/history?group=${encodeURIComponent(group)}`)).map(m => [m.id, m]));
    const members = new Map(work.members.map(m => [m.id, m]));
    let batch = [];
    for (const item of work.messages) {
      const message = history.get(item.id); if (!message) continue;
      // A message that fails to decrypt or verify is skipped rather than passed on.
      try {
        const copies = await encryptionClient.shareGroup(message, item.members.map(id => members.get(id)).filter(Boolean));
        for (const [member, encrypted] of Object.entries(copies)) batch.push({ id: item.id, member, encrypted });
      } catch {}
      if (batch.length >= 15) { await api('groups/history-share', { group, shares: batch }); batch = []; }
    }
    if (batch.length) await api('groups/history-share', { group, shares: batch });
  } catch {} finally { sharingGroups.delete(group); }
}
const groupRole = (group, id) => group?.owner === id ? 'owner' : group?.moderators?.includes(id) ? 'moderator' : 'member';
const isGroupStaff = group => groupRole(group, me.id) !== 'member';
// Moderators manage regular members; the owner manages everyone else.
const canManage = (group, id) => id !== me.id && roleRank[groupRole(group, me.id)] > roleRank[groupRole(group, id)];
const accessLabel = group => group?.access === 'invite' ? 'Hidden' : 'Discoverable';
const shortTime = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// Why the current member cannot post in this room right now, if anything.
function groupPostBlock(group) {
  const self = group?.members?.find(m => m.id === me.id);
  if (self?.muted) return self.mutedUntil ? `You are muted in this room until ${shortTime(self.mutedUntil)}.` : 'You are muted in this room until a moderator unmutes you.';
  if (group?.readOnly && !isGroupStaff(group)) return 'Only the owner and moderators can post in this room right now.';
  return '';
}
// Mutes end on the server without an event, so recheck the composer when one expires.
function scheduleMuteCheck(group) {
  clearTimeout(muteTimer);
  const until = group?.members?.find(m => m.id === me.id)?.mutedUntil;
  if (until) muteTimer = setTimeout(() => {
    const self = groupState?.members?.find(m => m.id === me.id);
    if (self?.mutedUntil === until) { self.muted = false; self.mutedUntil = null; updateComposerState(); }
  }, Math.max(0, until - Date.now()) + 500);
}
function renderAdminGroups() {
  const list = $('#admin-groups');
  list.replaceChildren(...adminGroups.map(group => {
    const row = element('div', 'admin-room');
    const edit = element('button', 'text-button', 'Edit');
    const remove = element('button', 'delete-room', 'Remove');
    const actions = element('div', 'group-member-actions');
    actions.append(edit, remove);
    row.append(element('span', '', `${group.name} · ${accessLabel(group)} · ${group.count} members`), actions);
    edit.onclick = () => {
      moderatingGroup = group.id;
      for (const field of ['name', 'description', 'rules']) $(`#moderate-group-${field}`).value = group[field];
      $('#moderate-group-error').textContent = '';
      $('#moderate-group-dialog').showModal();
    };
    remove.onclick = () => {
      deleting = { id: group.id, group: true };
      $('#delete-description').textContent = `“${group.name}” and its message history will be removed for everyone. This cannot be undone.`;
      $('#delete-error').textContent = ''; $('#delete-dialog').showModal();
    };
    return row;
  }));
  if (!adminGroups.length) list.append(element('p', 'admin-empty', 'No user-created rooms.'));
  if (moderatingGroup && !adminGroups.some(g => g.id === moderatingGroup)) {
    $('#moderate-group-dialog').close(); moderatingGroup = null;
  }
}
function renderGroups() {
  $('#groups').replaceChildren(...groupRooms.map(group => {
    const button = element('button', `nav-room group-room${current?.group === group.id ? ' active' : ''}`);
    const count = group.joined ? (group.requests ? `${group.requests} waiting` : 'Joined') : group.invited ? 'Invited' : group.requested ? 'Requested' : group.locked ? 'Locked' : `${group.count}/${group.limit || 20}`;
    button.append(element('span', 'hash', group.access === 'invite' ? '◇' : '#'), element('span', 'name', group.name)); appendUnread(button, `group:${group.id}`); button.append(element('small', 'count', count));
    button.disabled = group.blocked;
    button.title = group.blocked ? 'You were banned from this room' : group.description;
    button.onclick = () => group.joined ? select({ group: group.id }) : openGroup(group);
    return button;
  }));
  $('#groups-empty').hidden = groupRooms.length > 0;
}
async function refreshGroups() {
  const request = ++groupRefresh;
  try {
    const list = await api('groups'); if (request !== groupRefresh) return;
    groupRooms = list; renderGroups(); refreshInviteCards();
    if (current?.group && !list.some(g => g.id === current.group && g.joined)) closeCurrentGroup('This room is no longer available to you.');
    if (groupPanel && !groupPanel.inviteToken && !list.some(g => g.id === groupPanel.id && !g.blocked)) { $('#group-dialog').close(); groupPanel = null; }
  } catch(e) { error(e.message); }
}
function closeCurrentGroup(reason) {
  const id = current?.group;
  if (id) { groupState = null; select(rooms[0] ? { room: rooms[0].id } : null); drafts.delete(`group:${id}`); error(reason); }
}
function groupStateChanged(state) {
  const index = groupRooms.findIndex(g => g.id === state.id);
  // Staff hear about new join requests wherever they are in the app.
  if (state.joinRequests) {
    const known = knownRequests.get(state.id), fresh = known ? state.joinRequests.filter(r => !known.has(r.id)) : [];
    knownRequests.set(state.id, new Set(state.joinRequests.map(r => r.id)));
    if (fresh.length) status(`${fresh.at(-1).alias} asked to join “${state.name}”. Open Room details & members to approve or decline.`);
  }
  if (index !== -1) groupRooms[index] = { ...groupRooms[index], ...state };
  if (current?.group === state.id && groupState && Boolean(groupState.shareHistory) !== Boolean(state.shareHistory)) {
    status(state.shareHistory ? 'History sharing is on: people who join later can read messages sent from now on.' : 'History sharing is off: new messages stay with the current members.');
  }
  if (current?.group === state.id) { groupState = state; updateHeading(); renderMessages(); }
  if (state.pendingHistory && state.joined) shareGroupHistory(state.id);
  if (groupPanel?.id === state.id) { groupPanel = state; renderGroupMembers(); groupPermissions(); }
  renderGroups();
}
function fillGroupForm(group) {
  $('#group-form').reset();
  for (const field of ['name', 'description', 'rules']) $(`#group-${field}`).value = group?.[field] || '';
  $('#group-access').value = group?.access || 'open';
  const values = { ...groupDefaults, ...Object.fromEntries(Object.keys(groupDefaults).filter(k => group?.[k] !== undefined).map(k => [k, group[k]])) };
  $('#group-limit').value = values.limit; $('#group-slow-mode').value = values.slowMode;
  $('#group-lifetime').value = values.lifetime; $('#group-disappear').value = values.disappear;
  $('#group-read-only').checked = values.readOnly; $('#group-locked').checked = values.locked; $('#group-share-history').checked = values.shareHistory;
}
async function openGroup(group = null) {
  $('#group-error').textContent = '';
  try {
    groupPanel = group?.joined ? await api(`groups/state?group=${encodeURIComponent(group.id)}`) : group;
    fillGroupForm(groupPanel);
    $('#group-dialog-title').textContent = groupPanel ? 'Room details & members' : 'Create a temporary room';
    groupPermissions(); renderGroupMembers(); if (!$('#group-dialog').open) $('#group-dialog').showModal();
  } catch(e) { error(e.message); }
}
function groupPermissions() {
  const owner = groupPanel?.owner === me.id, creating = !groupPanel, staff = Boolean(groupPanel?.joined) && isGroupStaff(groupPanel);
  for (const id of ['group-name', 'group-description', 'group-rules', 'group-limit']) $(`#${id}`).readOnly = !creating && !owner;
  for (const id of ['group-access', 'group-slow-mode', 'group-lifetime', 'group-disappear', 'group-read-only', 'group-locked', 'group-share-history']) $(`#${id}`).disabled = !creating && !owner;
  $('#group-save').hidden = !creating && !owner;
  $('#group-save').textContent = creating ? 'Create room' : 'Save changes';
  $('#group-join').hidden = creating || groupPanel.joined;
  $('#group-join').disabled = Boolean(groupPanel?.blocked) || !encryptionClient;
  $('#group-join').textContent = groupPanel?.inviteToken ? 'Join with invite link' : groupPanel?.invited ? 'Join encrypted room' : groupPanel?.requested ? 'Cancel join request' : 'Ask to join';
  $('#group-join').className = groupPanel?.requested ? 'text-button' : 'primary';
  $('#group-request-note').hidden = creating || groupPanel.joined || Boolean(groupPanel.inviteToken || groupPanel.invited);
  $('#group-request-note').textContent = groupPanel?.requested ? 'Your request is waiting for the owner or a moderator. You join automatically once it is approved.' : 'The owner or a moderator decides who joins. You join automatically once your request is approved.';
  $('#group-requests-section').hidden = !staff || !groupPanel.joinRequests?.length;
  $('#group-leave').hidden = !groupPanel?.joined;
  $('#group-leave').disabled = owner && groupPanel.count > 1;
  $('#group-delete').hidden = !owner;
  $('#group-owner-note').hidden = !owner || groupPanel.count < 2;
  $('#group-invite-form').hidden = !staff;
  $('#group-links-section').hidden = !staff;
  $('#group-banned-section').hidden = !staff || !groupPanel.banned?.length;
  $('#group-member-section').hidden = !groupPanel?.joined;
  const candidates = people.filter(p => !groupPanel?.members?.some(m => m.id === p.id) && !groupPanel?.banned?.some(b => b.id === p.id));
  $('#group-invite-person').replaceChildren(...candidates.map(p => {
    const option = element('option', '', p.alias); option.value = p.id; return option;
  }));
  $('#group-invite-submit').disabled = !candidates.length;
}
function actionButton(label, className, onclick) {
  const button = element('button', className, label); button.type = 'button'; button.onclick = onclick; return button;
}
function renderGroupMembers() {
  const staff = Boolean(groupPanel?.joined) && isGroupStaff(groupPanel), owner = groupPanel?.owner === me.id;
  $('#group-members').replaceChildren(...(groupPanel?.members || []).map(person => {
    const row = element('div', 'group-member'), info = element('div', 'group-member-info');
    const role = groupRole(groupPanel, person.id);
    const muted = person.muted ? person.mutedUntil ? ` · Muted until ${shortTime(person.mutedUntil)}` : ' · Muted' : '';
    info.append(username(person.alias, '', person.displayAsAdmin));
    info.append(element('small', '', `${profileText(person) ? `${profileText(person)} · ` : ''}${role === 'owner' ? 'Owner · ' : role === 'moderator' ? 'Moderator · ' : ''}${person.online ? 'Online' : 'Offline'}${muted}${staff ? ` · ${person.messages} ${person.messages === 1 ? 'message' : 'messages'} sent` : ''}`));
    row.append(info);
    if (person.id !== me.id) {
      const actions = element('div', 'group-member-actions');
      actions.append(actionButton('Verify identity', 'text-button', () => showVerification(person.id)));
      if (owner) {
        actions.append(actionButton(role === 'moderator' ? 'Remove moderator' : 'Make moderator', 'text-button', () => groupAction(role === 'moderator' ? 'demote' : 'promote', { member: person.id })));
        actions.append(actionButton('Make owner', 'text-button', () => {
          if (confirm(`Make ${person.alias} the owner? You will give up room management controls.`)) groupAction('transfer', { member: person.id });
        }));
      }
      if (canManage(groupPanel, person.id)) {
        if (person.muted) actions.append(actionButton('Unmute', 'text-button', () => groupAction('unmute', { member: person.id })));
        else {
          const mute = element('select');
          mute.setAttribute('aria-label', `Mute ${person.alias}`);
          for (const [value, label] of [['', 'Mute…'], ['5', '5 minutes'], ['60', '1 hour'], ['1440', '24 hours'], ['0', 'Until unmuted']]) {
            const option = element('option', '', label); option.value = value; mute.append(option);
          }
          mute.onchange = () => { if (mute.value !== '') groupAction('mute', { member: person.id, minutes: Number(mute.value) }); };
          actions.append(mute);
        }
        actions.append(actionButton('Kick', 'danger-small', () => {
          if (confirm(`Remove ${person.alias}? They can come back with an invite, an invite link or an approved request.`)) groupAction('kick', { member: person.id });
        }));
        actions.append(actionButton('Ban', 'danger-small', () => {
          if (confirm(`Ban ${person.alias}? They will lose access and cannot rejoin with this session until they are unbanned.`)) groupAction('ban', { member: person.id });
        }));
      }
      row.append(actions);
    }
    return row;
  }));
  renderGroupLinks(); renderGroupBans(); renderJoinRequests();
}
function renderJoinRequests() {
  $('#group-requests').replaceChildren(...(groupPanel?.joinRequests || []).map(person => {
    const row = element('div', 'group-member'), info = element('div', 'group-member-info'), actions = element('div', 'group-member-actions');
    info.append(username(person.alias, '', person.displayAsAdmin), element('small', '', [profileText(person), `Asked at ${shortTime(person.at)}`].filter(Boolean).join(' · ')));
    actions.append(actionButton('Approve', 'text-button', () => groupAction('approve', { member: person.id })),
      actionButton('Decline', 'danger-small', () => groupAction('decline', { member: person.id })));
    row.append(info, actions); return row;
  }));
}
function inviteURL(token) { return `${location.origin}/chat/#invite=${groupPanel.id}.${token}`; }
function renderGroupLinks() {
  $('#group-links').replaceChildren(...(groupPanel?.links || []).map(link => {
    const row = element('div', 'group-link'), input = element('input');
    input.readOnly = true; input.value = inviteURL(link.token); input.setAttribute('aria-label', 'Invite link');
    input.onfocus = () => input.select();
    const copy = actionButton('Copy', 'text-button', async () => {
      try { await navigator.clipboard.writeText(input.value); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); }
      catch { input.focus(); input.select(); }
    });
    row.append(input, copy, actionButton('Revoke', 'danger-small', () => groupAction('link-revoke', { token: link.token })),
      element('small', '', `Expires at ${shortTime(link.expiresAt)} · ${link.maxUses ? `${link.uses}/${link.maxUses} uses` : `${link.uses} ${link.uses === 1 ? 'use' : 'uses'}`}`));
    return row;
  }));
  if (groupPanel?.links && !groupPanel.links.length) $('#group-links').append(element('p', 'group-hint', 'No active invite links.'));
}
function renderGroupBans() {
  $('#group-banned').replaceChildren(...(groupPanel?.banned || []).map(person => {
    const row = element('div', 'group-member'), info = element('div', 'group-member-info');
    info.append(element('span', '', person.alias), element('small', '', `Banned at ${shortTime(person.at)}`));
    const actions = element('div', 'group-member-actions');
    actions.append(actionButton('Unban', 'text-button', () => groupAction('unban', { member: person.id })));
    row.append(info, actions); return row;
  }));
}
async function groupAction(action, extra = {}) {
  const id = groupPanel?.id; if (!id) return;
  $('#group-error').textContent = '';
  try {
    if (action === 'join' && groupPanel.inviteToken) extra = { ...extra, invite: groupPanel.inviteToken };
    // Without an invitation or link, the join button asks to join (or withdraws the request).
    else if (action === 'join' && !groupPanel.invited) action = groupPanel.requested ? 'request-cancel' : 'request';
    const result = await api(`groups/${action}`, { group: id, ...extra });
    if (action === 'join') { $('#group-dialog').close(); groupPanel = null; await refreshGroups(); await select({ group: id }); }
    else if (action === 'delete' || action === 'leave') { $('#group-dialog').close(); await refreshGroups(); }
    else if (action === 'request' || action === 'request-cancel') { groupPanel = { ...groupPanel, ...result }; groupPermissions(); refreshGroups(); }
    else if (result.id) groupStateChanged(result);
    else if (action === 'invite') $('#group-error').textContent = 'Invitation sent. The room now appears in their temporary rooms list.';
  } catch(e) { $('#group-error').textContent = e.message; renderGroupMembers(); }
}
// Invite links carry the room and token in the URL fragment, which is never sent to the server by the browser.
async function openInviteLink() {
  let hash = location.hash;
  if (hash.startsWith('#invite=')) history.replaceState(null, '', location.pathname + location.search);
  else { try { hash = sessionStorage.getItem('silenza-invite') || ''; } catch { hash = ''; } }
  try { sessionStorage.removeItem('silenza-invite'); } catch {}
  const match = hash.match(/^#invite=([0-9a-f-]{36})\.([A-Za-z0-9_-]{10,64})$/);
  if (match) await openInvite(match[1], match[2]);
}
async function openInvite(group, token) {
  try {
    const preview = await invitePreview(group, token, true);
    if (preview.joined) await select({ group: preview.id });
    else await openGroup({ ...preview, inviteToken: token });
  } catch(e) { error(e.message); }
}
// Room invite links posted in chats become cards with a button, so nobody has to copy them into the address bar.
const invitePattern = () => new RegExp(`${location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/chat/#invite=([0-9a-f-]{36})\\.([A-Za-z0-9_-]{10,64})(?![A-Za-z0-9_-])`, 'g');
const invitePreviews = new Map();
function invitePreview(group, token, refresh = false) {
  const key = `${group}.${token}`;
  if (refresh || !invitePreviews.has(key)) {
    const request = api(`groups/invite-preview?${new URLSearchParams({ group, invite: token })}`);
    invitePreviews.set(key, request);
    // The cache only spares re-renders; room changes refresh the visible cards.
    request.catch(() => {}).finally(() => setTimeout(() => { if (invitePreviews.get(key) === request) invitePreviews.delete(key); }, 10000));
  }
  return invitePreviews.get(key);
}
function refreshInviteCards() {
  invitePreviews.clear();
  for (const card of document.querySelectorAll('.invite-card')) {
    const { group, token } = card.dataset;
    invitePreview(group, token).then(preview => fillInviteCard(card, preview), e => fillInviteCard(card, null, e.message));
  }
}
function fillInviteCard(card, preview, problem) {
  const [title, detail, button] = card.children;
  title.textContent = preview?.name || 'Temporary room invite';
  detail.textContent = problem || [`${accessLabel(preview)} room`, `${preview.count}/${preview.limit} members`, preview.locked && 'Locked'].filter(Boolean).join(' · ');
  button.disabled = Boolean(problem);
  button.textContent = problem ? 'Unavailable' : preview.joined ? 'Open room' : 'View & join';
}
function renderInviteCards(message, container) {
  const seen = new Set();
  for (const [, group, token] of message.text.matchAll(invitePattern())) {
    const key = `${group}.${token}`;
    if (seen.has(key) || seen.size >= 3) continue;
    seen.add(key);
    const card = element('div', 'invite-card'), button = element('button', 'text-button', 'Loading…');
    Object.assign(card.dataset, { group, token });
    card.append(element('strong', '', 'Temporary room invite'), element('small', '', 'Checking the invite…'), button);
    button.type = 'button'; button.disabled = true;
    button.onclick = async () => {
      button.disabled = true; await openInvite(group, token);
      invitePreview(group, token).then(preview => fillInviteCard(card, preview), e => fillInviteCard(card, null, e.message));
    };
    invitePreview(group, token).then(preview => fillInviteCard(card, preview), e => fillInviteCard(card, null, e.message));
    container.append(card);
  }
}
function setupGroups() {
  $('#moderate-group-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    const details = Object.fromEntries(['name', 'description', 'rules'].map(field => [field, $(`#moderate-group-${field}`).value]));
    try {
      await api('admin/groups/update', { group: moderatingGroup, ...details });
      $('#moderate-group-dialog').close(); await refreshAdminState();
    } catch(e) { $('#moderate-group-error').textContent = e.message; }
    finally { button.disabled = false; }
  };
  $('#create-group').onclick = () => openGroup();
  $('#group-details').onclick = () => openGroup(groupState);
  $('#group-form').onsubmit = async event => {
    event.preventDefault(); const button = $('#group-save'); button.disabled = true;
    const details = { name: $('#group-name').value, description: $('#group-description').value, rules: $('#group-rules').value, access: $('#group-access').value,
      limit: Number($('#group-limit').value), slowMode: Number($('#group-slow-mode').value), lifetime: Number($('#group-lifetime').value),
      disappear: Number($('#group-disappear').value), readOnly: $('#group-read-only').checked, locked: $('#group-locked').checked, shareHistory: $('#group-share-history').checked };
    try {
      if (groupPanel) await groupAction('update', details);
      else {
        const created = await api('groups/create', details);
        $('#group-dialog').close(); await refreshGroups(); await select({ group: created.id });
      }
    } catch(e) { $('#group-error').textContent = e.message; }
    finally { button.disabled = false; }
  };
  $('#group-join').onclick = () => groupAction('join');
  $('#group-leave').onclick = () => groupAction('leave');
  $('#group-delete').onclick = () => { if (confirm('Delete this temporary room and all its messages for everyone?')) groupAction('delete'); };
  $('#group-invite-form').onsubmit = event => { event.preventDefault(); groupAction('invite', { member: $('#group-invite-person').value }); };
  $('#group-link-form').onsubmit = event => { event.preventDefault(); groupAction('link-create', { hours: Number($('#group-link-hours').value), uses: Number($('#group-link-uses').value) }); };
  window.addEventListener('hashchange', () => { if (location.hash.startsWith('#invite=')) openInviteLink(); });
}
