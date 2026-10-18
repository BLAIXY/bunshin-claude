// Profile list, persisted as JSON in Bunshin's own userData folder.
// A profile = one isolated Claude Desktop instance (its own data dir = its own
// login, settings, Claude Code sessions...).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { APPDATA } = require('./claude');

const COLORS = ['#d97757', '#6a9bcc', '#7fb069', '#c792ea', '#e6b450', '#f07178', '#4fd1c5', '#a0a0a0'];

class ProfileStore {
  constructor(file) {
    this.file = file;
    this.profiles = [];
    this.load();
  }

  load() {
    try {
      this.profiles = JSON.parse(fs.readFileSync(this.file, 'utf8')).profiles || [];
    } catch {
      this.profiles = this.defaults();
      this.save();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ profiles: this.profiles }, null, 2));
  }

  // First run: a Personal and a Work profile, each with its own Claude Code
  // config and the shared session history. If %APPDATA%\Claude-Personal or
  // Claude-Work already exist, they are simply reused.
  defaults() {
    return ['Personal', 'Work'].map((name, i) => ({
      id: crypto.randomUUID(),
      name,
      color: COLORS[i + 1],
      isDefault: false,
      dataDir: path.join(APPDATA, `Claude-${name}`),
      configDir: path.join(os.homedir(), `.claude-${name.toLowerCase()}`),
      shareHistory: true,
    }));
  }

  get(id) {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Profile not found.');
    return p;
  }

  slugFor(name) {
    const base = name
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Profile';
    let slug = base;
    for (let i = 2; fs.existsSync(path.join(APPDATA, `Claude-${slug}`)) ||
      this.profiles.some((p) => samePath(p.dataDir, path.join(APPDATA, `Claude-${slug}`))); i++) {
      slug = `${base}-${i}`;
    }
    return slug;
  }

  create({ name, color, isolateConfig, shareHistory = true }) {
    name = (name || '').trim();
    if (!name) throw new Error('A name is required.');
    const slug = this.slugFor(name);
    const profile = {
      id: crypto.randomUUID(),
      name,
      color: color || COLORS[this.profiles.length % COLORS.length],
      isDefault: false,
      dataDir: path.join(APPDATA, `Claude-${slug}`),
      configDir: isolateConfig ? path.join(os.homedir(), `.claude-${slug.toLowerCase()}`) : null,
      shareHistory,
    };
    this.profiles.push(profile);
    this.save();
    return profile;
  }

  update(id, { name, color, isolateConfig, shareHistory }) {
    const p = this.get(id);
    if (shareHistory !== undefined) p.shareHistory = shareHistory;
    if (name !== undefined) {
      if (!name.trim()) throw new Error('A name is required.');
      p.name = name.trim();
    }
    if (color) p.color = color;
    if (isolateConfig !== undefined && !p.isDefault) {
      if (!isolateConfig) p.configDir = null;
      else if (!p.configDir) {
        const slug = path.basename(p.dataDir).replace(/^Claude-/, '').toLowerCase();
        p.configDir = path.join(os.homedir(), `.claude-${slug}`);
      }
    }
    this.save();
    return p;
  }

  // Only forgets the profile; its data folder is left on disk.
  remove(id) {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.save();
  }

  move(id, delta) {
    const i = this.profiles.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.profiles.length) return;
    [this.profiles[i], this.profiles[j]] = [this.profiles[j], this.profiles[i]];
    this.save();
  }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

module.exports = { ProfileStore, COLORS };
