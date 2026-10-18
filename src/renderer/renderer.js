const api = window.bunshin;
const $ = (sel) => document.querySelector(sel);

let state = null;
let openMenu = null;     // profile id whose overflow menu is open
let busy = new Set();    // profile ids with an action in flight

// Tiny element builder. Styles go through CSSOM (the CSP forbids inline style attributes).
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// --- feedback -----------------------------------------------------------------

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 5000 : 2600);
}

async function act(fn, { id, ok } = {}) {
  if (id) { busy.add(id); render(); }
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (id) { busy.delete(id); render(); }
  }
}

function confirmBox(title, text, okLabel = 'Confirm') {
  const d = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

// --- rendering ----------------------------------------------------------------

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function renderCard(p, index, total) {
  const isArmed = state.armed?.id === p.id;
  const isBusy = busy.has(p.id);
  const noClaude = !state.claude;

  const menu = openMenu === p.id && h('div', { class: 'menu', onclick: (e) => e.stopPropagation() },
    h('button', { onclick: () => { openMenu = null; editProfile(p); } }, 'Edit…'),
    isArmed
      ? h('button', { onclick: () => { openMenu = null; act(() => api.disarm()); } }, 'Cancel sign-in wait')
      : h('button', {
        disabled: noClaude,
        title: 'Opens this profile and sends it the next browser sign-in link',
        onclick: () => { openMenu = null; signIn(p); },
      }, 'Sign in to an account…'),
    h('button', { onclick: () => { openMenu = null; act(() => api.openFolder(p.id)); } }, 'Open data folder'),
    h('hr'),
    h('button', { disabled: index === 0, onclick: () => { openMenu = null; act(() => api.moveProfile(p.id, -1)); } }, 'Move up'),
    h('button', { disabled: index === total - 1, onclick: () => { openMenu = null; act(() => api.moveProfile(p.id, 1)); } }, 'Move down'),
    h('hr'),
    h('button', { class: 'danger-text', onclick: () => { openMenu = null; removeProfile(p); } }, 'Remove from list…'),
  );

  return h('article', { class: `card${p.running ? ' running' : ''}`, vars: { '--c': p.color } },
    h('div', { class: 'card-head' },
      h('div', { class: 'avatar' }, initials(p.name)),
      h('div', { class: 'card-title' },
        h('strong', { title: p.name }, p.name),
        h('span', { class: 'status' }, `${p.running ? 'Running' : 'Stopped'}${p.signedIn ? '' : ' · Not signed in'}`),
      ),
      h('button', {
        class: 'icon ghost',
        title: 'More actions',
        onclick: (e) => { e.stopPropagation(); openMenu = openMenu === p.id ? null : p.id; render(); },
      }, '⋯'),
    ),
    h('div', { class: 'tags' },
      p.isDefault && h('span', { class: 'tag', title: p.dataDir }, 'Stock profile'),
      !p.isDefault && h('span', { class: 'tag', title: p.dataDir }, p.dataDir.split('\\').pop()),
      p.configDir && h('span', { class: 'tag', title: p.configDir }, 'Own Claude Code config'),
      p.configDir && p.shareHistory !== false && h('span', {
        class: 'tag',
        title: 'Claude Code sessions shared by all profiles (~/.claude)',
      }, p.historyShared ? 'Shared history' : 'History shared on next launch'),
      isArmed && h('span', { class: 'tag armed', title: 'The next sign-in link goes to this profile' }, 'Waiting for sign-in'),
    ),
    h('div', { class: 'card-actions' },
      !p.signedIn && !isArmed
        ? h('button', {
          class: 'grow primary',
          disabled: isBusy || noClaude,
          title: 'Opens this profile; the browser sign-in callback (Google, e-mail link…) is sent to it',
          onclick: () => signIn(p),
        }, 'Sign in')
        : h('button', {
          class: `grow ${p.running ? '' : 'primary'}`,
          disabled: isBusy || noClaude,
          onclick: () => act(() => api.launch(p.id), { id: p.id }),
        }, p.running ? 'Show' : 'Launch'),
      p.running && h('button', {
        disabled: isBusy,
        onclick: () => stopProfile(p),
      }, isBusy ? 'Stopping…' : 'Stop'),
    ),
    menu,
  );
}

function render() {
  if (!state) return;
  const grid = $('#grid');
  grid.replaceChildren(
    ...(state.profiles.length
      ? state.profiles.map((p, i) => renderCard(p, i, state.profiles.length))
      : [h('div', { class: 'empty' }, 'No profiles yet. Create one to launch a Claude instance.')]),
  );

  const c = state.claude;
  $('#claudeInfo').textContent = c
    ? `Claude Desktop ${c.version ?? ''} (${c.kind === 'msix' ? 'Microsoft Store' : 'installer'})`
    : 'Claude Desktop not found';
  $('#launchAll').disabled = !c || state.profiles.every((p) => p.running);
  $('#linkHandler').checked = state.linkHandler;

  const banner = $('#banner');
  banner.classList.toggle('hidden', !!c);
  banner.textContent = c ? '' : 'Claude Desktop is not installed (or could not be found). Install it from claude.ai/download, then restart Bunshin.';

  renderLinkDialog();
}

function renderLinkDialog() {
  const d = $('#linkDialog');
  const url = state.pendingLinks[0];
  if (!url) { if (d.open) d.close(); return; }
  $('#linkUrl').textContent = url;
  $('#linkTargets').replaceChildren(...state.profiles.map((p) =>
    h('button', {
      vars: { '--c': p.color },
      onclick: () => act(() => api.routeLink(url, p.id), { ok: `Link sent to “${p.name}”` }),
    },
    h('span', { class: 'dot' }), p.name, h('small', {}, p.running ? 'running' : 'will be launched'))));
  $('#linkDismiss').onclick = () => act(() => api.dismissLink(url));
  if (!d.open) d.showModal();
}

// --- actions ------------------------------------------------------------------

async function signIn(p) {
  const ok = `Sign in from the “${p.name}” window: the browser callback will be sent to it (5 min)`;
  await act(async () => {
    const res = await api.arm(p.id);
    if (!res?.needsCloseDefault) return toast(ok);
    const close = await confirmBox(
      `Close “${res.name}”?`,
      `The “${res.name}” profile is open: Windows would hand it the sign-in meant for “${p.name}”. It has to stay closed while you sign in (you can relaunch it afterwards).`,
      'Close and continue',
    );
    if (!close) return;
    await api.arm(p.id, { closeDefault: true });
    toast(ok);
  }, { id: p.id });
}

async function stopProfile(p) {
  const ok = await confirmBox(
    `Stop “${p.name}”?`,
    'This profile’s Claude window will be closed, along with any Claude Code sessions running in it.',
    'Stop',
  );
  if (ok) act(() => api.stop(p.id), { id: p.id });
}

async function removeProfile(p) {
  const ok = await confirmBox(
    `Remove “${p.name}”?`,
    `The profile disappears from Bunshin, but its data stays on disk (${p.dataDir}): create a profile with the same name to get it back.`,
    'Remove',
  );
  if (ok) act(() => api.removeProfile(p.id));
}

let editing = null;   // profile being edited, or null when creating
let pickedColor = null;

function editProfile(p = null) {
  editing = p;
  pickedColor = p ? p.color : state.colors[state.profiles.length % state.colors.length];
  $('#editTitle').textContent = p ? 'Edit profile' : 'New profile';
  $('#editSubmit').textContent = p ? 'Save' : 'Create';
  $('#editName').value = p ? p.name : '';
  $('#editIsolate').checked = p ? !!p.configDir : true;
  $('#editIsolateRow').classList.toggle('hidden', !!p?.isDefault);
  $('#editShare').checked = p ? p.shareHistory !== false : true;
  syncShareRow();
  $('#editPaths').textContent = p ? `Data: ${p.dataDir}${p.configDir ? `\nConfig: ${p.configDir}` : ''}` : '';
  $('#editError').textContent = '';
  renderSwatches();
  $('#editDialog').showModal();
  $('#editName').focus();
}

// History sharing only means something for a profile with its own config dir.
function syncShareRow() {
  $('#editShareRow').classList.toggle('hidden', !!editing?.isDefault || !$('#editIsolate').checked);
}
$('#editIsolate').addEventListener('change', syncShareRow);

function renderSwatches() {
  $('#editColors').replaceChildren(...state.colors.map((c) =>
    h('button', {
      type: 'button',
      class: `swatch${c === pickedColor ? ' selected' : ''}`,
      vars: { '--c': c },
      onclick: () => { pickedColor = c; renderSwatches(); },
    })));
}

$('#editForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const data = {
    name: $('#editName').value,
    color: pickedColor,
    isolateConfig: $('#editIsolate').checked,
    shareHistory: $('#editShare').checked,
  };
  try {
    if (editing) await api.updateProfile(editing.id, data);
    else await api.createProfile(data);
    $('#editDialog').close();
    toast(editing ? 'Profile saved' : 'Profile created');
  } catch (err) {
    $('#editError').textContent = err.message;
  }
});

// Escape on the link chooser = "Ignore" (otherwise the next state push reopens it).
$('#linkDialog').addEventListener('cancel', (e) => { e.preventDefault(); $('#linkDismiss').click(); });

$('#newProfile').addEventListener('click', () => editProfile());
$('#launchAll').addEventListener('click', () => act(() => api.launchAll(), { ok: 'Launching profiles…' }));

$('#linkHandler').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  e.target.checked = !enabled; // the state push decides the real value
  if (!enabled) return act(() => api.setLinkHandler(false), { ok: 'claude:// links go straight to Claude again' });
  const ok = await confirmBox(
    'Turn on link routing?',
    'Registers Bunshin as a Windows handler for claude:// links. It only takes effect once you also pick Bunshin for CLAUDE links in Settings > Default apps. Optional: signing a profile in works without it, through “Sign in”. You can turn it off at any time.',
    'Turn on',
  );
  if (ok) act(() => api.setLinkHandler(true), { ok: 'Link routing turned on' });
});

document.addEventListener('click', () => { if (openMenu) { openMenu = null; render(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { openMenu = null; render(); } });

api.onState((s) => { state = s; render(); });
api.onToast((msg) => toast(msg));
api.getState().then((s) => { state = s; render(); });
