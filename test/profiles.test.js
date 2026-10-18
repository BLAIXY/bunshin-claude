const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// claude.js / profiles.js read %APPDATA% and the home folder at load time.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-profiles-'));
process.env.APPDATA = path.join(root, 'Roaming');
process.env.USERPROFILE = root;
process.env.HOME = root;
fs.mkdirSync(path.join(process.env.APPDATA, 'Claude-Work'), { recursive: true });
fs.mkdirSync(path.join(root, '.claude-work'), { recursive: true });

const { ProfileStore } = require('../src/profiles');
const claude = require('../src/claude');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const newStore = () => new ProfileStore(path.join(root, `profiles-${Math.random()}.json`));

test('first run starts with a Personal and a Work profile', () => {
  const store = newStore();
  assert.deepStrictEqual(store.profiles.map((p) => p.name), ['Personal', 'Work']);
  const work = store.profiles[1];
  assert.strictEqual(work.isDefault, false);
  assert.strictEqual(work.dataDir, path.join(process.env.APPDATA, 'Claude-Work'));
  assert.strictEqual(work.configDir, path.join(root, '.claude-work'));
  assert.strictEqual(work.shareHistory, true);
});

test('new profiles get a unique, ASCII-safe folder', () => {
  const store = newStore();
  const a = store.create({ name: 'Équipe Client X', isolateConfig: true });
  assert.strictEqual(path.basename(a.dataDir), 'Claude-Equipe-Client-X');
  assert.strictEqual(a.configDir, path.join(root, '.claude-equipe-client-x'));
  assert.strictEqual(a.shareHistory, true);
  const b = store.create({ name: 'Work' });
  assert.strictEqual(path.basename(b.dataDir), 'Claude-Work-2', 'existing folder is not reused');
  assert.strictEqual(b.configDir, null);
});

test('profiles persist across reloads', () => {
  const file = path.join(root, 'persist.json');
  const store = new ProfileStore(file);
  const p = store.create({ name: 'Perso' });
  store.update(p.id, { name: 'Side project', shareHistory: false });
  const reloaded = new ProfileStore(file);
  const q = reloaded.get(p.id);
  assert.strictEqual(q.name, 'Side project');
  assert.strictEqual(q.shareHistory, false);
});

test('rejects an empty name', () => {
  assert.throws(() => newStore().create({ name: '   ' }), /required/);
});

test('signed-in state comes from config.json without needing Claude', () => {
  const dir = path.join(root, 'signed');
  fs.mkdirSync(dir, { recursive: true });
  const profile = { isDefault: false, dataDir: dir };
  assert.strictEqual(claude.isSignedIn(null, profile), false);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: '0b5e8a52-2a1c-4d1e-9a52-6f2f3c8d7e10' }));
  assert.strictEqual(claude.isSignedIn(null, profile), true);
});
