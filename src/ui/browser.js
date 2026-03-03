'use strict';

/**
 * Terminal UI File/Directory Browser
 * Keyboard controls:
 *   ↑/↓       – navigate
 *   →/Enter   – open directory / select file
 *   ←/Backspace – go up one directory
 *   /         – search/filter
 *   Escape    – cancel search or exit
 *   q         – quit
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');

const ICONS = {
  dir:      '📁',
  file:     '📄',
  dotfile:  '🔒',
  selected: '✔ ',
  cursor:   '▶ ',
  blank:    '  ',
  up:       '↩  ..',
};

const PAGE_SIZE = process.stdout.rows ? process.stdout.rows - 10 : 15;

class FileBrowser {
  constructor(options = {}) {
    this.root       = options.root || process.cwd();
    this.cwd        = this.root;
    this.entries    = [];
    this.cursor     = 0;
    this.scroll     = 0;
    this.search     = '';
    this.searching  = false;
    this.gitFiles   = options.gitFiles || null; // array of relative paths tracked by git
    this.onSelect   = options.onSelect || (() => {});
    this.onCancel   = options.onCancel || (() => {});
    this.title      = options.title || 'Select File to Scrub from Git History';
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
    try {
      names = fs.readdirSync(this.cwd);
    } catch {
      names = [];
    }

    const dirs  = [];
    const files = [];

    for (const name of names) {
      // skip .git internals
      if (name === '.git') continue;

      const full = path.join(this.cwd, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }

      const entry = { name, full, isDir: stat.isDirectory() };

      if (stat.isDirectory()) {
        dirs.push(entry);
      } else {
        // Optionally only show git-tracked files
        if (this.gitFiles) {
          const rel = path.relative(this.root, full).replace(/\\/g, '/');
          entry.tracked = this.gitFiles.includes(rel);
        } else {
          entry.tracked = true;
        }
        files.push(entry);
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    this.entries = [{ name: '..', full: path.dirname(this.cwd), isDir: true, isUp: true }, ...dirs, ...files];
    this.cursor  = 0;
    this.scroll  = 0;
  }

  _filtered() {
    if (!this.search) return this.entries;
    const q = this.search.toLowerCase();
    return this.entries.filter((e) => e.isUp || e.name.toLowerCase().includes(q));
  }

  /* ─── rendering ──────────────────────────────────────────── */

  _render() {
    const { columns: W = 80 } = process.stdout;
    const list = this._filtered();

    // adjust scroll window
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + PAGE_SIZE) this.scroll = this.cursor - PAGE_SIZE + 1;

    const lines = [];

    // ── header ──
    lines.push('');
    lines.push(chalk.bold.cyan(' ┌' + '─'.repeat(W - 3) + '┐'));
    lines.push(chalk.bold.cyan(' │') + chalk.bold.white(` ${this.title}`.padEnd(W - 3)) + chalk.bold.cyan('│'));
    lines.push(chalk.bold.cyan(' │') + chalk.gray(` 📂 ${this.cwd}`.slice(0, W - 4).padEnd(W - 3)) + chalk.bold.cyan('│'));
    lines.push(chalk.bold.cyan(' └' + '─'.repeat(W - 3) + '┘'));
    lines.push('');

    // ── entries ──
    const visible = list.slice(this.scroll, this.scroll + PAGE_SIZE);
    for (let i = 0; i < visible.length; i++) {
      const e   = visible[i];
      const idx = i + this.scroll;
      const active = idx === this.cursor;

      let icon, label, color;

      if (e.isUp) {
        icon  = '  ';
        label = ICONS.up;
        color = active ? chalk.bgBlue.bold : chalk.gray;
      } else if (e.isDir) {
        icon  = ICONS.dir;
        label = e.name + '/';
        color = active ? chalk.bgBlue.bold : chalk.yellow;
      } else {
        icon  = e.tracked ? ICONS.file : chalk.gray(ICONS.dotfile);
        label = e.name;
        color = active
          ? chalk.bgRed.bold
          : e.tracked
            ? chalk.white
            : chalk.gray;
      }

      const prefix = active ? chalk.bgBlue.white(' ▶ ') : '   ';
      lines.push(prefix + icon + ' ' + color(label));
    }

    // scrollbar hint
    if (list.length > PAGE_SIZE) {
      lines.push(chalk.gray(` ░ ${this.scroll + 1}-${Math.min(this.scroll + PAGE_SIZE, list.length)} / ${list.length} entries`));
    }

    // ── search bar ──
    lines.push('');
    if (this.searching) {
      lines.push(chalk.bgYellow.black(` 🔍 Search: ${this.search}_`));
    } else {
      lines.push(chalk.gray(
        ' [↑↓] navigate  [→/Enter] open/select  [←/Bksp] up  [/] search  [q] quit'
      ));
    }
    lines.push('');

    // clear and print
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  }

  /* ─── keyboard handling ──────────────────────────────────── */

  _setupRaw() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    process.stdin.on('keypress', (ch, key) => {
      if (!key) return;

      if (this.searching) {
        this._handleSearch(ch, key);
      } else {
        this._handleNav(ch, key);
      }
    });
  }

  _handleSearch(ch, key) {
    if (key.name === 'escape') {
      this.search    = '';
      this.searching = false;
      this.cursor    = 0;
    } else if (key.name === 'return') {
      this.searching = false;
      this.cursor    = 0;
    } else if (key.name === 'backspace') {
      this.search = this.search.slice(0, -1);
    } else if (ch && !key.ctrl) {
      this.search += ch;
      this.cursor  = 0;
    }
    this._render();
  }

  _handleNav(ch, key) {
    const list = this._filtered();

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

    } else if (key.name === 'right' || key.name === 'return') {
      const entry = list[this.cursor];
      if (!entry) return this._render();

      if (entry.isDir) {
        this.cwd = entry.full;
        this._loadEntries();
      } else {
        // Selected a file — confirm it's git-tracked
        if (this.gitFiles && !entry.tracked) {
          this._flash(chalk.red(' ✘  This file is not tracked by git. Choose a tracked file.'));
          return;
        }
        this._cleanup();
        const rel = path.relative(this.root, entry.full).replace(/\\/g, '/');
        this.onSelect(rel, entry.full);
        return;
      }

    } else if (key.name === 'left' || key.name === 'backspace') {
      if (this.cwd !== this.root) {
        this.cwd = path.dirname(this.cwd);
        this._loadEntries();
      }

    } else if (ch === '/') {
      this.searching = true;
      this.search    = '';

    } else if (ch === 'q' || (key.ctrl && key.name === 'c')) {
      this._cleanup();
      this.onCancel();
      return;
    }

    this._render();
  }

  _flash(msg) {
    process.stdout.write('\x1b[2J\x1b[H');
    this._render();
    process.stdout.write('\n' + msg + '\n');
  }

  _cleanup() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

module.exports = FileBrowser;
