const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// history.js resolves ~/.claude at load time: point the home at a temp folder first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bunshin-history-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const history = require('../src/history');

const write = (file, text, ageMs = 0) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
};
const read = (file) => fs.readFileSync(file, 'utf8');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('merges a profile history into ~/.claude and links it', () => {
  const shared = path.join(home, '.claude', 'projects', 'P1');
  const cfg = path.join(home, '.claude-work');
  write(path.join(shared, 'a.jsonl'), 'old', 3600_000);
  write(path.join(shared, 'only-shared.jsonl'), 'shared');
  write(path.join(cfg, 'projects', 'P1', 'a.jsonl'), 'newer');
  write(path.join(cfg, 'projects', 'P2', 'b.jsonl'), 'b');

  assert.strictEqual(history.isShared(cfg), false);
  const backups = history.shareHistory(cfg);

  assert.strictEqual(history.isShared(cfg), true);
  assert.strictEqual(read(path.join(shared, 'a.jsonl')), 'newer', 'newest copy wins');
  assert.strictEqual(read(path.join(shared, 'only-shared.jsonl')), 'shared', 'nothing is dropped');
  assert.strictEqual(read(path.join(cfg, 'projects', 'P2', 'b.jsonl')), 'b', 'readable through the junction');
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(read(path.join(backups[0], 'P1', 'a.jsonl')), 'newer', 'original kept as backup');
});

test('keeps the shared copy when it is the newer one', () => {
  const cfg = path.join(home, '.claude-perso');
  write(path.join(home, '.claude', 'projects', 'P3', 'c.jsonl'), 'shared-newer');
  write(path.join(cfg, 'projects', 'P3', 'c.jsonl'), 'stale', 3600_000);
  history.shareHistory(cfg);
  assert.strictEqual(read(path.join(home, '.claude', 'projects', 'P3', 'c.jsonl')), 'shared-newer');
});

test('is idempotent', () => {
  const cfg = path.join(home, '.claude-work');
  assert.deepStrictEqual(history.shareHistory(cfg), []);
  assert.strictEqual(history.isShared(cfg), true);
});

test('leaves ~/.claude itself and profiles without a config dir alone', () => {
  assert.deepStrictEqual(history.shareHistory(path.join(home, '.claude')), []);
  assert.deepStrictEqual(history.shareHistory(null), []);
  assert.strictEqual(history.isShared(null), true);
});
