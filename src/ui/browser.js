'use strict';

/**
 * Terminal UI File/Directory Browser
 * Keyboard controls:
 *   ↑/↓ or j/k  – navigate
 *   →/Enter      – open directory  |  confirm selection
 *   ←/Backspace  – go up one directory
 *   Space        – toggle file selection (multi-select)
 *   /            – search/filter
 *   Escape       – clear search
 *   a            – select all tracked files in current view
 *   u            – deselect all
 *   q / Ctrl+C   – quit
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');

const PAGE_SIZE = Math.max(3, (process.stdout.rows || 25) - 12);

class FileBrowser {
  constructor(options = {}) {
    this.root      = options.root || process.cwd();
    this.cwd       = this.root;
    this.entries   = [];
    this.cursor    = 0;
    this.scroll    = 0;
    this.search    = '';
    this.searching = false;
    this.selected  = new Set();          // Set of repo-relative paths
    this.gitFiles  = options.gitFiles || null;
    this.onSelect  = options.onSelect || (() => {});
    this.onCancel  = options.onCancel || (() => {});
    this.title     = options.title || 'Select File(s) to Vanish from Git History';
  }

  /* ─── public ─────────────────────────────────────────────── */

  start() {
    this._loadEntries();
    this._setupRaw();
    this._render();
  }

  /* ─── directory loading ──────────────────────────────────── */

  _loadEntries() {
    let names;
    try { names = fs.readdirSync(this.cwd); }
    catch { names = []; }

    const dirs = [], files = [];

    for (const name of names) {
      if (name === '.git') continue;
      const full = path.join(this.cwd, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }

      const entry = { name, full, isDir: stat.isDirectory() };
      if (stat.isDirectory()) {
        dirs.push(entry);
      } else {
        entry.rel = path.relative(this.root, full).replace(/\\/g, '/');
        if (this.gitFiles) {
          entry.tracked = this.gitFiles.includes(entry.rel);
        } else {
          entry.tracked = true;
        }
        files.push(entry);
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    this.entries = [
      { name: '..', full: path.dirname(this.cwd), isDir: true, isUp: true },
      ...dirs,
      ...files,
    ];
    this.cursor = 0;
    this.scroll = 0;
  }

  _filtered() {
    if (!this.search) return this.entries;
    const q = this.search.toLowerCase();
    return this.entries.filter((e) => e.isUp || e.name.toLowerCase().includes(q));
  }

  /* ─── rendering ──────────────────────────────────────────── */

  _render() {
    const W = process.stdout.columns || 80;
    const list = this._filtered();

    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + PAGE_SIZE) this.scroll = this.cursor - PAGE_SIZE + 1;

    const lines = [];

    // ── header ──
    lines.push('');
    lines.push(chalk.bold.cyan(' ┌' + '─'.repeat(W - 3) + '┐'));
    lines.push(chalk.bold.cyan(' │') + chalk.bold.white(` ${this.title}`.padEnd(W - 3)) + chalk.bold.cyan('│'));
    lines.push(chalk.bold.cyan(' │') + chalk.gray(` 📂 ${this.cwd}`.slice(0, W - 4).padEnd(W - 3)) + chalk.bold.cyan('│'));

    // selected badge row
    const badge = this.selected.size > 0
      ? chalk.bgGreen.black(` ✔ ${this.selected.size} file${this.selected.size > 1 ? 's' : ''} selected `)
      : chalk.gray(' No files selected yet ');
    lines.push(chalk.bold.cyan(' │') + (' ' + badge).padEnd(W - 3) + chalk.bold.cyan('│'));
    lines.push(chalk.bold.cyan(' └' + '─'.repeat(W - 3) + '┘'));
    lines.push('');

    // ── entries ──
    const visible = list.slice(this.scroll, this.scroll + PAGE_SIZE);
    for (let i = 0; i < visible.length; i++) {
      const e        = visible[i];
      const idx      = i + this.scroll;
      const active   = idx === this.cursor;
      const isChosen = !e.isDir && !e.isUp && this.selected.has(e.rel);

      let icon, label, color;

      if (e.isUp) {
        icon  = '  ';
        label = '↩  ..';
        color = active ? chalk.bgBlue.bold : chalk.gray;
      } else if (e.isDir) {
        icon  = '📁';
        label = e.name + '/';
        color = active ? chalk.bgBlue.bold : chalk.yellow;
      } else {
        icon  = e.tracked ? '📄' : '🔒';
        label = e.name;
        if (isChosen)      color = active ? chalk.bgGreen.black.bold : chalk.green.bold;
        else if (active)   color = e.tracked ? chalk.bgRed.bold     : chalk.bgGray.bold;
        else               color = e.tracked ? chalk.white          : chalk.gray;
      }

      let prefix;
      if (active && isChosen) prefix = chalk.bgGreen.black(' ▶✔');
      else if (active)        prefix = chalk.bgBlue.white(' ▶ ');
      else if (isChosen)      prefix = chalk.green(' ✔ ');
      else                    prefix = '   ';

      lines.push(prefix + icon + ' ' + color(label));
    }

    if (list.length > PAGE_SIZE) {
      lines.push(chalk.gray(` ░ ${this.scroll + 1}–${Math.min(this.scroll + PAGE_SIZE, list.length)} / ${list.length} entries`));
    }

    // ── footer hint ──
    lines.push('');
    if (this.searching) {
      lines.push(chalk.bgYellow.black(` 🔍 Filter: ${this.search}_  (Enter to apply, Esc to clear)`));
    } else if (this.selected.size > 0) {
      lines.push(
        chalk.bgGreen.black(` [Enter] Confirm ${this.selected.size} selected file(s) `) + '  ' +
        chalk.gray('[Space] toggle  [u] clear all  [q] quit')
      );
    } else {
      lines.push(chalk.gray(
        ' [↑↓/jk] move  [Space] select  [Enter/→] quick-select  [←] up  [/] filter  [a] all  [q] quit'
      ));
    }
    lines.push('');

    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  }

  /* ─── keyboard handling ──────────────────────────────────── */

  _setupRaw() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('keypress', (ch, key) => {
      if (!key) return;
      if (this.searching) this._handleSearch(ch, key);
      else                this._handleNav(ch, key);
    });
  }

  _handleSearch(ch, key) {
    if (key.name === 'escape') {
      this.search = ''; this.searching = false; this.cursor = 0;
    } else if (key.name === 'return') {
      this.searching = false; this.cursor = 0;
    } else if (key.name === 'backspace') {
      this.search = this.search.slice(0, -1);
    } else if (ch && !key.ctrl) {
      this.search += ch; this.cursor = 0;
    }
    this._render();
  }

  _handleNav(ch, key) {
    const list  = this._filtered();
    const entry = list[this.cursor];

    // ── movement ──────────────────────────────────────────────
    if (key.name === 'up' || key.name === 'k') {
      this.cursor = Math.max(0, this.cursor - 1);

    } else if (key.name === 'down' || key.name === 'j') {
      this.cursor = Math.min(list.length - 1, this.cursor + 1);

    } else if (key.name === 'pageup') {
      this.cursor = Math.max(0, this.cursor - PAGE_SIZE);

    } else if (key.name === 'pagedown') {
      this.cursor = Math.min(list.length - 1, this.cursor + PAGE_SIZE);

    } else if (key.name === 'home') {
      this.cursor = 0;

    } else if (key.name === 'end') {
      this.cursor = list.length - 1;

    // ── go up a directory ──────────────────────────────────────
    } else if (key.name === 'left' || key.name === 'backspace') {
      if (this.cwd !== this.root) {
        this.cwd = path.dirname(this.cwd);
        this._loadEntries();
      }

    // ── Space = toggle file selection ──────────────────────────
    } else if (ch === ' ') {
      if (entry && !entry.isDir && !entry.isUp) {
        if (this.gitFiles && !entry.tracked) {
          this._flash(chalk.red(' ✘  Not git-tracked. Only tracked files can be vanished.'));
          return;
        }
        if (this.selected.has(entry.rel)) this.selected.delete(entry.rel);
        else                              this.selected.add(entry.rel);
        // auto-advance so user can quickly Space through a list
        this.cursor = Math.min(list.length - 1, this.cursor + 1);
      }

    // ── Enter / → = open dir OR confirm ───────────────────────
    } else if (key.name === 'right' || key.name === 'return') {
      if (!entry) { if (this.selected.size > 0) return this._confirm(); return this._render(); }

      if (entry.isDir) {
        // open directory
        this.cwd = entry.full;
        this._loadEntries();
      } else {
        // file
        if (this.gitFiles && !entry.tracked) {
          this._flash(chalk.red(' ✘  Not git-tracked. Cannot vanish this file.'));
          return;
        }
        // Add current file to selection (if not already) then confirm everything
        this.selected.add(entry.rel);
        this._confirm();
        return;
      }

    // ── a = select ALL tracked files in current view ───────────
    } else if (ch === 'a') {
      for (const e of list) {
        if (!e.isDir && !e.isUp && e.tracked) this.selected.add(e.rel);
      }

    // ── u = deselect all ──────────────────────────────────────
    } else if (ch === 'u') {
      this.selected.clear();

    // ── / = search ────────────────────────────────────────────
    } else if (ch === '/') {
      this.searching = true;
      this.search    = '';

    // ── q / Ctrl+C = quit ─────────────────────────────────────
    } else if (ch === 'q' || (key.ctrl && key.name === 'c')) {
      this._cleanup();
      this.onCancel();
      return;
    }

    this._render();
  }

  /* ─── confirm and exit ───────────────────────────────────── */

  _confirm() {
    if (this.selected.size === 0) return this._render();
    const files = Array.from(this.selected);
    this._cleanup();
    this.onSelect(files);
  }

  _flash(msg) {
    this._render();
    process.stdout.write('\n' + msg + '\n');
    setTimeout(() => this._render(), 1400);
  }

  _cleanup() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

module.exports = FileBrowser;
