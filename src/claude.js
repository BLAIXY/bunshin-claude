// Everything that touches the installed Claude Desktop app: locating the exe,
// launching an isolated instance, detecting / stopping running instances, and
// the claude:// protocol registration.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DEFAULT_DATA_DIR = path.join(APPDATA, 'Claude');
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\claude';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve(stdout);
    });
  });
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function isUnder(child, parent) {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// --- Locating Claude.exe ------------------------------------------------------

// The MSIX install path contains the version number, so it changes on every
// update: always resolve it through Get-AppxPackage instead of caching a path.
async function findClaudeExe() {
  try {
    const out = await powershell(
      "$p = Get-AppxPackage -Name 'Claude' | Sort-Object Version -Descending | Select-Object -First 1;" +
      "if ($p) { [pscustomobject]@{ dir = $p.InstallLocation; version = $p.Version.ToString(); family = $p.PackageFamilyName } | ConvertTo-Json -Compress }"
    );
    if (out.trim()) {
      const { dir, version, family } = JSON.parse(out);
      const exe = path.join(dir, 'app', 'Claude.exe');
      if (fs.existsSync(exe)) return { exe, version, kind: 'msix', family };
    }
  } catch { /* fall through */ }

  // Older Squirrel-based installer.
  const squirrel = path.join(LOCALAPPDATA, 'AnthropicClaude', 'claude.exe');
  if (fs.existsSync(squirrel)) return { exe: squirrel, version: null, kind: 'squirrel', family: null };

  return null;
}

// --- MSIX data folders ----------------------------------------------------------
//
// Under the Store (MSIX) build, writes to %APPDATA%\<name> are redirected to the
// package's private copy, %LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming\<name>.
//
// On top of that, Claude has a "user data move": unless that private copy holds
// a `.user-data-back.<family>` marker, Claude ignores --user-data-dir and switches
// to the single shared %LOCALAPPDATA%\Claude-Data\<family> folder as soon as it
// exists. Every profile then lands in the same folder, so they share one login
// and one single-instance lock (the second "instance" just focuses the first).
// The marker is Claude's own "this profile stays where it is" record, so we
// write it before launching a profile.

function packageCopyOf(claude, dataDir) {
  if (!claude?.family || !isUnder(dataDir, APPDATA)) return null;
  return path.join(LOCALAPPDATA, 'Packages', claude.family, 'LocalCache', 'Roaming', path.relative(APPDATA, dataDir));
}

function sharedMoveDir(claude) {
  return claude?.family ? path.join(LOCALAPPDATA, 'Claude-Data', claude.family.toLowerCase()) : null;
}

function pinToOwnFolder(claude, profile) {
  if (profile.isDefault) return; // the stock profile is Claude's to manage
  const copy = packageCopyOf(claude, profile.dataDir);
  if (!copy) return;
  fs.mkdirSync(copy, { recursive: true });
  const marker = path.join(copy, `.user-data-back.${claude.family.toLowerCase()}`);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
}

// Every folder where this profile's live data (and its lockfile) can be.
function dataDirsOf(claude, profile) {
  const dirs = [profile.dataDir, packageCopyOf(claude, profile.dataDir)];
  if (profile.isDefault) dirs.push(sharedMoveDir(claude));
  return dirs.filter(Boolean);
}

// Folder to show the user: wherever the data actually is.
function liveDataDir(claude, profile) {
  const dirs = dataDirsOf(claude, profile);
  return dirs.find((d) => fs.existsSync(path.join(d, 'Local State'))) || profile.dataDir;
}

// --- Launching ----------------------------------------------------------------

function cleanEnv(profile) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    // Don't leak our own Electron runtime flags, or a parent Claude Code
    // session's markers, into the launched app.
    if (k.startsWith('ELECTRON_') || k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  }
  delete env.CLAUDE_CONFIG_DIR;
  if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
  return env;
}

// A distinct --user-data-dir gives Electron a distinct single-instance lock, so
// each profile runs as its own app with its own login. Launching a profile that
// is already running just hands the args to it (it focuses its window / opens
// the deep link).
function launch(claude, profile, extraArgs = []) {
  if (!claude) throw new Error('Claude Desktop was not found on this PC.');
  fs.mkdirSync(profile.dataDir, { recursive: true });
  if (profile.configDir) fs.mkdirSync(profile.configDir, { recursive: true });
  pinToOwnFolder(claude, profile);

  const args = profile.isDefault ? [] : [`--user-data-dir=${profile.dataDir}`];
  const child = spawn(claude.exe, [...args, ...extraArgs], {
    detached: true,
    stdio: 'ignore',
    env: cleanEnv(profile),
  });
  child.on('error', () => {});
  child.unref();
}

// --- Running state ------------------------------------------------------------

// Chromium keeps <userData>\lockfile open with no sharing while the app runs,
// so failing to open it is a cheap, exact "is this profile running?" check.
function isLocked(dir) {
  const lock = path.join(dir, 'lockfile');
  if (!fs.existsSync(lock)) return false;
  try {
    fs.closeSync(fs.openSync(lock, 'r+'));
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
  }
}

function isRunning(claude, profile) {
  return dataDirsOf(claude, profile).some(isLocked);
}

// Claude records the signed-in account in <userData>\config.json. Matched as
// text so the token cache next to it is never parsed into an object.
function isSignedIn(claude, profile) {
  return dataDirsOf(claude, profile).some((d) => {
    try {
      return /"lastKnownAccountUuid"\s*:\s*"[0-9a-f-]{36}"/i.test(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
    } catch {
      return false;
    }
  });
}

function userDataDirOf(cmdline) {
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/i.exec(cmdline || '');
  return m ? (m[1] || m[2]) : null;
}

// Main (browser) process of a profile. Matching on the exe path matters: the
// Claude Code CLI is also a "claude.exe", without --user-data-dir.
async function findMainPids(claude, profile) {
  const out = await powershell(
    "Get-CimInstance Win32_Process -Filter \"Name='Claude.exe'\" | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress"
  );
  if (!out.trim()) return [];
  const procs = [].concat(JSON.parse(out));
  return procs
    .filter((p) => p.ExecutablePath && samePath(p.ExecutablePath, claude.exe))
    .filter((p) => p.CommandLine && !/--type=/.test(p.CommandLine))
    .filter((p) => {
      const dir = userDataDirOf(p.CommandLine);
      return dir ? samePath(dir, profile.dataDir) : profile.isDefault;
    })
    .map((p) => p.ProcessId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Ask politely first (WM_CLOSE), then force: closing the window usually just
// sends Claude to the tray, which is not what "Stop" means.
async function stop(claude, profile) {
  if (!claude) return { stopped: false };
  const pids = await findMainPids(claude, profile);
  if (!pids.length) return { stopped: false };
  for (const pid of pids) await run('taskkill', ['/PID', String(pid), '/T']).catch(() => {});
  for (let i = 0; i < 8 && pids.some(isAlive); i++) await sleep(250);
  for (const pid of pids.filter(isAlive)) await run('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
  return { stopped: true };
}

// --- claude:// protocol -------------------------------------------------------

// Written with reg.exe rather than app.setAsDefaultProtocolClient: Electron's
// call can create the root key yet silently fail on shell\open\command.
async function setProtocolCommand(command) {
  await run('reg', ['add', PROTOCOL_KEY, '/ve', '/d', 'URL:Claude Protocol', '/f']);
  await run('reg', ['add', PROTOCOL_KEY, '/v', 'URL Protocol', '/d', '', '/f']);
  await run('reg', ['add', `${PROTOCOL_KEY}\\shell\\open\\command`, '/ve', '/d', command, '/f']);
}

async function readProtocolCommand() {
  try {
    const out = await run('reg', ['query', `${PROTOCOL_KEY}\\shell\\open\\command`, '/ve']);
    const m = /REG_SZ\s+(.*)$/m.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// The Store build registers claude: through its package manifest, and Windows
// prefers that over the classic key above. The only way past it is for the user
// to pick a handler in Settings > Default apps, which needs Bunshin to exist as
// a registered application offering claude: (ProgId + Capabilities).
const PROGID = 'Bunshin.claude';
const CAPS_KEY = 'HKCU\\Software\\Bunshin\\Capabilities';
const USER_CHOICE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\claude\\UserChoice';

async function registerAsLinkApp(command, exe) {
  const progKey = `HKCU\\Software\\Classes\\${PROGID}`;
  await run('reg', ['add', progKey, '/ve', '/d', 'URL:Claude (Bunshin)', '/f']);
  await run('reg', ['add', progKey, '/v', 'URL Protocol', '/d', '', '/f']);
  await run('reg', ['add', `${progKey}\\DefaultIcon`, '/ve', '/d', `"${exe}",0`, '/f']);
  await run('reg', ['add', `${progKey}\\shell\\open\\command`, '/ve', '/d', command, '/f']);
  await run('reg', ['add', CAPS_KEY, '/v', 'ApplicationName', '/d', 'Bunshin', '/f']);
  await run('reg', ['add', CAPS_KEY, '/v', 'ApplicationDescription', '/d', 'Sends Claude sign-ins to the right profile', '/f']);
  await run('reg', ['add', `${CAPS_KEY}\\URLAssociations`, '/v', 'claude', '/d', PROGID, '/f']);
  await run('reg', ['add', 'HKCU\\Software\\RegisteredApplications', '/v', 'Bunshin', '/d', 'Software\\Bunshin\\Capabilities', '/f']);
  await setProtocolCommand(command);
}

async function unregisterLinkApp() {
  await run('reg', ['delete', 'HKCU\\Software\\RegisteredApplications', '/v', 'Bunshin', '/f']).catch(() => {});
  await run('reg', ['delete', 'HKCU\\Software\\Bunshin', '/f']).catch(() => {});
  await run('reg', ['delete', `HKCU\\Software\\Classes\\${PROGID}`, '/f']).catch(() => {});
  // Windows may refuse this (UserChoice is protected); with the ProgId gone it
  // falls back to Claude anyway.
  await run('reg', ['delete', USER_CHOICE_KEY, '/f']).catch(() => {});
  await run('reg', ['delete', `${USER_CHOICE_KEY}Latest`, '/f']).catch(() => {});
}

// Recent Windows 11 builds keep the choice in UserChoiceLatest\ProgId; older
// ones in UserChoice. The newer key wins when both exist.
async function readUserChoice() {
  for (const [key, value] of [[`${USER_CHOICE_KEY}Latest\\ProgId`, 'ProgId'], [USER_CHOICE_KEY, 'ProgId']]) {
    try {
      const out = await run('reg', ['query', key, '/v', value]);
      const m = /ProgId\s+REG_SZ\s+(.*)$/m.exec(out);
      if (m) return m[1].trim();
    } catch { /* try the next location */ }
  }
  return null;
}

const isChosenLinkApp = async () => (await readUserChoice()) === PROGID;

// Hand claude:// back to Claude Desktop itself.
async function restoreProtocolToClaude(claude) {
  await unregisterLinkApp();
  if (claude) await setProtocolCommand(`"${claude.exe}" "%1"`);
}

module.exports = {
  APPDATA,
  DEFAULT_DATA_DIR,
  findClaudeExe,
  launch,
  isRunning,
  isSignedIn,
  liveDataDir,
  stop,
  registerAsLinkApp,
  isChosenLinkApp,
  readProtocolCommand,
  restoreProtocolToClaude,
};
