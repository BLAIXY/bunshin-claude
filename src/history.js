// Shared Claude Code session history across profiles.
//
// A profile with its own CLAUDE_CONFIG_DIR keeps its own login and settings,
// but its session folders (transcripts, rewind checkpoints, todos) become
// junctions to the ones in ~/.claude, so every profile sees and resumes the
// same sessions. Session files are keyed by session id, so two instances
// writing side by side never touch the same file.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHARED_DIRS = ['projects', 'file-history', 'todos'];
const SHARED_ROOT = path.join(os.homedir(), '.claude');

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function isJunctionTo(p, target) {
  try {
    return fs.lstatSync(p).isSymbolicLink() && samePath(fs.realpathSync(p), target);
  } catch {
    return false;
  }
}

// Copy src into dst; when both have a file, the most recently written wins
// (a transcript that kept going in one profile is the longer, newer one).
function mergeCopy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      mergeCopy(s, d);
    } else if (entry.isFile()) {
      const sStat = fs.statSync(s);
      let dStat = null;
      try { dStat = fs.statSync(d); } catch {}
      if (!dStat || sStat.mtimeMs > dStat.mtimeMs) {
        fs.copyFileSync(s, d);
        fs.utimesSync(d, sStat.atime, sStat.mtime);
      }
    }
  }
}

// Must run while the profile is closed: its session files must not be open.
// Returns the backup folders created (the profile's original folders, kept
// untouched next to the junction).
function shareHistory(configDir) {
  if (!configDir || samePath(configDir, SHARED_ROOT)) return [];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const backups = [];
  for (const name of SHARED_DIRS) {
    const shared = path.join(SHARED_ROOT, name);
    const own = path.join(configDir, name);
    fs.mkdirSync(shared, { recursive: true });
    if (isJunctionTo(own, shared)) continue;
    if (fs.existsSync(own)) {
      mergeCopy(own, shared);
      const backup = `${own}.before-bunshin-${stamp}`;
      fs.renameSync(own, backup);
      backups.push(backup);
    }
    fs.mkdirSync(configDir, { recursive: true });
    fs.symlinkSync(shared, own, 'junction');
  }
  return backups;
}

function isShared(configDir) {
  return !configDir || SHARED_DIRS.every((n) => isJunctionTo(path.join(configDir, n), path.join(SHARED_ROOT, n)));
}

module.exports = { shareHistory, isShared, SHARED_ROOT };
