const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const claudeApp = require('./claude');
const { watchClaudeLinks } = require('./intercept');
const history = require('./history');
const { ProfileStore, COLORS } = require('./profiles');

const ARM_DURATION_MS = 5 * 60 * 1000;

// Separate data folder (and so a separate instance), for development and testing.
if (process.env.BUNSHIN_USER_DATA) app.setPath('userData', process.env.BUNSHIN_USER_DATA);

// Bunshin is itself single-instance: a second launch (e.g. Windows handing us a
// claude:// link) is forwarded to the running window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let store = null;
let claude = null;          // { exe, version, kind } or null if not installed
let armed = null;           // { id, until }: where the next claude:// link goes
let pendingLinks = [];      // links waiting for the user to pick a profile
let lastStatus = '';

// --- claude:// routing --------------------------------------------------------

// The portable .exe unpacks itself into a temp folder on every run, so
// process.execPath is short-lived: register the portable file itself.
const handlerExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const handlerCommand = () =>
  [handlerExe, ...(process.defaultApp ? [app.getAppPath()] : [])].map((a) => `"${a}"`).join(' ') + ' "%1"';
const linkFrom = (argv) => argv.find((a) => /^claude:\/\//i.test(a));

// Cached registry state:
//   linkHandler: Bunshin is registered as a claude:// handler (the toggle)
//   linkChosen:  Windows actually sends claude:// to it. Under the Store build
//                that takes the user picking Bunshin in Settings > Default apps.
let linkHandler = false;
let linkChosen = false;
async function refreshLinkHandler() {
  const cmd = await claudeApp.readProtocolCommand();
  linkHandler = !!cmd && cmd.toLowerCase() === handlerCommand().toLowerCase();
  linkChosen = linkHandler && (claude?.kind !== 'msix' || (await claudeApp.isChosenLinkApp()));
  return linkHandler;
}

// When Windows still sends claude:// to the Store package (Bunshin not picked
// in Settings), the link is intercepted while a profile is armed.
let watcher = null;
const needsIntercept = (profile) => claude?.kind === 'msix' && !linkChosen && !profile.isDefault;

function startIntercept() {
  if (watcher) return;
  watcher = watchClaudeLinks(claude.exe, {
    onLink: (url) => {
      log(`link intercepted ${redact(url)}`);
      handleLink(url);
    },
    onExit: (code, err) => {
      watcher = null;
      if (armed) log(`link watcher stopped (code ${code}) ${err}`);
    },
  });
}

function disarm() {
  armed = null;
  watcher?.stop();
  watcher = null;
}

// Routing journal, so a login that "went nowhere" can be traced afterwards.
function log(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'bunshin.log'), `${new Date().toISOString()}  ${msg}\n`);
  } catch {}
}

// Sign-in links carry one-time codes: keep only the route in the log.
const redact = (url) => url.replace(/[?#].*$/, '?…');

// Every launch goes through here: a closed profile first gets its Claude Code
// session folders linked to the shared history.
function startProfile(profile, extraArgs = []) {
  if (profile.shareHistory !== false && profile.configDir && !claudeApp.isRunning(claude, profile)) {
    try {
      const backups = history.shareHistory(profile.configDir);
      if (backups.length) log(`history shared for ${profile.name} (originals kept: ${backups.join(', ')})`);
    } catch (err) {
      log(`could not share history for ${profile.name}: ${err.message}`);
      send('toast', `History not shared for “${profile.name}”: ${err.message}`);
    }
  }
  claudeApp.launch(claude, profile, extraArgs);
}

function routeLink(url, profileId) {
  const profile = store.get(profileId);
  startProfile(profile, [url]);
  pendingLinks = pendingLinks.filter((u) => u !== url);
  log(`link ${redact(url)} -> ${profile.name}`);
  return profile;
}

// Browser sign-in comes back through a claude:// link. With several profiles,
// Windows can't know which instance started the login, so Bunshin takes the
// link and delivers it: to the armed profile if any, otherwise it asks.
function handleLink(url) {
  if (!url) return;
  if (armed && armed.until > Date.now() && store.profiles.some((p) => p.id === armed.id)) {
    const profile = routeLink(url, armed.id);
    disarm();
    send('toast', `Sign-in sent to “${profile.name}”`);
    pushState();
    return;
  }
  log(`link ${redact(url)} received, no profile armed: asking`);
  if (!pendingLinks.includes(url)) pendingLinks.push(url);
  showWindow();
  pushState();
}

// --- window / state -----------------------------------------------------------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function state() {
  if (armed && armed.until <= Date.now()) {
    log('sign-in wait expired');
    disarm();
  }
  return {
    claude,
    colors: COLORS,
    linkHandler,
    linkChosen,
    armed,
    pendingLinks,
    profiles: store.profiles.map((p) => ({
      ...p,
      running: claudeApp.isRunning(claude, p),
      signedIn: claudeApp.isSignedIn(claude, p),
      historyShared: history.isShared(p.configDir),
    })),
  };
}

function pushState() {
  const s = state();
  lastStatus = JSON.stringify(s);
  send('state', s);
}

// Poll the profile lockfiles so the UI follows instances opened/closed outside Bunshin.
function watchStatus() {
  setInterval(() => {
    const s = state();
    const json = JSON.stringify(s);
    if (json !== lastStatus) {
      lastStatus = json;
      send('state', s);
    }
  }, 1500);
}

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: '#1a1917',
    autoHideMenuBar: true,
    title: 'Bunshin',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// --- IPC ----------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      const result = await fn(...args);
      pushState();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('state:get', () => state());

  handle('profile:create', (data) => store.create(data));
  handle('profile:update', (id, data) => store.update(id, data));
  handle('profile:remove', (id) => {
    if (armed?.id === id) disarm();
    store.remove(id);
  });
  handle('profile:move', (id, delta) => store.move(id, delta));

  handle('profile:launch', (id) => startProfile(store.get(id)));
  handle('profile:stop', (id) => claudeApp.stop(claude, store.get(id)));
  handle('profile:launchAll', () => {
    for (const p of store.profiles) {
      if (!claudeApp.isRunning(claude, p)) startProfile(p);
    }
  });
  handle('profile:openFolder', (id) => shell.openPath(claudeApp.liveDataDir(claude, store.get(id))));

  // "Se connecter": open the profile and send the next sign-in link to it.
  handle('profile:arm', async (id, { closeDefault = false } = {}) => {
    await refreshLinkHandler();
    const p = store.get(id);
    if (needsIntercept(p)) {
      // A running default profile would grab the link through Electron's
      // single-instance hand-off before the watcher can stop it.
      const def = { isDefault: true, dataDir: claudeApp.DEFAULT_DATA_DIR };
      if (claudeApp.isRunning(claude, def)) {
        const name = store.profiles.find((x) => x.isDefault)?.name ?? 'stock';
        if (!closeDefault) return { needsCloseDefault: true, name };
        await claudeApp.stop(claude, def);
        log(`profile ${name} closed for ${p.name}'s sign-in`);
      }
      startIntercept();
    } else if (!p.isDefault && !linkChosen) {
      throw new Error('Turn on link routing first (bottom of the window).');
    }
    armed = { id, until: Date.now() + ARM_DURATION_MS };
    log(`armed: ${p.name}${watcher ? ' (intercepting)' : ''}`);
    startProfile(p);
    return { armed: true };
  });
  handle('profile:disarm', () => disarm());

  handle('link:route', (url, id) => routeLink(url, id));
  handle('link:dismiss', (url) => { pendingLinks = pendingLinks.filter((u) => u !== url); });

  handle('linkHandler:set', async (enabled) => {
    if (enabled) {
      await claudeApp.registerAsLinkApp(handlerCommand(), handlerExe);
    } else {
      await claudeApp.restoreProtocolToClaude(claude);
    }
    const on = await refreshLinkHandler();
    log(`link routing ${enabled ? 'on' : 'off'} (registered: ${on}, chosen in Windows: ${linkChosen})`);
    if (on !== enabled) throw new Error('Windows did not accept the claude:// handler change.');
  });
}

// --- boot ---------------------------------------------------------------------

app.on('second-instance', (_e, argv) => {
  const url = linkFrom(argv);
  if (url) handleLink(url);
  else showWindow();
});

app.whenReady().then(async () => {
  store = new ProfileStore(path.join(app.getPath('userData'), 'profiles.json'));
  claude = await claudeApp.findClaudeExe();
  await refreshLinkHandler();
  // Keep the app registration complete and current (older builds wrote less).
  if (linkHandler) await claudeApp.registerAsLinkApp(handlerCommand(), handlerExe).then(refreshLinkHandler, () => {});
  log(`start (link routing: ${linkHandler}, chosen in Windows: ${linkChosen})`);
  registerIpc();
  createWindow();
  watchStatus();
  // The registration can be changed from outside (e.g. a Claude reinstall).
  setInterval(refreshLinkHandler, 4000);
  handleLink(linkFrom(process.argv));
});

app.on('window-all-closed', () => {
  disarm();
  app.quit();
});
